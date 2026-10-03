const test = require('node:test');
const assert = require('node:assert/strict');
const { client } = require('./helpers/client');
const { createCloud, pauseOnce } = require('./helpers/cloud');
const { buildExport } = require('../miniprogram/utils/export');
const { summarize } = require('../miniprogram/utils/records');

test('full journey: offline create/checkin -> restart -> sync -> backfill -> cancel -> archive/restore -> export', async () => {
  const cloud = createCloud({}, { openid: 'parent-a' });
  const store = new Map();
  let online = false;
  const transport = async ({ name, data }) => {
    if (!online) throw new Error('network offline');
    return { result: await cloud.call(name, data) };
  };
  function launch() {
    const c = client({ store, cloud: transport });
    const storage = c.load('miniprogram/utils/storage.js');
    storage.activate('test-env', 'parent-a');
    return { c, storage, db: c.load('miniprogram/utils/db.js').db, sync: c.load('miniprogram/utils/sync-queue.js').SyncQueue };
  }
  let app = launch();
  const local = await app.db.addCourse({ name: '周末游泳', type: 'swim', initialLessons: 10, totalLessons: 30 });
  await app.db.addCheckin(local._id, { date: '2026-01-01', notes: '第一次使用' });
  assert.equal((await app.sync.sync()).success, false);
  assert.equal(app.db.snapshot().totalLessons, 11);
  app = launch();
  assert.equal(app.db.snapshot().totalLessons, 11);
  online = true;
  assert.equal((await app.sync.sync()).success, true);
  await app.db.refresh();
  const course = (await app.db.getCourses())[0];
  assert.notEqual(course._id, local._id);
  assert.equal(cloud.rows('courses').length, 1);
  assert.equal(cloud.rows('checkins').length, 1);
  await app.db.addCheckin(course._id, { date: '2026-01-02' });
  await app.sync.sync();
  await assert.rejects(app.db.addCheckin(course._id, { date: '2026-01-02' }), /已记录/);
  await app.db.cancelCheckin(course._id, '2026-01-02');
  await app.sync.sync();
  await app.db.archiveCourse(course._id);
  await app.sync.sync(); await app.db.refresh();
  assert.equal((await app.db.getCourses()).length, 0);
  assert.equal((await app.db.getCheckins(course._id)).length, 1);
  assert.equal(app.db.snapshot().totalLessons, 11);
  await app.db.restoreCourse(course._id);
  await app.sync.sync(); await app.db.refresh();
  assert.equal((await app.db.getCourses())[0].remainingCount, 19);
  const source = app.storage.read();
  const snapshot = app.db.snapshot();
  const month = summarize(snapshot.courses, snapshot.checkins, '2026-01', '2026-10-02');
  assert.equal(month.monthLessons, 1);
  const output = JSON.parse(buildExport(snapshot, source.queue, source).json);
  assert.equal(output.sourceSnapshot.checkins[0].notes, '第一次使用');
  assert.equal(output.pendingOperations.length, 0);
  assert.equal((await cloud.call('stats', { action: 'overview' })).data.totalCheckins, 11);
});

test('actual cloud idempotency recovers when a course add commits but its response is lost', async () => {
  const cloud = createCloud({}, { openid: 'parent-a' });
  let drop = true;
  const c = client({ cloud: async ({ name, data }) => {
    const result = await cloud.call(name, data);
    if (name === 'course' && data.action === 'add' && drop) { drop = false; throw new Error('lost response'); }
    return { result };
  } });
  c.load('miniprogram/utils/storage.js').activate('test-env', 'parent-a');
  const { db } = c.load('miniprogram/utils/db.js');
  const { SyncQueue } = c.load('miniprogram/utils/sync-queue.js');
  const local = await db.addCourse({ name: '钢琴', type: 'piano', initialLessons: 5 });
  await db.addCheckin(local._id, { date: '2026-01-01' });
  assert.equal((await SyncQueue.sync()).success, false);
  await db.refresh();
  assert.equal(db.snapshot().courses.length, 1);
  assert.equal(db.snapshot().totalLessons, 6);
  await SyncQueue.sync(); await db.refresh();
  assert.equal(cloud.rows('courses').length, 1);
  assert.equal(db.snapshot().totalLessons, 6);
  assert.equal((await SyncQueue.getQueue()).length, 0);
});

