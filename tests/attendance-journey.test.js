const test = require('node:test');
const assert = require('node:assert/strict');
const { client } = require('./helpers/client');
const { createCloud } = require('./helpers/cloud');
const { courseTimeline } = require('../miniprogram/utils/attendance');
function connect(remote, options = {}) {
  const c = client({ ...options, cloud: async ({ name, data }) => ({ result: await remote.call(name, data) }) });
  const storage = c.load('miniprogram/utils/storage.js'); storage.activate('test-env', 'owner');
  return { ...c, storage, db: c.load('miniprogram/utils/db.js').db, queue: c.load('miniprogram/utils/sync-queue.js').SyncQueue };
}

test('offline structured creation, correction, restart, aliasing and archive/restore agree with cloud', async () => {
  const remote = createCloud({}, { now: '2026-12-01T00:00:00Z' });
  const store = new Map(); let c = connect(remote, { store });
  const records = c.load('miniprogram/utils/records.js');
  const course = await c.db.addCourse({ name: '钢琴', type: 'piano', totalLessons: 10, scheduleChange: { effectiveFrom: '2026-01-01', requestedOn: records.today(), slots: [{ weekday: 5, start: '10:00', end: '11:00' }] } });
  await c.db.setAttendance(course._id, { date: '2026-01-02', status: 'absent', debit: 0 });
  await c.db.setAttendance(course._id, { date: '2026-01-02', status: 'absent', debit: 1, reason: '身体不适' });
  await c.db.updateCheckinNotes(course._id, '2026-01-02', '更正备注');
  c = connect(remote, { store });
  assert.equal((await c.queue.sync()).success, true);
  const id = (await c.db.getCourses())[0]._id;
  assert.notEqual(id, course._id); assert.equal(c.storage.read().aliases[course._id], id);
  assert.equal(c.db.snapshot().checkins[0].attendanceRevision, 3);
  assert.equal(c.db.snapshot().courses[0].completedCount, 0); assert.equal(c.db.snapshot().courses[0].consumedCount, 1);
  await c.db.archiveCourse(id); await c.db.restoreCourse(id);
  const archiveDay = records.today();
  const timeline = courseTimeline((await c.db.getCourse(id)), c.db.snapshot().rawCheckins, { now: new Date('2026-12-01T00:00:00Z'), from: records.addDays(archiveDay, 1), to: '2026-12-31' });
  assert.equal(timeline.length, 0);
  assert.equal((await c.queue.sync()).success, true); await c.db.refresh();
  const overview = (await remote.call('stats', { action: 'overview' })).data;
  assert.equal(overview.totalCheckins, c.db.snapshot().totalLessons); assert.equal(overview.consumedCount, c.db.snapshot().consumedCount);
  assert.deepEqual(remote.rows('courses')[0].scheduleVersions.at(-1).slots, []);
  assert.equal(remote.rows('courses')[0].scheduleVersions.at(-1).effectiveFrom, records.addDays(archiveDay, 1));
});

test('lost attendance response then refresh and process restart replays stable operation without increment', async () => {
  const remote = createCloud({ courses: [{ _id: 'c', _openid: 'owner', name: '钢琴', totalLessons: 10 }] });
  const store = new Map(); let lose = true;
  let c = connect(remote, { store });
  c.wx.cloud.callFunction = async ({ name, data }) => {
    const result = await remote.call(name, data);
    if (data.action === 'setAttendance' && lose) { lose = false; throw new Error('reply lost'); }
    return { result };
  };
  await c.db.refresh(); await c.db.setAttendance('c', { date: '2026-01-02', status: 'attended', debit: 1 });
  assert.equal((await c.queue.sync()).success, false); assert.equal(remote.rows('checkins')[0].attendanceRevision, 1);
  await c.db.refresh();
  assert.equal(c.db.snapshot().consumedCount, 1);
  c = connect(remote, { store });
  assert.equal((await c.queue.sync()).success, true); assert.equal(remote.rows('checkins')[0].attendanceRevision, 1);
  await c.db.cancelCheckin('c', '2026-01-02'); assert.equal((await c.queue.sync()).success, true);
  assert.equal(remote.rows('checkins')[0].status, 'voided'); assert.equal(c.db.snapshot().totalLessons, 0);
});

