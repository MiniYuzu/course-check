const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloud, pauseOnce } = require('./helpers/cloud');
const { summarize } = require('../miniprogram/utils/records');
const course = (extra = {}) => ({ _id: 'c', _openid: 'owner', name: '钢琴', totalLessons: 10, initialLessons: 2, ...extra });
const ok = response => { assert.equal(response.success, true, response.message); return response.data; };
const write = (app, extra = {}) => app.call('checkin', { action: 'setAttendance', data: { courseId: 'c', date: '2026-10-02', status: 'absent', debit: 0, operationId: 'op1', expectedRevision: 0, ...extra } });
const change = (extra = {}) => ({ effectiveFrom: '2026-09-01', slots: [{ weekday: 5, start: '10:00', end: '11:00' }], requestedOn: '2026-10-02', expectedVersion: '', ...extra });

test('attendance correction, replay and voided revision override all legacy duplicate rows', async () => {
  const app = createCloud({ courses: [course()], checkins: [{ _id: 'legacy', _openid: 'owner', courseId: 'c', date: '2026-10-02' }] });
  const first = ok(await write(app));
  assert.equal(first.attendanceRevision, 1);
  assert.equal(ok(await write(app)).attendanceRevision, 1);
  const charged = ok(await write(app, { operationId: 'op2', expectedRevision: 1, debit: 1, reason: '请假' }));
  assert.equal(charged.attendanceRevision, 2);
  assert.equal((await write(app, { operationId: 'stale', expectedRevision: 0 })).code, 409);
  ok(await write(app, { operationId: 'op3', expectedRevision: 2, status: 'attended', debit: 1 }));
  const stats = ok(await app.call('course', { action: 'get', courseId: 'c' }));
  assert.equal(stats.completedCount, 3); assert.equal(stats.consumedCount, 3);
  ok(await write(app, { operationId: 'undo', expectedRevision: 3, status: 'voided', debit: 0 }));
  assert.equal((await write(app, { operationId: 'op3', expectedRevision: 2, status: 'attended', debit: 1 })).code, 409);
  assert.equal(summarize(app.rows('courses'), app.rows('checkins')).checkins.length, 0);
  assert.equal(app.rows('checkins').length, 2);
  assert.equal(ok(await app.call('checkin', { action: 'hasCheckedIn', courseId: 'c' })).hasCheckedIn, false);
  assert.equal(ok(await app.call('checkin', { action: 'checkin', data: { courseId: 'c', date: '2026-10-02' } })).status, 'voided');
});

test('attendance validates exact values, identity and archived creation but permits historical corrections', async () => {
  const app = createCloud({ courses: [course()] });
  for (const extra of [{ status: 'pending' }, { debit: '1' }, { status: 'attended', debit: 0 }, { status: 'cancelled', debit: 1 }, { date: '2026-02-31' }, { date: '2099-01-01' }, { expectedRevision: -1 }, { operationId: '' }, { notes: '课'.repeat(61) }, { reason: 'unknown' }]) {
    assert.equal((await write(app, extra)).code, 400, JSON.stringify(extra));
  }
  assert.equal((await app.call('checkin', { action: 'setAttendance', expectedOpenid: 'other', data: {} })).code, 401);
  const foreign = createCloud({ courses: [course({ _openid: 'other' })] });
  assert.equal((await write(foreign)).code, 404);
  ok(await write(app));
  ok(await app.call('course', { action: 'archive', courseId: 'c' }));
  ok(await write(app, { operationId: 'correction', expectedRevision: 1, debit: 1 }));
  assert.equal((await write(app, { date: '2026-10-01', operationId: 'new' })).code, 400);
});