test('refresh after a cloud identity switch preserves the original account snapshot', async () => {
  const options = { openid: 'parent-a' };
  const cloud = createCloud({ courses: [
    { _id: 'a', _openid: 'parent-a', name: 'A-private' },
    { _id: 'b', _openid: 'parent-b', name: 'B-private' }
  ] }, options);
  const c = client({ cloud: async ({ name, data }) => ({ result: await cloud.call(name, data) }) });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('test-env', 'parent-a');
  const originalKey = storage.getSession().key;
  const { db } = c.load('miniprogram/utils/db.js');
  await db.refresh();
  options.openid = 'parent-b';
  await assert.rejects(db.refresh(), /身份|账号|账户/);
  assert.equal(storage.getSession(), null);
  assert.equal(storage.read(originalKey).courses[0].name, 'A-private');
});

test('identity switching between login and mutation cannot upload an old account course', async () => {
  const options = { openid: 'parent-a' };
  const cloud = createCloud({}, options);
  const c = client({ cloud: async ({ name, data }) => {
    const result = await cloud.call(name, data);
    if (name === 'login') options.openid = 'parent-b';
    return { result };
  } });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('test-env', 'parent-a');
  const key = storage.getSession().key;
  const { db } = c.load('miniprogram/utils/db.js');
  await db.addCourse({ name: 'A-private-course', type: 'other' });
  const { SyncQueue } = c.load('miniprogram/utils/sync-queue.js');
  assert.equal((await SyncQueue.sync()).success, false);
  assert.equal(cloud.rows('courses').length, 0);
  assert.equal(storage.read(key).queue.length, 1);
  assert.equal(storage.getSession(), null);
});

test('legacy impossible-date cancellation corrects both local and cloud lifetime balances', async () => {
  const cloud = createCloud({
    courses: [{ _id: 'course', _openid: 'parent-a', name: '钢琴', initialLessons: 5 }],
    checkins: [1, 2].map(id => ({ _id: `bad-${id}`, _openid: 'parent-a', courseId: 'course', date: '2026-02-31' }))
  }, { openid: 'parent-a' });
  const c = client({ cloud: async ({ name, data }) => ({ result: await cloud.call(name, data) }) });
  c.load('miniprogram/utils/storage.js').activate('test-env', 'parent-a');
  const { db } = c.load('miniprogram/utils/db.js');
  const { SyncQueue } = c.load('miniprogram/utils/sync-queue.js');
  await db.refresh();
  assert.equal(db.snapshot().totalLessons, 6);
  await db.cancelCheckin('course', '2026-02-31');
  assert.equal(db.snapshot().totalLessons, 5);
  assert.equal((await SyncQueue.sync()).success, true);
  await db.refresh();
  assert.equal(db.snapshot().totalLessons, 5);
  assert.equal(cloud.rows('checkins').length, 0);
});

