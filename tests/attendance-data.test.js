const test = require('node:test');
const assert = require('node:assert/strict');
const { client } = require('./helpers/client');
const success = data => ({ result: { success: true, code: 200, data } });
function setup(options = {}) {
  const c = client(options);
  const storage = c.load('miniprogram/utils/storage.js'); storage.activate('test-env', 'owner');
  return { ...c, storage, db: c.load('miniprogram/utils/db.js').db, queue: c.load('miniprogram/utils/sync-queue.js').SyncQueue };
}
const course = (extra = {}) => ({ _id: 'c', name: '钢琴', type: 'piano', totalLessons: 10, initialLessons: 2, ...extra });
function seed(c, checkins = [], extra = {}) { c.storage.update(state => { state.courses = [course(extra)]; state.checkins = checkins; state.hasSnapshot = true; }); }
const entry = (extra = {}) => ({ date: '2026-01-02', status: 'absent', debit: 0, reason: '请假', notes: '原记录', ...extra });
const change = c => ({ effectiveFrom: '2026-01-01', slots: [{ weekday: 5, start: '10:00', end: '11:00' }], requestedOn: c.load('miniprogram/utils/records.js').today(), expectedVersion: '' });

test('offline attendance edits keep sequential revisions, charge once and retain undo tombstones', async () => {
  const c = setup(); seed(c);
  const first = await c.db.setAttendance('c', entry()); assert.equal(first.attendanceRevision, 1);
  await c.db.setAttendance('c', entry({ debit: 1 }));
  assert.equal((await c.db.getCourse('c')).consumedCount, 3); assert.equal((await c.db.getCourse('c')).completedCount, 2);
  await assert.rejects(c.db.setAttendance('c', entry({ expectedRevision: 0 })), /更新|版本|刷新/);
  await c.db.setAttendance('c', entry({ status: 'attended', debit: 1 }));
  assert.equal((await c.db.getCourse('c')).completedCount, 3);
  await c.db.updateCheckinNotes('c', '2026-01-02', ' 更正\n 备注 ');
  assert.equal(c.db.snapshot().checkins[0].attendanceRevision, 4);
  await c.db.cancelCheckin('c', '2026-01-02');
  assert.equal(c.db.snapshot().rawCheckins[0].status, 'voided'); assert.equal(c.db.snapshot().checkins.length, 0);
  await c.db.addCheckin('c', { date: '2026-01-02' });
  assert.equal(c.db.snapshot().checkins[0].attendanceRevision, 6);
  assert.equal((await c.queue.getQueue()).map(item => item.payload.expectedRevision).join(','), '0,1,2,3,4,5');
  assert.equal((await c.queue.getQueue()).every(item => item.type === 'set_attendance'), true);
});

test('client rejects invalid attendance without enqueueing and permits only archived historical corrections', async () => {
  const c = setup(); seed(c);
  for (const invalid of [{ status: 'pending' }, { status: 'attended', debit: 0 }, { status: 'cancelled', debit: 1 }, { debit: '1' }, { date: '2026-02-31' }, { date: '2099-01-01' }, { notes: '课'.repeat(61) }]) await assert.rejects(c.db.setAttendance('c', entry(invalid)));
  assert.equal((await c.queue.getQueue()).length, 0);
  await c.db.setAttendance('c', entry()); await c.db.archiveCourse('c');
  await c.db.setAttendance('c', entry({ debit: 1 }));
  await assert.rejects(c.db.setAttendance('c', entry({ date: '2026-01-03' })), /归档/);
  assert.equal(await c.db.hasCheckedIn('c', '2026-01-02'), false);
});