test('failed archived attendance is recoverable via explicit restore without losing queued correction', async () => {
  const remote = createCloud({ courses: [{ _id: 'c', _openid: 'owner', name: '钢琴', totalLessons: 10 }] });
  const c = connect(remote); await c.db.refresh();
  await c.db.setAttendance('c', { date: '2026-01-02', status: 'attended', debit: 1 });
  await remote.call('course', { action: 'archive', courseId: 'c' });
  assert.equal((await c.queue.sync()).success, false); await c.db.refresh();
  await c.db.restoreCourse('c');
  assert.equal((await c.queue.getQueue())[0].type, 'restore_course');
  assert.equal((await c.queue.sync()).success, true); assert.equal(remote.rows('checkins').length, 1);
});

for (const action of ['cancel', 'updateNotes']) {
  test(`queued legacy ${action} adopts canonical reply after promotion and lost response`, async () => {
    const remote = createCloud({ courses: [{ _id: 'c', _openid: 'owner', name: '钢琴', totalLessons: 10 }], checkins: [{ _id: 'legacy', _openid: 'owner', courseId: 'c', date: '2026-01-02', notes: '旧备注' }] });
    const c = connect(remote); await c.db.refresh();
    if (action === 'cancel') await c.db.cancelCheckin('c', '2026-01-02'); else await c.db.updateCheckinNotes('c', '2026-01-02', '新备注');
    assert.equal(c.storage.read().queue[0].type, action === 'cancel' ? 'cancel_checkin' : 'update_checkin_notes');
    const promoted = await remote.call('checkin', { action: 'setAttendance', data: { courseId: 'c', date: '2026-01-02', status: 'attended', debit: 1, notes: '云端备注', operationId: 'promote', expectedRevision: 0 } });
    assert.equal(promoted.success, true);
    let lose = true;
    c.wx.cloud.callFunction = async ({ name, data }) => {
      const result = await remote.call(name, data);
      if (data.action === action && lose) { lose = false; throw new Error('reply lost'); }
      return { result };
    };
    assert.equal((await c.queue.sync()).success, false);
    assert.equal((await c.queue.sync()).success, true);
    assert.equal(c.db.snapshot().rawCheckins[0].attendanceRevision, 2);
    assert.equal(remote.rows('checkins').find(item => item.attendanceRevision).attendanceRevision, 2);
    if (action === 'cancel') {
      assert.equal(c.db.snapshot().rawCheckins[0].status, 'voided');
      await c.db.addCheckin('c', { date: '2026-01-02' });
      assert.equal(c.storage.read().queue[0].type, 'set_attendance');
      assert.equal((await c.queue.sync()).success, true);
      assert.equal(c.db.snapshot().checkins[0].attendanceRevision, 3);
      assert.equal(c.db.snapshot().checkins[0].status, 'attended');
    } else assert.equal(c.db.snapshot().checkins[0].notes, '新备注');
  });
}

for (const action of ['cancel', 'updateNotes']) {
  test(`lost legacy ${action} reply followed by newer decision rejects replay and allows backed-up recovery`, async () => {
    const remote = createCloud({ courses: [{ _id: 'c', _openid: 'owner', name: '钢琴', totalLessons: 10 }], checkins: [{ _id: 'legacy', _openid: 'owner', courseId: 'c', date: '2026-01-02' }] });
    const c = connect(remote); await c.db.refresh();
    if (action === 'cancel') await c.db.cancelCheckin('c', '2026-01-02'); else await c.db.updateCheckinNotes('c', '2026-01-02', 'Old');
    await remote.call('checkin', { action: 'setAttendance', data: { courseId: 'c', date: '2026-01-02', status: 'attended', debit: 1, operationId: 'promote', expectedRevision: 0 } });
    let lose = true;
    c.wx.cloud.callFunction = async ({ name, data }) => {
      const result = await remote.call(name, data);
      if (data.action === action && lose) { lose = false; throw new Error('reply lost'); }
      return { result };
    };
    assert.equal((await c.queue.sync()).success, false);
    await remote.call('checkin', { action: 'setAttendance', data: { courseId: 'c', date: '2026-01-02', status: 'attended', debit: 1, notes: 'New', operationId: 'newer-decision', expectedRevision: 2 } });
    assert.equal((await c.queue.sync()).success, false);
    const head = c.storage.read().queue[0]; assert.equal(head.lastErrorCode, 409);
    assert.equal(remote.rows('checkins').find(item => item.attendanceRevision).attendanceRevision, 3);
    assert.equal((await c.db.adoptCloudResult(head._id)).discardedCount, 1);
    assert.equal(c.storage.read().discardedOperations[0]._id, head._id);
    assert.equal(c.db.snapshot().checkins[0].notes, 'New');
    assert.equal((await c.queue.sync()).success, true);
  });
}
