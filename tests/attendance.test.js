const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../miniprogram/utils/attendance');
const NOW = new Date('2026-10-04T12:00:00Z'); // Sunday, 20:00 China time.
const slot = (weekday, start = '17:00', end = '18:00') => ({ weekday, start, end });
const version = (effectiveFrom, slots, operationId) => ({ effectiveFrom, slots, ...(operationId ? { operationId } : {}) });

test('attendance writes normalize statuses, exact lesson debits and short optional notes', () => {
  assert.equal(typeof rules.normalizeAttendance, 'function');
  assert.deepEqual(rules.normalizeAttendance(), { status: 'attended', debit: 1, reason: '', notes: '' });
  assert.deepEqual(rules.normalizeAttendance({ status: 'attended', debit: 0, reason: '请假', notes: '  今天\n 表现很好  ' }), { status: 'attended', debit: 1, reason: '', notes: '今天 表现很好' });
  assert.deepEqual(rules.normalizeAttendance({ status: 'absent' }), { status: 'absent', debit: 0, reason: '', notes: '' });
  assert.deepEqual(rules.normalizeAttendance({ status: 'absent', debit: 1, reason: '身体不适', notes: '在家休息' }), { status: 'absent', debit: 1, reason: '身体不适', notes: '在家休息' });
  assert.deepEqual(rules.normalizeAttendance({ status: 'cancelled', debit: 1 }), { status: 'cancelled', debit: 0, reason: '', notes: '' });
  for (const value of [{ status: 'pending' }, { status: 'absent', debit: 2 }, { status: 'absent', debit: '1' }, { status: 'absent', reason: 'unrecognized' }, { notes: '课'.repeat(61) }, { status: 'voided' }]) assert.throws(() => rules.normalizeAttendance(value));
  assert.deepEqual(rules.normalizeAttendance({ status: 'voided' }, { allowVoided: true }), { status: 'voided', debit: 0, reason: '', notes: '' });
  assert.equal(rules.attendanceStatus({}), 'attended');
  assert.equal(rules.attendanceDebit({}), 1);
  assert.equal(rules.attendanceDebit({ status: 'cancelled', debit: 1 }), 0);
});

test('schedule input strictly validates dates, one slot per weekday and same-day time ranges', () => {
  assert.equal(typeof rules.normalizeScheduleChange, 'function');
  const valid = { effectiveFrom: '2026-10-01', slots: [slot(6), slot(2)] };
  const actual = rules.normalizeScheduleChange(valid, { today: '2026-10-04' });
  assert.deepEqual(actual, { effectiveFrom: '2026-10-01', slots: [slot(2), slot(6)], requestedOn: '2026-10-04', expectedVersion: '' });
  assert.deepEqual(valid.slots.map(item => item.weekday), [6, 2]);
  assert.equal(rules.normalizeScheduleChange({ effectiveFrom: '2026-10-06', requestedOn: '2026-10-03', expectedVersion: 'v1', slots: [] }, { today: '2026-10-04' }).requestedOn, '2026-10-03');
  const invalid = [
    { effectiveFrom: '2026-02-30' }, { effectiveFrom: '1899-12-31' }, { effectiveFrom: '2026-2-03' },
    { requestedOn: '2026-10-05' }, { requestedOn: '2026-02-29' },
    { slots: [slot(2), slot(2)] }, { slots: [slot(-1)] }, { slots: [slot(7)] }, { slots: [slot('2')] },
    { slots: [slot(2, '7:00')] }, { slots: [slot(2, '24:00')] }, { slots: [slot(2, '12:60')] },
    { slots: [slot(2, '18:00', '17:00')] }, { slots: [slot(2, '18:00', '18:00')] },
    { slots: Array.from({ length: 8 }, (_, i) => slot(i)) }, { slots: '周二' }
  ];
  for (const patch of invalid) assert.throws(() => rules.normalizeScheduleChange({ ...valid, ...patch }, { today: '2026-10-04' }));
});