for (const correctBeforeRestore of [false, true]) {
  test(`explicit restore unblocks an offline lesson after remote archive (later correction: ${correctBeforeRestore})`, async () => {
    const cloud = createCloud({ courses: [{ _id: 'course', _openid: 'parent-a', name: '钢琴' }] }, { openid: 'parent-a' });
    const c = client({ cloud: async ({ name, data }) => ({ result: await cloud.call(name, data) }) });
    const storage = c.load('miniprogram/utils/storage.js');
    storage.activate('test-env', 'parent-a');
    const { db } = c.load('miniprogram/utils/db.js');
    const { SyncQueue } = c.load('miniprogram/utils/sync-queue.js');
    await db.refresh();
    await db.addCheckin('course', { date: '2026-01-01' });
    await cloud.call('course', { action: 'archive', courseId: 'course' });
    assert.equal((await SyncQueue.sync()).success, false);
    await db.refresh();
    assert.equal(storage.read().queue.length, 1);
    assert.equal(storage.read().courses[0].isDeleted, true);
    if (correctBeforeRestore) {
      await db.cancelCheckin('course', '2026-01-01');
      await db.archiveCourse('course');
    }
    await db.restoreCourse('course');
    assert.equal((await SyncQueue.sync()).success, true);
    assert.equal(cloud.rows('courses')[0].isDeleted, false);
    assert.equal(cloud.rows('checkins').length, correctBeforeRestore ? 0 : 1);
    assert.equal(storage.read().queue.length, 0);
  });
}

test('explicit restore also unblocks a lesson whose archived error is still in flight', async () => {
  const cloud = createCloud({ courses: [{ _id: 'course', _openid: 'parent-a', name: '钢琴' }] }, { openid: 'parent-a' });
  const pause = pauseOnce();
  const c = client({ cloud: async ({ name, data }) => {
    const result = await cloud.call(name, data);
    if (name === 'checkin' && data.action === 'checkin') await pause.hold();
    return { result };
  } });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('test-env', 'parent-a');
  const { db } = c.load('miniprogram/utils/db.js');
  const { SyncQueue } = c.load('miniprogram/utils/sync-queue.js');
  await db.refresh();
  await db.addCheckin('course', { date: '2026-01-01' });
  await cloud.call('course', { action: 'archive', courseId: 'course' });
  const syncing = SyncQueue.sync();
  await pause.reached;
  await db.refresh();
  await db.restoreCourse('course');
  pause.resume();
  assert.equal((await syncing).success, false);
  assert.equal((await SyncQueue.sync()).success, true);
  assert.equal(cloud.rows('courses')[0].isDeleted, false);
  assert.equal(cloud.rows('checkins').length, 1);
  assert.equal(storage.read().queue.length, 0);
});

test('offline lesson notes survive local course aliases, restart, and lost create/edit responses', async () => {
  const cloud = createCloud({}, { openid: 'parent-a' });
  const store = new Map();
  const dropResponses = new Set(['checkin', 'updateNotes']);
  const transport = async ({ name, data }) => {
    const result = await cloud.call(name, data);
    if (name === 'checkin' && dropResponses.has(data.action)) {
      dropResponses.delete(data.action);
      throw new Error('lost response');
    }
    return { result };
  };
  function launch() {
    const c = client({ store, cloud: transport });
    const storage = c.load('miniprogram/utils/storage.js');
    storage.activate('test-env', 'parent-a');
    return { storage, db: c.load('miniprogram/utils/db.js').db, queue: c.load('miniprogram/utils/sync-queue.js').SyncQueue };
  }
  let app = launch();
  const local = await app.db.addCourse({ name: '周末游泳', type: 'swim', initialLessons: 5, totalLessons: 20 });
  await app.db.addCheckin(local._id, { date: '2026-01-01', notes: '初次记录' });
  await app.db.updateCheckinNotes(local._id, '2026-01-01', '  换气\n  练习  ');
  app = launch();
  assert.equal((await app.db.getCheckins(local._id))[0].notes, '换气 练习');
  assert.equal(app.db.snapshot().totalLessons, 6);
  assert.equal((await app.queue.sync()).success, false);
  await app.db.refresh();
  assert.equal((await app.db.getCheckins(local._id))[0].notes, '换气 练习');
  assert.equal((await app.queue.sync()).success, false);
  assert.equal(cloud.rows('checkins')[0].notes, '换气 练习');
  app = launch();
  assert.equal((await app.queue.sync()).success, true);
  await app.db.refresh();
  assert.equal((await app.db.getCheckins(local._id))[0].notes, '换气 练习');
  assert.equal(app.db.snapshot().totalLessons, 6);
  assert.equal((await app.db.getCourse(local._id)).remainingCount, 14);
  assert.equal(cloud.rows('checkins').length, 1);
  assert.equal(app.storage.read().queue.length, 0);
  const stored = cloud.rows('checkins')[0];
  assert.notEqual(stored.courseId, local._id);
  assert.equal(app.storage.read().aliases[local._id], stored.courseId);
});

