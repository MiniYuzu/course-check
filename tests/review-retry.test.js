const test = require('node:test');
const assert = require('node:assert/strict');
const { client } = require('./helpers/client');
const { createCloud } = require('./helpers/cloud');
const { today, addDays } = require('../miniprogram/utils/records');

const ok = response => { assert.equal(response.success, true, response.message); return response.data; };
const slots = [{ weekday: 0, start: '10:00', end: '11:00' }];
function connect(remote) {
  const c = client({ cloud: async ({ name, data }) => ({ result: await remote.call(name, data) }) });
  const storage = c.load('miniprogram/utils/storage.js'); storage.activate('env', 'owner');
  return { ...c, storage, db: c.load('miniprogram/utils/db.js').db, queue: c.load('miniprogram/utils/sync-queue.js').SyncQueue };
}
function loseReply(c, remote, action) {
  let lost = false;
  c.wx.cloud.callFunction = async ({ name, data }) => {
    const result = await remote.call(name, data);
    if (data.action === action && !lost && result.success) { lost = true; throw new Error('reply lost'); }
    return { result };
  };
}

test('creation replay uses immutable course identity after another device replaces its first future schedule', async () => {
  const day = today(), remote = createCloud({}, { now: `${day}T04:00:00Z` }), c = connect(remote);
  const course = await c.db.addCourse({ name: '验收课', type: 'swim', scheduleChange: { requestedOn: day, effectiveFrom: addDays(day, 14), slots } });
  await c.db.setAttendance(course._id, { date: day, status: 'attended' });
  const operationId = c.storage.read().queue[0]._id;
  loseReply(c, remote, 'add');
  assert.equal((await c.queue.sync()).success, false);
  const remoteId = remote.rows('courses')[0]._id;
  ok(await remote.call('course', { action: 'update', courseId: remoteId, operationId: 'other-device', updates: { scheduleChange: { requestedOn: day, effectiveFrom: addDays(day, 7), slots, expectedVersion: operationId } } }));
  assert.equal(remote.rows('courses')[0].scheduleVersions.some(version => version.operationId === operationId), false);
  await c.db.refresh();
  const retry = await c.queue.sync();
  assert.equal(retry.success, true, retry.message);
  assert.equal(c.storage.read().queue.length, 0);
  assert.equal(remote.rows('courses').length, 1);
  assert.equal(remote.rows('checkins').length, 1);
  assert.equal(c.storage.read().aliases[course._id], remoteId);
  assert.equal(c.db.snapshot().courses[0].scheduleVersions[0].operationId, 'other-device');
});

for (const replaceStop of [false, true]) {
  test(`lost archive reply cannot override later restore/replan (stop version replaced: ${replaceStop})`, async () => {
    const day = today(), remote = createCloud({ courses: [{ _id: 'c', _openid: 'owner', name: '验收课', scheduleVersions: [{ effectiveFrom: '2026-01-01', operationId: 'first', slots }] }] }, { now: `${day}T04:00:00Z` });
    const c = connect(remote); await c.db.refresh(); await c.db.archiveCourse('c');
    const archiveId = c.storage.read().queue[0]._id;
    loseReply(c, remote, 'archive'); assert.equal((await c.queue.sync()).success, false);
    ok(await remote.call('course', { action: 'restore', courseId: 'c', operationId: 'restore-new' }));
    ok(await remote.call('course', { action: 'update', courseId: 'c', operationId: 'replan', updates: { scheduleChange: { requestedOn: day, effectiveFrom: addDays(day, replaceStop ? 1 : 2), slots, expectedVersion: archiveId } } }));
    const before = remote.rows('courses');
    await c.db.refresh();
    const retry = await c.queue.sync();
    assert.equal(retry.success, true, retry.message);
    assert.deepEqual(remote.rows('courses'), before);
    assert.equal(c.storage.read().queue.length, 0);
    assert.equal(c.db.snapshot().courses[0].isDeleted, false);
    assert.equal(c.db.snapshot().courses[0].scheduleVersions.at(-1).operationId, 'replan');
  });
}

test('lost restore reply cannot undo a newer archive, including no-op restore receipts', async () => {
  for (const initiallyArchived of [false, true]) {
    const remote = createCloud({ courses: [{ _id: 'c', _openid: 'owner', name: '验收课', isDeleted: initiallyArchived }] });
    const c = connect(remote); await c.db.refresh(); await c.db.restoreCourse('c');
    loseReply(c, remote, 'restore'); assert.equal((await c.queue.sync()).success, false);
    ok(await remote.call('course', { action: 'archive', courseId: 'c', operationId: 'archive-new' }));
    const before = remote.rows('courses');
    const retry = await c.queue.sync(); assert.equal(retry.success, true, retry.message);
    assert.deepEqual(remote.rows('courses'), before);
    assert.equal(c.db.snapshot().courses[0].isDeleted, true);
  }
});

function pageInstance(c, path) {
  c.load(path); const page = { ...c.definition(), data: JSON.parse(JSON.stringify(c.definition().data)) };
  page.setData = data => Object.assign(page.data, data);
  return page;
}
for (const action of ['archive', 'restore-detail', 'restore-profile', 'backfill', 'undo']) {
  for (const interruption of ['account', 'unload']) {
    test(`${action} confirmation after ${interruption} does not write or render the old page`, async () => {
      const c = connect(createCloud());
      const course = { _id: 'c', name: '验收课', isDeleted: action.startsWith('restore') };
      c.storage.update(state => { state.courses = [course]; state.checkins = action === 'undo' ? [{ _id: 'r', courseId: 'c', date: '2026-01-01' }] : []; });
      const profile = action === 'restore-profile';
      const page = pageInstance(c, `miniprogram/pages/${profile ? 'profile/profile' : 'course-detail/course-detail'}.js`);
      page.onLoad({ id: 'c' }); page.setData({ ready: true, selectedDate: '2026-01-01' }); page.render();
      let confirm; c.wx.showModal = options => { confirm = () => options.success({ confirm: true }); };
      const pending = profile ? page.onRestore({ currentTarget: { dataset: { id: 'c' } } }) : action === 'backfill' ? page.onCheckin() : action === 'undo' ? page.onCancelCheckin({ currentTarget: { dataset: { date: '2026-01-01' } } }) : page.onArchive();
      assert.equal(typeof confirm, 'function');
      if (interruption === 'unload') page.onUnload();
      else { c.storage.activate('other-env', 'owner'); c.storage.update(state => { state.courses = [course]; state.checkins = [{ _id: 'r', courseId: 'c', date: '2026-01-01' }]; }); }
      let renders = 0; const render = page.render; page.render = () => { renders++; return render.call(page); };
      confirm(); await pending;
      assert.equal(c.storage.read().queue.length, 0);
      assert.equal(renders, 0);
      if (interruption !== 'unload') page.onUnload();
    });
  }
}