test('schedule projection is server-owned, unchanged simple edits preserve history and stale refresh never crashes view', async () => {
  const c = setup();
  const added = await c.db.addCourse({ name: '钢琴', type: 'piano', scheduleChange: change(c), scheduleVersions: [{ effectiveFrom: '2000-01-01' }] });
  const projected = await c.db.getCourse(added._id);
  assert.equal(projected.scheduleVersions.length, 1); assert.equal(projected.scheduleVersions[0].operationId, (await c.queue.getQueue())[0]._id);
  await c.db.updateCourse(added._id, { name: '改名' }); assert.equal((await c.db.getCourse(added._id)).scheduleVersions.length, 1);
  const tomorrow = c.load('miniprogram/utils/records.js').addDays(change(c).requestedOn, 1);
  await c.db.updateCourse(added._id, { scheduleChange: { ...change(c), effectiveFrom: tomorrow, expectedVersion: projected.scheduleVersions[0].operationId, slots: [] } });
  assert.equal((await c.db.getCourse(added._id)).scheduleVersions.length, 2);
  c.storage.update(state => { state.courses = [course({ scheduleVersions: [{ ...change(c), operationId: 'remote' }] })]; state.queue = [{ _id: 'stale', type: 'update_course', payload: { courseId: 'c', updates: { scheduleChange: { ...change(c), effectiveFrom: tomorrow } } }, status: 'failed', lastError: 'changed', retryCount: 1 }]; });
  assert.equal(c.db.snapshot().courses[0]._syncStatus, 'failed'); assert.equal(c.db.snapshot().courses[0].scheduleVersions[0].operationId, 'remote');
});

test('old deployed course function blocks schedule writes before add and missing acknowledgements retain queue', async () => {
  const c = setup({ cloud: async ({ name }) => name === 'login' ? success({ openid: 'owner' }) : ({ result: { success: false, code: 400, message: 'Unknown action' } }) });
  await c.db.addCourse({ name: '钢琴', type: 'piano', scheduleChange: change(c) });
  assert.equal((await c.queue.sync()).success, false);
  assert.equal(c.calls.some(item => item.data?.action === 'add'), false);
  assert.equal((await c.queue.getStats()).failed, 1);
  const missing = setup({ cloud: async ({ name, data }) => name === 'login' ? success({ openid: 'owner' }) : data.action === 'capabilities' ? success({ attendanceVersion: 1 }) : success({ _id: 'remote', name: '钢琴' }) });
  await missing.db.addCourse({ name: '钢琴', type: 'piano', scheduleChange: change(missing) });
  assert.equal((await missing.queue.sync()).success, false); assert.equal((await missing.queue.getQueue()).length, 1);
});

test('attendance acknowledgement uses actual canonical result not optimistic revision', async () => {
  const c = setup({ cloud: async ({ name, data }) => name === 'login' ? success({ openid: 'owner' }) : success({ ...data.data, _id: 'canonical', attendanceRevision: 1, notes: '服务确认' }) }); seed(c);
  await c.db.setAttendance('c', entry()); assert.equal((await c.queue.sync()).success, true);
  assert.equal(c.storage.read().checkins[0]._id, 'canonical'); assert.equal(c.db.snapshot().checkins[0].notes, '服务确认');
});

test('409 recovery adopts refreshed cloud result only with confirmation and preserves dependent discards in backup', async () => {
  let conflict = true;
  const remote = { _id: 'canonical', courseId: 'c', date: '2026-01-02', status: 'attended', attendanceRevision: 7 };
  const c = setup({ cloud: async ({ name, data }) => name === 'login' ? success({ openid: 'owner' }) : data.action === 'list' ? success(name === 'course' ? { courses: [course()], total: 1 } : { checkins: [remote], total: 1 }) : conflict ? { result: { success: false, code: 409, message: '已更新' } } : success({ ...data.data, _id: 'other', attendanceRevision: 1 }) }); seed(c);
  await c.db.setAttendance('c', entry()); await c.db.setAttendance('c', entry({ debit: 1 })); await c.db.setAttendance('c', entry({ date: '2026-01-03' }));
  assert.equal((await c.queue.sync()).success, false);
  const head = (await c.queue.getQueue())[0]; assert.equal(head.lastErrorCode, 409);
  const result = await c.db.adoptCloudResult(head._id); assert.equal(result.discardedCount, 2);
  assert.equal((await c.queue.getQueue()).length, 1); assert.equal(c.storage.read().discardedOperations.length, 2);
  assert.equal(c.db.snapshot().checkins.find(item => item.date === remote.date).attendanceRevision, 7);
  const backup = JSON.parse(c.load('miniprogram/utils/export.js').buildExport(c.db.snapshot(), c.storage.read().queue, c.storage.read()).json);
  assert.equal(backup.sourceSnapshot.discardedOperations.length, 2);
  conflict = false; assert.equal((await c.queue.sync()).success, true);
  await assert.rejects(c.db.adoptCloudResult(head._id), /失败|冲突|变/);
});

