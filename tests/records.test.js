const test = require('node:test');
const assert = require('node:assert/strict');
const rules = () => require('../miniprogram/utils/records');

test('baseline contributes to balance but never creates dated monthly records', () => {
  const { summarize } = rules();
  const value = summarize([{ _id: 'a', initialLessons: 10, totalLessons: 12 }], [
    { courseId: 'a', date: '2026-03-01' }, { courseId: 'a', date: '2026-03-31' }
  ], '2026-03', '2026-03-31');
  assert.equal(value.totalLessons, 12);
  assert.equal(value.monthLessons, 2);
  assert.equal(value.courses[0].remainingCount, 0);
});
test('month options do not roll February over on March 31', () => {
  assert.deepEqual(rules().monthOptions('2026-03-31', 3).map(x => x.value), ['2026-03', '2026-02', '2026-01']);
});
test('same-course duplicates count once, different courses count independently', () => {
  const v = rules().summarize([{ _id: 'a' }, { _id: 'b', isDeleted: true }], [
    { courseId: 'a', date: '2026-03-31' }, { courseId: 'a', date: '2026-03-31' }, { courseId: 'b', date: '2026-03-31' }
  ], '2026-03', '2026-03-31');
  assert.equal(v.totalLessons, 2);
  assert.equal(v.activeCourses, 1);
  assert.equal(v.monthLessons, 2);
  assert.equal(v.week[6].height, 100);
  assert.equal(v.week[0].height, 0);
});
test('strict integer and real past-date validation', () => {
  const r = rules();
  for (const invalid of ['1.9', '-1', '1e2', 'abc']) assert.throws(() => r.lessonCount(invalid));
  assert.equal(r.lessonCount(''), 0);
  assert.equal(r.validateDate('2024-02-29', '2026-03-31'), '2024-02-29');
  for (const invalid of ['2026-02-29', '2026-04-01', '2026-2-01']) assert.throws(() => r.validateDate(invalid, '2026-03-31'));
});
test('overdrawn and unlimited courses have explicit states, stale streak becomes zero', () => {
  const v = rules().summarize([{ _id: 'a', totalLessons: 1, initialLessons: 3 }, { _id: 'b' }], [], '2026-03', '2026-03-31');
  assert.equal(v.courses[0].overdrawnCount, 2);
  assert.equal(v.courses[1].progress, null);
  assert.equal(v.streakDays, 0);
});

test('invalid and future legacy dates do not affect period statistics; orphan history is retained in lifetime total', () => {
  const v = rules().summarize([{ _id: 'a', initialLessons: 5 }], [
    { courseId: 'a', date: '2026-02-30' }, { courseId: 'a', date: '2026-02-28' },
    { courseId: 'a', date: '2026-12-01' }, { courseId: 'orphan', date: '2026-02-01' }
  ], '2026-02', '2026-03-31');
  assert.equal(v.monthLessons, 2);
  assert.equal(v.totalLessons, 9);
});

test('lesson notes normalize to one line and reject over 60 characters instead of truncating', () => {
  const { normalizeCheckinNotes } = rules();
  assert.equal(normalizeCheckinNotes('  踢腿\n\t  练习  '), '踢腿 练习');
  assert.equal(normalizeCheckinNotes(' \n\t '), '');
  assert.equal(normalizeCheckinNotes(), '');
  assert.equal(normalizeCheckinNotes('课'.repeat(60)), '课'.repeat(60));
  assert.throws(() => normalizeCheckinNotes('课'.repeat(61)), /60/);
});

test('reading historical lesson notes leaves long original text intact', () => {
  const notes = '旧备注\n' + '课'.repeat(80);
  const v = rules().summarize([{ _id: 'a' }], [{ courseId: 'a', date: '2026-01-01', notes }]);
  assert.equal(v.checkins[0].notes, notes);
});