test('schedule edits preserve past versions, replace explicit future plans and reject stale tokens', () => {
  assert.equal(typeof rules.applyScheduleChange, 'function');
  const first = rules.applyScheduleChange({}, { effectiveFrom: '2026-09-01', slots: [slot(2)] }, { today: '2026-10-04', operationId: 'v1' });
  assert.deepEqual(first, [version('2026-09-01', [slot(2)], 'v1')]);
  const course = { scheduleVersions: first };
  const second = rules.applyScheduleChange(course, { effectiveFrom: '2026-10-06', requestedOn: '2026-10-04', expectedVersion: 'v1', slots: [slot(4)] }, { today: '2026-10-04', operationId: 'v2' });
  assert.deepEqual(second, [...first, version('2026-10-06', [slot(4)], 'v2')]);
  assert.deepEqual(course.scheduleVersions, first);
  assert.throws(() => rules.applyScheduleChange(course, { effectiveFrom: '2026-10-04', slots: [slot(4)], expectedVersion: 'v1' }, { today: '2026-10-04', operationId: 'bad' }), /明天|生效|之后/);
  assert.throws(() => rules.applyScheduleChange({ scheduleVersions: second }, { effectiveFrom: '2026-10-07', slots: [], expectedVersion: 'v1' }, { today: '2026-10-04', operationId: 'stale' }), /更新|重新|过期/);
  assert.throws(() => rules.applyScheduleChange(course, { effectiveFrom: '2026-10-06', slots: [] }, { today: '2026-10-04', operationId: 'missing-token' }));
  assert.deepEqual(rules.applyScheduleChange({ scheduleVersions: second }, { effectiveFrom: '2026-10-06', slots: [], expectedVersion: 'stale' }, { today: '2026-10-05', operationId: 'v2' }), second);
  const replaced = rules.applyScheduleChange({ scheduleVersions: second }, { effectiveFrom: '2026-10-05', slots: [], expectedVersion: 'v2' }, { today: '2026-10-04', operationId: 'v3' });
  assert.deepEqual(replaced, [...first, version('2026-10-05', [], 'v3')]);
  const offline = rules.applyScheduleChange(course, { effectiveFrom: '2026-10-02', requestedOn: '2026-10-01', expectedVersion: 'v1', slots: [slot(5)] }, { today: '2026-10-04', operationId: 'offline' });
  assert.equal(offline[1].effectiveFrom, '2026-10-02');
});

test('scheduled lessons become pending only at the China-time end, including midnight boundaries', () => {
  assert.equal(typeof rules.courseTimeline, 'function');
  const course = { _id: 'a', name: '游泳', initialLessons: 20, scheduleVersions: [version('2026-10-04', [slot(0, '19:00', '20:00')])] };
  const before = rules.courseTimeline(course, [], { now: new Date('2026-10-04T11:59:59Z'), from: '2026-10-01', to: '2026-10-04' });
  assert.equal(before.length, 1);
  assert.equal(before[0].status, 'upcoming');
  const after = rules.courseTimeline(course, [], { now: NOW, from: '2026-10-01', to: '2026-10-04' });
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'pending');
  assert.equal(after[0].date, '2026-10-04');
  assert.equal(after[0].start, '19:00');
  assert.equal(after[0].end, '20:00');
  assert.equal(after[0].source, 'schedule');
  const monday = { _id: 'b', scheduleVersions: [version('2026-10-05', [slot(1, '00:00', '00:30')])] };
  assert.equal(rules.courseTimeline(monday, [], { now: new Date('2026-10-04T16:29:59Z') })[0].status, 'upcoming');
  assert.equal(rules.courseTimeline(monday, [], { now: new Date('2026-10-04T16:30:00Z') }).find(item => item.date === '2026-10-05').status, 'pending');
});

test('timeline spans schedule adoption onward despite later check-ins, and merges actual outcomes', () => {
  const course = { _id: 'a', initialLessons: 100, schedule: '每周二', scheduleVersions: [version('2026-09-22', [slot(2), slot(6)])] };
  const records = [
    { _id: 'attend', courseId: 'a', date: '2026-10-03', notes: '学会换气' },
    { _id: 'absent', courseId: 'a', date: '2026-09-29', status: 'absent', debit: 1, reason: '请假', notes: '旅行' },
    { _id: 'cancelled', courseId: 'a', date: '2026-09-26', status: 'cancelled' },
    { _id: 'extra', courseId: 'a', date: '2026-09-30' }
  ];
  const timeline = rules.courseTimeline(course, records, { now: NOW, from: '2026-09-01', to: '2026-10-04' });
  assert.deepEqual(timeline.map(item => [item.date, item.status]), [
    ['2026-10-03', 'attended'], ['2026-09-30', 'attended'], ['2026-09-29', 'absent'], ['2026-09-26', 'cancelled'], ['2026-09-22', 'pending']
  ]);
  assert.equal(timeline[0].notes, '学会换气');
  assert.equal(timeline[0].scheduled, true);
  assert.equal(timeline[1].scheduled, false);
  assert.equal(timeline[2].debit, 1);
  assert.equal(timeline[2].reason, '请假');
  assert.equal(rules.courseTimeline({ _id: 'manual', schedule: '每周二', initialLessons: 10 }, [], { now: NOW }).length, 0);
});

test('future schedule versions do not rewrite past dates and empty slots stop generation', () => {
  const course = { _id: 'a', scheduleVersions: [version('2026-09-29', [slot(2)]), version('2026-10-05', [slot(4)]), version('2026-10-09', [])] };
  const timeline = rules.courseTimeline(course, [], { now: NOW, from: '2026-09-01', to: '2026-10-31' });
  assert.deepEqual(timeline.map(item => [item.date, item.status]), [['2026-10-08', 'upcoming'], ['2026-09-29', 'pending']]);
});