test('recovery never discards operations on an offline refresh or non-conflict failure', async () => {
  const c = setup(); seed(c); await c.db.setAttendance('c', entry());
  c.storage.update(state => { state.queue[0].status = 'failed'; state.queue[0].lastErrorCode = 409; });
  await assert.rejects(c.db.adoptCloudResult(c.storage.read().queue[0]._id), /联网|刷新|云端/);
  assert.equal(c.storage.read().queue.length, 1);
});

test('exports include attendance, debit and consumed counts and preserve hidden raw revisions', () => {
  const c = setup(); seed(c, [{ _id: 'a', courseId: 'c', ...entry({ debit: 1 }), attendanceRevision: 3 }, { _id: 'v', courseId: 'c', date: '2026-01-03', status: 'voided', attendanceRevision: 4 }]);
  const out = c.load('miniprogram/utils/export.js').buildExport(c.db.snapshot(), [], c.storage.read());
  assert.match(out.csv, /累计扣课/); assert.match(out.csv, /缺席/); assert.match(out.csv, /请假/);
  const backup = JSON.parse(out.json); assert.equal(backup.version, 3); assert.equal(backup.rawCheckins.length, 2);
});

test('pending schedule projection is computed only, hides confirmed outcomes and never enters backup raw rows', async () => {
  const c = setup();
  const added = await c.db.addCourse({ name: '钢琴', type: 'piano', scheduleChange: change(c) });
  assert.ok(c.db.snapshot().pendingCount > 0);
  const before = c.db.snapshot().pendingCount;
  await c.db.setAttendance(added._id, entry());
  assert.equal(c.db.snapshot().pendingCount, before - 1);
  assert.equal(c.storage.read().checkins.length, 0); assert.equal(c.db.snapshot().rawCheckins.length, 1);
});

test('invalid first schedule token is rejected before durable save', async () => {
  const c = setup();
  await assert.rejects(c.db.addCourse({ name: '钢琴', type: 'piano', scheduleChange: { ...change(c), expectedVersion: 'stale' } }), /更新/);
  assert.equal(c.storage.read().queue.length, 0);
});

test('already archived cloud course acknowledges existing stop without adding another schedule version', async () => {
  const c = setup({ cloud: async ({ name, data }) => name === 'login' ? success({ openid: 'owner' }) : data.action === 'capabilities' ? success({ attendanceVersion: 1 }) : success(course({ isDeleted: true, scheduleVersions: [{ effectiveFrom: '2026-01-01', slots: [], operationId: 'remote-stop' }] })) });
  seed(c, [], { scheduleVersions: [{ ...change(c), operationId: 'first' }] });
  await c.db.archiveCourse('c');
  assert.equal((await c.queue.sync()).success, true);
  assert.equal((await c.db.getCourse('c')).scheduleVersions[0].operationId, 'remote-stop');
});

test('schedule conflict recovery discards only dependent schedule versions, preserving unrelated edits and attendance', async () => {
  const c = setup({ cloud: async ({ name, data }) => data.action === 'list' ? success(name === 'course' ? { courses: [course({ scheduleVersions: [{ ...change(c), operationId: 'remote' }] })], total: 1 } : { checkins: [], total: 0 }) : success({ openid: 'owner' }) }); seed(c);
  const records = c.load('miniprogram/utils/records.js');
  c.storage.update(state => { state.queue = [
    { _id: 'bad', type: 'update_course', payload: { courseId: 'c', updates: { scheduleChange: { ...change(c), effectiveFrom: records.addDays(records.today(), 1), expectedVersion: 'old' } } }, status: 'failed', lastErrorCode: 409 },
    { _id: 'dependent', type: 'update_course', payload: { courseId: 'c', updates: { scheduleChange: { ...change(c), effectiveFrom: records.addDays(records.today(), 2), expectedVersion: 'bad' } } }, status: 'pending' },
    { _id: 'name', type: 'update_course', payload: { courseId: 'c', updates: { name: '保留名称' } }, status: 'pending' },
    { _id: 'result', type: 'set_attendance', payload: { courseId: 'c', _id: 'local', ...entry(), expectedRevision: 0, attendanceRevision: 1 }, status: 'pending' }
  ]; });
  assert.equal((await c.db.adoptCloudResult('bad')).discardedCount, 2);
  assert.equal(c.storage.read().queue.map(item => item._id).join(','), 'name,result');
});