test('server owns schedule history, retries once and archives from durable user day without restarting on restore', async () => {
  const app = createCloud();
  assert.equal(ok(await app.call('course', { action: 'capabilities' })).attendanceVersion, 1);
  const input = { name: '钢琴', operationId: 'create', schedule: '周五', scheduleChange: change(), scheduleVersions: [{ effectiveFrom: '2000-01-01' }], _openid: 'other' };
  const created = ok(await app.call('course', { action: 'add', data: input }));
  assert.equal(created.scheduleVersions.length, 1); assert.equal(created.scheduleVersions[0].operationId, 'create');
  assert.equal(created._openid, 'owner');
  assert.deepEqual(ok(await app.call('course', { action: 'add', data: input })).scheduleVersions, created.scheduleVersions);
  const edit = { action: 'update', courseId: created._id, operationId: 'edit', updates: { scheduleChange: change({ effectiveFrom: '2026-10-03', expectedVersion: 'create' }) } };
  const updated = ok(await app.call('course', edit));
  assert.equal(updated.scheduleVersions.length, 2);
  assert.deepEqual(ok(await app.call('course', edit)).scheduleVersions, updated.scheduleVersions);
  assert.equal((await app.call('course', { ...edit, operationId: 'stale' })).code, 409);
  assert.deepEqual(ok(await app.call('course', { action: 'update', courseId: created._id, updates: { name: '改名', scheduleVersions: [] } })).scheduleVersions, updated.scheduleVersions);
  const archive = { action: 'archive', courseId: created._id, operationId: 'archive', requestedOn: '2026-10-01' };
  const archived = ok(await app.call('course', archive));
  assert.equal(archived.scheduleVersions.at(-1).effectiveFrom, '2026-10-02');
  assert.deepEqual(archived.scheduleVersions.at(-1).slots, []);
  assert.deepEqual(ok(await app.call('course', archive)).scheduleVersions, archived.scheduleVersions);
  assert.deepEqual(ok(await app.call('course', { action: 'restore', courseId: created._id })).scheduleVersions, archived.scheduleVersions);
});

test('all cloud statistics select revision winner before status filtering and debit drives progress', async () => {
  const checkins = [
    { _id: 'legacy', _openid: 'owner', courseId: 'c', date: '2026-10-02' },
    { _id: 'latest', _openid: 'owner', courseId: 'c', date: '2026-10-02', status: 'absent', debit: 1, attendanceRevision: 1 },
    { _id: 'present', _openid: 'owner', courseId: 'c', date: '2026-10-01', status: 'attended', attendanceRevision: 1 },
    { _id: 'old', _openid: 'owner', courseId: 'c', date: '2026-09-30' },
    { _id: 'void', _openid: 'owner', courseId: 'c', date: '2026-09-30', status: 'voided', attendanceRevision: 2 }
  ];
  const app = createCloud({ courses: [course()], checkins });
  const overview = ok(await app.call('stats', { action: 'overview' }));
  assert.equal(overview.totalCheckins, 3); assert.equal(overview.consumedCount, 4); assert.equal(overview.monthAbsentCount, 1);
  assert.equal(ok(await app.call('stats', { action: 'weekly' })).total, 1);
  assert.equal(ok(await app.call('stats', { action: 'monthly' })).totalCheckins, 1);
  assert.equal(ok(await app.call('stats', { action: 'heatmap' })).totalCheckins, 1);
  assert.equal(ok(await app.call('stats', { action: 'trends', weeks: 1 })).trends[0].count, 1);
  const ranking = ok(await app.call('stats', { action: 'ranking' })).ranking[0];
  assert.equal(ranking.checkinCount, 3); assert.equal(ranking.consumedCount, 4); assert.equal(ranking.progress, 40); assert.equal(ranking.lastCheckinAt, '2026-10-01');
});

test('legacy note and cancel actions preserve versioned attendance and tombstone', async () => {
  const app = createCloud({ courses: [course()] });
  ok(await write(app, { debit: 1 }));
  const updated = ok(await app.call('checkin', { action: 'updateNotes', data: { courseId: 'c', date: '2026-10-02', notes: '更正' } }));
  assert.equal(updated.status, 'absent'); assert.equal(updated.debit, 1); assert.equal(updated.attendanceRevision, 2);
  ok(await app.call('checkin', { action: 'cancel', data: { courseId: 'c', date: '2026-10-02' } }));
  assert.equal(app.rows('checkins')[0].status, 'voided');
  assert.equal(app.rows('checkins')[0].attendanceRevision, 3);
  assert.equal((await app.call('checkin', { action: 'updateNotes', data: { courseId: 'c', date: '2026-10-02', notes: '不能复活' } })).code, 404);
});

