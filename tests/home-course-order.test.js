const test = require('node:test');
const assert = require('node:assert/strict');
const { client } = require('./helpers/client');
const { today, addDays } = require('../miniprogram/utils/records');
const attendanceView = require('../miniprogram/utils/attendance-view');

function scheduled(id, date, start = '10:00', end = '11:00') {
  return {
    _id: id, name: id, type: 'swim', totalLessons: 20,
    scheduleVersions: [{ effectiveFrom: date, slots: [{ weekday: new Date(date + 'T00:00:00Z').getUTCDay(), start, end }] }]
  };
}
function home(courses) {
  const c = client({ app: { ensureReady: async () => true } });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('env', 'owner');
  storage.update(state => { state.courses = courses; state.hasSnapshot = true; });
  const db = c.load('miniprogram/utils/db.js').db;
  c.load('miniprogram/pages/index/index.js');
  const definition = c.definition();
  const page = { ...definition, data: c.clone(definition.data), setData(values) { Object.assign(this.data, values); } };
  page.setData({ ready: true });
  return { page, storage, db };
}
const ids = courses => Array.from(courses, course => course._id);

test('home promotes today scheduled courses by start time while keeping ties and other courses in their original order', () => {
  const date = today();
  const { page, storage, db } = home([
    { _id: 'other-a', name: '普通课程 A', createdAt: 1 },
    scheduled('afternoon', date, '16:00', '17:00'),
    { _id: 'other-b', name: '普通课程 B', createdAt: 100 },
    scheduled('morning', date, '09:00', '10:00'),
    scheduled('same-time', date, '09:00', '10:00'),
    { ...scheduled('archived', date, '08:00', '09:00'), isDeleted: true, deletedAt: date }
  ]);
  const before = JSON.stringify(storage.read());
  const baseOrder = ids(db.snapshot().courses);
  page.render();
  assert.deepEqual(ids(page.data.courses), ['morning', 'same-time', 'afternoon', 'other-a', 'other-b']);
  assert.equal(JSON.stringify(storage.read()), before, 'Display sorting must not write the persisted base order');
  assert.deepEqual(ids(db.snapshot().courses), baseOrder, 'Other pages retain the original snapshot order');
});

test('home keeps the original order when no course is scheduled today, including legacy memos and manual check-ins', async () => {
  const date = today();
  const courses = [
    { _id: 'memo', name: '文字备忘', schedule: '每天 09:00' },
    scheduled('tomorrow', addDays(date, 1)),
    { _id: 'manual', name: '手动记课' }
  ];
  const { page, db } = home(courses);
  await db.addCheckin('manual');
  page.render();
  assert.deepEqual(ids(page.data.courses), ids(courses));
  assert.equal(page.data.courses[2].isCheckedIn, true);
  const empty = home([]).page;
  empty.render();
  assert.deepEqual(ids(empty.data.courses), []);
});

test('checking in a today course leaves it in the same position and preserves the one-tap action', async () => {
  const date = today();
  const { page, storage } = home([
    { _id: 'other', name: '普通课' },
    scheduled('afternoon', date, '16:00', '17:00'),
    scheduled('morning', date, '09:00', '10:00')
  ]);
  page.render();
  assert.deepEqual(ids(page.data.courses), ['morning', 'afternoon', 'other']);
  await page.onCheckin({ detail: { courseId: 'morning' } });
  assert.deepEqual(ids(page.data.courses), ['morning', 'afternoon', 'other']);
  assert.equal(page.data.courses[0].isCheckedIn, true);
  assert.equal(page.data.todayLessons, 1);
  assert.equal(storage.read().queue[0].payload.courseId, 'morning');
});

test('confirming absence or cancellation does not move today scheduled cards', async () => {
  const date = today();
  const { page, db } = home([
    { _id: 'other', name: '普通课' },
    scheduled('afternoon', date, '16:00', '17:00'),
    scheduled('morning', date, '09:00', '10:00')
  ]);
  await db.setAttendance('morning', { date, status: 'absent', debit: 0 });
  await db.setAttendance('afternoon', { date, status: 'cancelled', debit: 0 });
  page.render();
  assert.deepEqual(ids(page.data.courses), ['morning', 'afternoon', 'other']);
  assert.deepEqual(Array.from(page.data.courses.slice(0, 2), item => item.todayStatus), ['absent', 'cancelled']);
});

test('today priority follows the effective schedule version, not a future change or an old stopped arrangement', () => {
  const date = '2026-10-04';
  const other = { _id: 'other' };
  const notStarted = scheduled('not-started', date);
  notStarted.scheduleVersions[0].effectiveFrom = '2026-10-05';
  const stopped = scheduled('stopped', '2026-09-27');
  stopped.scheduleVersions.push({ effectiveFrom: date, slots: [] });
  const active = scheduled('active', '2026-09-27');
  active.scheduleVersions.unshift({ effectiveFrom: '2026-10-05', slots: [] });
  assert.equal(typeof attendanceView.sortHomeCourses, 'function');
  assert.deepEqual(ids(attendanceView.sortHomeCourses([other, stopped, notStarted, active], date)),
    ['active', 'other', 'stopped', 'not-started']);
});

test('priority changes only with the China calendar day, not as class start and end times pass', () => {
  const courses = [{ _id: 'other' }, scheduled('monday', '2026-10-05'), scheduled('sunday', '2026-10-04')];
  assert.equal(typeof attendanceView.sortHomeCourses, 'function');
  for (const instant of ['2026-10-03T16:01:00Z', '2026-10-04T03:30:00Z', '2026-10-04T15:59:59Z']) {
    assert.deepEqual(ids(attendanceView.sortHomeCourses(courses, today(new Date(instant)))), ['sunday', 'other', 'monday']);
  }
  assert.deepEqual(ids(attendanceView.sortHomeCourses(courses, today(new Date('2026-10-04T16:00:00Z')))),
    ['monday', 'other', 'sunday']);
});