test('voided results suppress old duplicates but expose the original slot as pending again', () => {
  const course = { _id: 'a', scheduleVersions: [version('2026-10-01', [slot(6)])] };
  const records = [{ _id: 'void', courseId: 'a', date: '2026-10-03', status: 'voided', attendanceRevision: 2 }, { _id: 'legacy', courseId: 'a', date: '2026-10-03' }];
  const result = rules.courseTimeline(course, records, { now: NOW, to: '2026-10-04' });
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'pending');
  assert.equal(result[0].attendanceRevision, 2);
  assert.equal(rules.courseTimeline({ _id: 'a' }, records, { now: NOW }).length, 0);
});

test('archived courses stop automatic generation at their China archive date but keep real history', () => {
  const course = { _id: 'a', isDeleted: true, deletedAt: Date.parse('2026-10-02T16:30:00Z'), scheduleVersions: [version('2026-09-26', [slot(2), slot(6)])] };
  const timeline = rules.courseTimeline(course, [{ courseId: 'a', date: '2026-10-04', status: 'absent', reason: '请假' }], { now: new Date('2026-10-11T12:00:00Z'), to: '2026-10-31' });
  assert.deepEqual(timeline.map(item => item.date), ['2026-10-04', '2026-10-03', '2026-09-29', '2026-09-26']);
});

test('invalid legacy dates and notes survive all-history display but not a month filter', () => {
  const records = [{ _id: 'bad-date', courseId: 'a', date: '2026-02-30', notes: '旧'.repeat(80) }, { _id: 'no-date', courseId: 'a', notes: '日期缺失' }];
  const history = rules.courseTimeline({ _id: 'a' }, records, { now: NOW });
  assert.equal(history.length, 2);
  assert.equal(history.find(item => item._id === 'bad-date').notes.length, 80);
  assert.deepEqual(rules.courseTimeline({ _id: 'a' }, records, { now: NOW, from: '2026-02-01', to: '2026-02-28' }), []);
});

test('overview shows all active pending lessons and the earliest upcoming course across every course', () => {
  assert.equal(typeof rules.attendanceOverview, 'function');
  const courses = [
    { _id: 'later', name: '钢琴', scheduleVersions: [version('2026-09-29', [slot(2)])] },
    { _id: 'next', name: '游泳', scheduleVersions: [version('2026-09-22', [slot(1, '09:00', '10:00'), slot(2)])] },
    { _id: 'archived', name: '旧课', isDeleted: true, deletedAt: NOW.getTime(), scheduleVersions: [version('2026-09-01', [slot(0, '20:30', '21:30')])] }
  ];
  const records = [{ courseId: 'next', date: '2026-09-29' }, { courseId: 'archived', date: '2026-10-01', status: 'absent', debit: 1 }];
  const overview = rules.attendanceOverview(courses, records, { now: NOW, month: '2026-10' });
  assert.deepEqual(overview.pending.map(item => [item.courseId, item.date]), [['next', '2026-09-22'], ['next', '2026-09-28'], ['later', '2026-09-29']]);
  assert.equal(overview.pendingCount, 3);
  assert.equal(overview.monthPendingCount, 0);
  assert.equal(overview.monthAbsentCount, 1);
  assert.equal(overview.nextSession.courseId, 'next');
  assert.equal(overview.nextSession.courseName, '游泳');
  assert.equal(overview.nextSession.date, '2026-10-05');
  assert.equal(overview.nextSession.relativeDay, '明天');
  assert.equal(overview.nextSession.time, '09:00—10:00');
});

test('next-session labels use China dates and skip confirmed slots including absence and cancellation', () => {
  const course = { _id: 'a', scheduleVersions: [version('2026-10-01', [slot(0, '20:30', '21:30'), slot(2)])] };
  assert.equal(rules.attendanceOverview([course], [], { now: NOW }).nextSession.relativeDay, '今天');
  const absent = { courseId: 'a', date: '2026-10-04', status: 'absent' };
  assert.equal(rules.attendanceOverview([course], [absent], { now: NOW }).nextSession.relativeDay, '2天后');
  const cancelled = { courseId: 'a', date: '2026-10-06', status: 'cancelled' };
  assert.equal(rules.attendanceOverview([course], [absent, cancelled], { now: NOW }).nextSession.date, '2026-10-11');
  assert.equal(rules.attendanceOverview([{ ...course, scheduleVersions: [] }], [], { now: NOW }).nextSession, null);
});

test('overview does not drop old pending dates or expand thousands of future years to find a slot', () => {
  const old = { _id: 'old', scheduleVersions: [version('2020-01-01', [slot(3)])] };
  const far = { _id: 'far', scheduleVersions: [version('9999-01-01', [slot(1)])] };
  assert.equal(rules.attendanceOverview([old], [], { now: NOW }).pending[0].date, '2020-01-01');
  const future = rules.attendanceOverview([far], [], { now: NOW });
  assert.equal(future.pendingCount, 0);
  assert.ok(future.nextSession.date.startsWith('9999-01-'));
  assert.equal(rules.courseTimeline(far, [], { now: NOW }).length, 0);
});
