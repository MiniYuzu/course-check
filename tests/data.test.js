const test = require('node:test');
const assert = require('node:assert/strict');
const { client } = require('./helpers/client');
const success = data => ({ result: { success: true, code: 200, data } });
function setup(options) {
  const c = client(options);
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('test-env', 'parent-a');
  return { ...c, storage, db: c.load('miniprogram/utils/db.js').db, queue: c.load('miniprogram/utils/sync-queue.js').SyncQueue };
}
function seed(c, checkins = []) {
  c.storage.update(state => { state.courses = [{ _id: 'a', name: '钢琴', type: 'piano', initialLessons: 5, totalLessons: 20 }]; state.checkins = checkins; state.hasSnapshot = true; });
}

test('offline add survives refresh and course creation rewrites dependent ids atomically', async () => {
  let remote = [];
  const c = setup({ cloud: async ({ name, data }) => {
    if (name === 'login') return success({ openid: 'parent-a' });
    if (data.action === 'list') return success(name === 'course' ? { courses: remote, total: remote.length } : { checkins: [], total: 0 });
    if (data.action === 'add') { remote = [{ ...data.data, _id: 'remote-a' }]; return success(remote[0]); }
    if (data.action === 'checkin') return success({ ...data.data, _id: 'check-1' });
    throw new Error('unexpected request');
  } });
  const course = await c.db.addCourse({ name: '钢琴', type: 'piano', initialLessons: 5, totalLessons: 20 });
  await c.db.addCheckin(course._id, { date: '2026-01-01' });
  await c.db.refresh();
  assert.equal((await c.db.getCourses())[0].completedCount, 6);
  const result = await c.queue.sync();
  assert.equal(result.success, true);
  const courses = await c.db.getCourses();
  assert.equal(courses.length, 1);
  assert.equal(courses[0]._id, 'remote-a');
  assert.equal(courses[0].completedCount, 6);
  assert.equal(c.calls.find(x => x.data?.action === 'checkin').data.data.courseId, 'remote-a');
  assert.equal((await c.queue.getQueue()).length, 0);
});
test('all pages are loaded, never replaces a complete snapshot with partial results', async () => {
  const all = Array.from({ length: 65 }, (_, i) => ({ _id: String(i), courseId: 'a', date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}` }));
  let fail = false;
  const c = setup({ cloud: async ({ name, data }) => {
    if (name === 'course') return success({ courses: [{ _id: 'a', initialLessons: 5 }], total: 1 });
    if (fail && data.page === 2) throw new Error('network interrupted');
    return success({ checkins: all.slice((data.page - 1) * data.limit, data.page * data.limit), total: all.length });
  } });
  await c.db.refresh();
  assert.equal((await c.db.getCheckins('a')).length, 65);
  assert.equal((await c.db.getCourses())[0].completedCount, 70);
  fail = true;
  const result = await c.db.refresh();
  assert.equal(result.offline, true);
  assert.equal((await c.db.getCheckins('a')).length, 65);
});
test('syncing operations recover after process restart; failure blocks dependencies and is truthful', async () => {
  const store = new Map();
  const c = setup({ store });
  await c.db.addCourse({ name: '舞蹈', type: 'dance' });
  c.storage.update(state => { state.queue[0].status = 'syncing'; });
  const restarted = setup({ store, cloud: async ({ name }) => name === 'login' ? success({ openid: 'parent-a' }) : ({ result: { success: false, code: 500, message: '服务暂不可用' } }) });
  assert.equal((await restarted.queue.getStats()).pending, 1);
  const result = await restarted.queue.sync();
  assert.equal(result.success, false);
  assert.equal(result.failed, 1);
  assert.equal((await restarted.db.getCourses())[0]._syncStatus, 'failed');
});
test('same day double tap, cancellation and archiving preserve consistent counts', async () => {
  const c = setup(); seed(c);
  const results = await Promise.allSettled([c.db.addCheckin('a', { date: '2026-01-01' }), c.db.addCheckin('a', { date: '2026-01-01' })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  await c.db.cancelCheckin('a', '2026-01-01');
  assert.equal((await c.db.getCourses())[0].completedCount, 5);
  await c.db.archiveCourse('a');
  assert.equal((await c.db.getCourses()).length, 0);
  assert.equal((await c.db.getCourses(false, { includeArchived: true })).length, 1);
  await c.db.restoreCourse('a');
  assert.equal((await c.db.getCourses())[0].completedCount, 5);
});

test('legacy future lessons can be cancelled without allowing new future lessons', async () => {
  const c = setup(); seed(c, [{ _id: 'legacy-future', courseId: 'a', date: '2099-01-01' }]);
  await assert.rejects(c.db.addCheckin('a', { date: '2099-01-02' }), /未来/);
  await c.db.cancelCheckin('a', '2099-01-01');
  assert.equal((await c.db.getCheckins('a')).length, 0);
  assert.equal((await c.db.getCourse('a')).completedCount, 5);
  assert.equal((await c.queue.getQueue())[0].type, 'cancel_checkin');
});
test('env and owner isolate queues, legacy storage stays untouched and no anonymous writes', async () => {
  const legacy = [{ type: 'checkin', status: 'pending', payload: { courseId: 'legacy' } }];
  const store = new Map([['cc_sync_queue', legacy]]);
  const c = setup({ store }); seed(c);
  await c.db.addCheckin('a', { date: '2026-01-01' });
  c.storage.activate('test-env', 'parent-b');
  assert.equal((await c.queue.getQueue()).length, 0);
  assert.equal((await c.db.getCourses()).length, 0);
  c.storage.activate('other-env', 'parent-a');
  assert.equal((await c.queue.getQueue()).length, 0);
  c.storage.deactivate();
  await assert.rejects(c.db.addCourse({ name: 'new', type: 'other' }), /登录|身份/);
  assert.deepEqual(store.get('cc_sync_queue'), legacy);
});
test('queue persistence failure never reports a saved lesson', async () => {
  const c = setup(); seed(c);
  c.wx.setStorageSync = () => { throw new Error('storage quota exceeded'); };
  await assert.rejects(c.db.addCheckin('a', { date: '2026-01-01' }), /storage quota/);
  assert.equal((await c.db.getCheckins('a')).length, 0);
});
test('identity change before sync never sends previous owner mutations', async () => {
  const c = setup({ cloud: async () => success({ openid: 'parent-b' }) }); seed(c);
  await c.db.addCheckin('a', { date: '2026-01-01' });
  assert.equal((await c.queue.sync()).success, false);
  assert.equal(c.calls.filter(x => x.name !== 'login').length, 0);
});

test('refresh retries an obsolete snapshot after a concurrent acknowledgement', async () => {
  let finish;
  let first = true;
  const c = setup({ cloud: async ({ name }) => {
    if (name === 'course' && first) { first = false; await new Promise(resolve => { finish = resolve; }); }
    return success(name === 'course' ? { courses: [{ _id: 'old' }, { _id: 'new' }], total: 2 } : { checkins: [{ courseId: 'old', date: '2026-01-01' }], total: 1 });
  } });
  const refresh = c.db.refresh();
  c.storage.update(state => { state.cloudRevision++; state.courses = [{ _id: 'new' }]; });
  finish();
  const value = await refresh;
  assert.equal(value.hasSnapshot, true);
  assert.equal(value.courses.length, 2);
  assert.equal(value.checkins.length, 1);
});
test('an old account login response does not deactivate a newer session', async () => {
  let finish;
  const c = setup({ cloud: async () => new Promise(resolve => { finish = () => resolve(success({ openid: 'parent-a' })); }) });
  seed(c); await c.db.addCheckin('a', { date: '2026-01-01' });
  const sync = c.queue.sync();
  c.storage.activate('test-env', 'parent-b');
  finish(); await sync;
  assert.equal(c.storage.getSession().openid, 'parent-b');
});

test('a delayed protected-call authorization failure cannot deactivate a newer account', async () => {
  let finish;
  const c = setup({ cloud: async () => new Promise(resolve => {
    finish = () => resolve({ result: { success: false, code: 401, message: 'Unauthorized' } });
  }) });
  const { call } = c.load('miniprogram/utils/sync-queue.js');
  const request = call('course', { action: 'list' });
  assert.equal(c.calls[0].data.expectedOpenid, 'parent-a');
  c.storage.activate('test-env', 'parent-b');
  finish();
  await assert.rejects(request, /身份/);
  assert.equal(c.storage.getSession().openid, 'parent-b');
});

test('pagination stops when the local account changes and never requests a page as the new owner', async () => {
  const c = setup({ cloud: async ({ name, data }) => {
    if (name === 'course') return success({ courses: [], total: 0 });
    c.storage.activate('test-env', 'parent-b');
    return success({ checkins: Array.from({ length: 50 }, (_, i) => ({ _id: String(i), courseId: 'a', date: '2026-01-01' })), total: 51 });
  } });
  const originalKey = c.storage.getSession().key;
  seed(c);
  await assert.rejects(c.db.refresh(), /身份/);
  assert.equal(c.calls.some(item => item.data?.page === 2), false);
  assert.equal(c.calls.every(item => item.data.expectedOpenid === 'parent-a'), true);
  assert.equal(c.storage.getSession().openid, 'parent-b');
  assert.equal(c.storage.read(originalKey).courses[0].name, '钢琴');
  assert.equal(c.storage.read().courses.length, 0);
});
test('acknowledgement storage failure exposes failure instead of eternal syncing', async () => {
  const c = setup({ cloud: async ({ name, data }) => {
    if (name === 'login') return success({ openid: 'parent-a' });
    c.wx.setStorageSync = () => { throw new Error('storage quota exceeded'); };
    return success({ ...data.data, _id: 'remote-check' });
  } });
  seed(c); await c.db.addCheckin('a', { date: '2026-01-01' });
  assert.equal((await c.queue.sync()).success, false);
  assert.equal((await c.queue.getStats()).syncing, 0);
  assert.equal((await c.queue.getStats()).failed, 1);
  assert.equal((await c.db.getCourses())[0]._syncStatus, 'failed');
});

test('lost course-add response followed by refresh never displays or counts a duplicate course', async () => {
  let remote;
  let responseLost = true;
  const c = setup({ cloud: async ({ name, data }) => {
    if (name === 'login') return success({ openid: 'parent-a' });
    if (name === 'course' && data.action === 'add') {
      remote = { ...data.data, _id: 'remote-1' };
      if (responseLost) { responseLost = false; throw new Error('response lost'); }
      return success(remote);
    }
    if (data.action === 'list') return success(name === 'course' ? { courses: remote ? [remote] : [], total: remote ? 1 : 0 } : { checkins: [], total: 0 });
    return success({ ...data.data, _id: 'lesson-1' });
  } });
  const local = await c.db.addCourse({ name: '钢琴', type: 'piano', initialLessons: 5 });
  await c.db.addCheckin(local._id, { date: '2026-01-01' });
  assert.equal((await c.queue.sync()).success, false);
  await c.db.refresh();
  assert.equal(c.db.snapshot().courses.length, 1);
  assert.equal(c.db.snapshot().totalLessons, 6);
  assert.equal((await c.db.getCourse(local._id))._id, 'remote-1');
  assert.equal((await c.queue.sync()).success, true);
  assert.equal(c.db.snapshot().totalLessons, 6);
});

test('a changed pagination total forces a new full read, never commits a truncated snapshot', async () => {
  const old = Array.from({ length: 51 }, (_, i) => ({ _id: String(i), courseId: 'a', date: `2026-01-${String(i + 1).padStart(2, '0')}` }));
  let firstPageSeen = false;
  const c = setup({ cloud: async ({ name, data }) => {
    if (name === 'course') return success({ courses: [{ _id: 'a' }], total: 1 });
    if (!firstPageSeen) { firstPageSeen = true; return success({ checkins: old.slice(0, 50), total: 51 }); }
    const current = old.slice(1);
    return success({ checkins: current.slice((data.page - 1) * 50, data.page * 50), total: 50 });
  } });
  await c.db.refresh();
  const records = await c.db.getCheckins('a');
  assert.equal(records.length, 50);
  assert.equal(records.some(item => item._id === '50'), true);
  assert.equal(records.some(item => item._id === '0'), false);
});

test('new lesson notes are normalized and overlong input cannot enter the durable queue', async () => {
  const c = setup(); seed(c);
  const first = await c.db.addCheckin('a', { date: '2026-01-01', notes: '  踢腿\n  练习  ' });
  assert.equal(first.notes, '踢腿 练习');
  await c.db.addCheckin('a', { date: '2026-01-02', notes: '课'.repeat(60) });
  await assert.rejects(c.db.addCheckin('a', { date: '2026-01-03', notes: '课'.repeat(61) }), /60/);
  assert.equal((await c.queue.getQueue()).length, 2);
});

test('editing and clearing existing lesson notes changes neither records nor course counts', async () => {
  const c = setup(); seed(c, [
    { _id: 'lesson-a', courseId: 'a', date: '2026-01-01', notes: '原备注' },
    { _id: 'lesson-b', courseId: 'a', date: '2026-01-02', notes: '另一天' }
  ]);
  await c.db.updateCheckinNotes('a', '2026-01-01', '  换气\n练习  ');
  let records = await c.db.getCheckins('a');
  assert.equal(records.find(item => item._id === 'lesson-a').notes, '换气 练习');
  assert.equal(records.find(item => item._id === 'lesson-a')._syncStatus, 'pending');
  assert.equal(records.find(item => item._id === 'lesson-b').notes, '另一天');
  assert.equal(records.length, 2);
  assert.equal((await c.db.getCourse('a')).completedCount, 7);
  assert.equal((await c.db.getCourse('a')).remainingCount, 13);
  assert.equal((await c.queue.getQueue())[0].type, 'update_checkin_notes');
  await c.db.updateCheckinNotes('a', '2026-01-01', ' \n ');
  records = await c.db.getCheckins('a');
  assert.equal(records.find(item => item._id === 'lesson-a').notes, '');
  assert.equal((await c.db.getCourse('a')).completedCount, 7);
});

test('lesson-note validation rejects missing records and permits archived-course corrections', async () => {
  const c = setup(); seed(c, [{ _id: 'lesson', courseId: 'a', date: '2026-01-01', notes: '旧'.repeat(80) }]);
  assert.equal((await c.db.getCheckins('a'))[0].notes.length, 80);
  await assert.rejects(c.db.updateCheckinNotes('a', '2026-01-02', '不存在'), /未找到|不存在/);
  await assert.rejects(c.db.updateCheckinNotes('wrong', '2026-01-01', '不存在'), /未找到|不存在/);
  await assert.rejects(c.db.updateCheckinNotes('a', '2026-01-01', '课'.repeat(61)), /60/);
  assert.equal((await c.queue.getQueue()).length, 0);
  await c.db.archiveCourse('a');
  await c.db.updateCheckinNotes('a', '2026-01-01', '课'.repeat(60));
  assert.equal((await c.db.getCheckins('a'))[0].notes, '课'.repeat(60));
  assert.equal((await c.db.getCourse('a')).isDeleted, true);
  c.storage.activate('test-env', 'parent-b');
  await assert.rejects(c.db.updateCheckinNotes('a', '2026-01-01', '越权'), /未找到|不存在/);
  assert.equal((await c.queue.getQueue()).length, 0);
});

test('note queue overlays never resurrect a cancelled record or leak old notes into a new lesson', async () => {
  const c = setup(); seed(c, [{ _id: 'old', courseId: 'a', date: '2026-01-01', notes: '原备注' }]);
  await c.db.updateCheckinNotes('a', '2026-01-01', '旧课更正');
  await c.db.cancelCheckin('a', '2026-01-01');
  assert.equal((await c.db.getCheckins('a')).length, 0);
  await assert.rejects(c.db.updateCheckinNotes('a', '2026-01-01', '不能复活'), /未找到|不存在/);
  await c.db.addCheckin('a', { date: '2026-01-01' });
  assert.equal((await c.db.getCheckins('a'))[0].notes, '');
  assert.equal((await c.db.getCourse('a')).completedCount, 6);
});

test('a failed note edit stays durable and later note overlays preserve the failure status', async () => {
  const c = setup({ cloud: async ({ name }) => name === 'login' ? success({ openid: 'parent-a' }) :
    { result: { success: false, code: 404, message: 'Checkin not found' } } });
  seed(c, [
    { _id: 'duplicate-1', courseId: 'a', date: '2026-01-01', notes: '原备注' },
    { _id: 'duplicate-2', courseId: 'a', date: '2026-01-01', notes: '原备注' }
  ]);
  await c.db.updateCheckinNotes('a', '2026-01-01', '第一次更正');
  await c.db.updateCheckinNotes('a', '2026-01-01', '最新更正');
  assert.equal((await c.queue.sync()).success, false);
  assert.equal((await c.queue.getQueue()).length, 2);
  assert.equal((await c.queue.getStats()).failed, 1);
  assert.equal((await c.db.getCheckins('a'))[0].notes, '最新更正');
  assert.equal((await c.db.getCheckins('a'))[0]._syncStatus, 'failed');
  assert.equal((await c.db.getCourse('a')).completedCount, 6);
  const request = c.calls.find(item => item.data?.action === 'updateNotes');
  assert.equal(request.data.expectedOpenid, 'parent-a');
  assert.deepEqual(request.data.data, { courseId: 'a', date: '2026-01-01', notes: '第一次更正' });
});