test('monthly pending overview agrees with full history rather than treating prior confirmations as missing', async () => {
  const courses = [course({ scheduleVersions: [{ effectiveFrom: '2026-09-01', operationId: 'schedule', slots: [{ weekday: 5, start: '10:00', end: '11:00' }] }] })];
  const checkins = [{ _id: 'past', _openid: 'owner', courseId: 'c', date: '2026-09-04', status: 'attended', attendanceRevision: 1 }];
  const app = createCloud({ courses, checkins });
  const overview = ok(await app.call('stats', { action: 'overview' }));
  const monthly = ok(await app.call('stats', { action: 'monthly' }));
  assert.equal(monthly.pendingCount, overview.pendingCount);
});

for (const action of ['cancel', 'updateNotes']) {
  test(`legacy ${action} cannot mutate a canonical revision promoted while waiting for its transaction`, async () => {
    const gate = pauseOnce();
    let transactions = 0;
    const app = createCloud({ courses: [course()], checkins: [{ _id: 'legacy', _openid: 'owner', courseId: 'c', date: '2026-10-02' }] }, { beforeTransaction: () => { if (++transactions === 1) return gate.hold(); } });
    const pending = app.call('checkin', { action, data: { courseId: 'c', date: '2026-10-02', notes: '旧操作', operationId: 'legacy-op' } });
    await gate.reached;
    let promoted;
    try { promoted = ok(await write(app, { status: 'attended', debit: 1, notes: '新结果' })); } finally { gate.resume(); }
    const response = await pending;
    assert.equal(response.code, 409);
    const { courseName, ...rawPromoted } = promoted;
    assert.deepEqual(app.rows('checkins').find(item => item._id === promoted._id), rawPromoted);
    assert.equal(app.rows('checkins').length, 2);
    assert.equal(ok(await app.call('checkin', { action: 'checkin', data: { courseId: 'c', date: '2026-10-02', notes: '过期重试' } })).attendanceRevision, 1);
  });
}

test('legacy versioned note and cancel retries return stable revision including the voided response', async () => {
  const app = createCloud({ courses: [course()] });
  ok(await write(app, { status: 'attended', debit: 1 }));
  const note = { action: 'updateNotes', data: { courseId: 'c', date: '2026-10-02', notes: '修改', operationId: 'note-op' } };
  assert.equal(ok(await app.call('checkin', note)).attendanceRevision, 2);
  assert.equal(ok(await app.call('checkin', note)).attendanceRevision, 2);
  const undo = { action: 'cancel', data: { courseId: 'c', date: '2026-10-02', operationId: 'undo-op' } };
  assert.equal(ok(await app.call('checkin', undo)).attendanceRevision, 3);
  assert.equal(ok(await app.call('checkin', undo)).attendanceRevision, 3);
});

for (const action of ['cancel', 'updateNotes']) {
  test(`replaying an applied legacy ${action} cannot overwrite a newer device decision`, async () => {
    const app = createCloud({ courses: [course()] });
    ok(await write(app, { status: 'attended', debit: 1 }));
    const old = { action, data: { courseId: 'c', date: '2026-10-02', notes: 'Old', operationId: 'old-operation' } };
    assert.equal(ok(await app.call('checkin', old)).attendanceRevision, 2);
    ok(await write(app, { status: 'attended', debit: 1, notes: 'New', operationId: 'new-operation', expectedRevision: 2 }));
    const before = app.rows('checkins');
    assert.equal((await app.call('checkin', old)).code, 409);
    assert.deepEqual(app.rows('checkins'), before);
  });
}

test('replaying a mixed schedule edit never rolls back ordinary fields edited afterward', async () => {
  const app = createCloud({ courses: [course({ scheduleVersions: [{ effectiveFrom: '2026-09-01', operationId: 'first', slots: [] }] })] });
  const old = { action: 'update', courseId: 'c', operationId: 'schedule-edit', updates: { name: 'Old', scheduleChange: change({ effectiveFrom: '2026-10-03', expectedVersion: 'first' }) } };
  ok(await app.call('course', old));
  ok(await app.call('course', { action: 'update', courseId: 'c', updates: { name: 'New' } }));
  assert.equal(ok(await app.call('course', old)).name, 'New');
  assert.equal(app.rows('courses')[0].name, 'New');
});