test('note edits sync across all legacy duplicates and cancellation/re-add never reuses old notes', async () => {
  const cloud = createCloud({
    courses: [{ _id: 'course', _openid: 'parent-a', name: '钢琴', initialLessons: 5 }],
    checkins: [1, 2].map(id => ({ _id: `old-${id}`, _openid: 'parent-a', courseId: 'course', date: '2026-01-01', notes: '旧备注' }))
  }, { openid: 'parent-a' });
  const c = client({ cloud: async ({ name, data }) => ({ result: await cloud.call(name, data) }) });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('test-env', 'parent-a');
  const { db } = c.load('miniprogram/utils/db.js');
  const { SyncQueue } = c.load('miniprogram/utils/sync-queue.js');
  await db.refresh();
  await db.updateCheckinNotes('course', '2026-01-01', '更正内容');
  assert.equal((await SyncQueue.sync()).success, true);
  assert.equal(storage.read().checkins.length, 2);
  assert.equal(storage.read().checkins.every(item => item.notes === '更正内容' && item._syncStatus === 'synced'), true);
  await db.updateCheckinNotes('course', '2026-01-01', '撤销前内容');
  await db.cancelCheckin('course', '2026-01-01');
  await db.addCheckin('course', { date: '2026-01-01' });
  assert.equal((await db.getCheckins('course'))[0].notes, '');
  assert.equal((await SyncQueue.sync()).success, true);
  await db.refresh();
  assert.equal(cloud.rows('checkins').length, 1);
  assert.equal(cloud.rows('checkins')[0].notes, '');
  assert.equal((await db.getCheckins('course'))[0].notes, '');
  assert.equal(db.snapshot().totalLessons, 6);
});

test('archived note corrections require no restore and pending new-lesson notes follow explicit restore', async () => {
  const cloud = createCloud({ courses: [{ _id: 'course', _openid: 'parent-a', name: '钢琴' }], checkins: [
    { _id: 'old', _openid: 'parent-a', courseId: 'course', date: '2026-01-01', notes: '原备注' }
  ] }, { openid: 'parent-a' });
  const c = client({ cloud: async ({ name, data }) => ({ result: await cloud.call(name, data) }) });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('test-env', 'parent-a');
  const { db } = c.load('miniprogram/utils/db.js');
  const { SyncQueue } = c.load('miniprogram/utils/sync-queue.js');
  await db.refresh();
  await db.addCheckin('course', { date: '2026-01-02' });
  await db.updateCheckinNotes('course', '2026-01-02', '离线更正');
  await cloud.call('course', { action: 'archive', courseId: 'course' });
  assert.equal((await SyncQueue.sync()).success, false);
  await db.refresh();
  await db.restoreCourse('course');
  assert.equal((await SyncQueue.sync()).success, true);
  assert.equal(cloud.rows('checkins').find(item => item.date === '2026-01-02').notes, '离线更正');
  await db.archiveCourse('course');
  assert.equal((await SyncQueue.sync()).success, true);
  await db.updateCheckinNotes('course', '2026-01-01', '归档后更正');
  assert.equal((await SyncQueue.sync()).success, true);
  assert.equal(cloud.rows('courses')[0].isDeleted, true);
  assert.equal(cloud.rows('checkins').find(item => item._id === 'old').notes, '归档后更正');
  assert.equal(cloud.rows('checkins').length, 2);
});
