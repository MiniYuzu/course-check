const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { attendanceOverview } = require('../miniprogram/utils/attendance');

const now = new Date('2026-10-04T04:00:00Z');
const template = fs.readFileSync('miniprogram/pages/index/index.wxml', 'utf8');
const slot = weekday => ({ weekday, start: '10:00', end: '11:00' });
const course = (scheduleVersions = []) => ({ _id: 'c', name: '英孚', schedule: '周二、周六', scheduleVersions });
function visibleReminder(handler, overview) {
  const line = template.split('\n').find(item => item.includes(`bindtap="${handler}"`));
  assert.ok(line, `Missing reminder: ${handler}`);
  const condition = line.match(/wx:if="\{\{(.*?)\}\}"/);
  assert.ok(condition, 'Reminders must have an explicit visibility condition');
  return Boolean(vm.runInNewContext(condition[1], { hasData: true, ...overview }));
}

test('home hides empty pending reminder for a course with only a handwritten schedule', () => {
  const overview = attendanceOverview([course()], [], { now });
  assert.equal(overview.pendingCount, 0);
  assert.equal(overview.nextSession, null, 'A memo must not invent an actual class time');
  assert.equal(visibleReminder('onPendingTap', overview), false);
  assert.equal(visibleReminder('onNextTap', overview), false);
});

test('home keeps next class visible when there are no pending records', () => {
  const overview = attendanceOverview([course([{ effectiveFrom: '2026-10-05', slots: [slot(1)] }])], [], { now });
  assert.equal(overview.pendingCount, 0);
  assert.equal(overview.nextSession.relativeDay, '明天');
  assert.equal(overview.nextSession.courseName, '英孚');
  assert.equal(overview.nextSession.time, '10:00—11:00');
  assert.equal(visibleReminder('onPendingTap', overview), false);
  assert.equal(visibleReminder('onNextTap', overview), true);
});

test('home shows both reminders when an ended class is unconfirmed and a next class exists', () => {
  const overview = attendanceOverview([course([{ effectiveFrom: '2026-10-04', slots: [slot(0)] }])], [], { now });
  assert.equal(overview.pendingCount, 1);
  assert.equal(visibleReminder('onPendingTap', overview), true);
  assert.equal(visibleReminder('onNextTap', overview), true);
});

test('home removes pending reminder after the last result is confirmed without hiding next class', () => {
  const scheduled = course([{ effectiveFrom: '2026-10-04', slots: [slot(0)] }]);
  const result = { _id: 'r', courseId: 'c', date: '2026-10-04', status: 'absent', debit: 0 };
  const overview = attendanceOverview([scheduled], [result], { now });
  assert.equal(overview.pendingCount, 0);
  assert.equal(overview.nextSession.date, '2026-10-11');
  assert.equal(visibleReminder('onPendingTap', overview), false);
  assert.equal(visibleReminder('onNextTap', overview), true);
});

test('home can show an unresolved past class without inventing a next class after scheduling stops', () => {
  const overview = attendanceOverview([course([
    { effectiveFrom: '2026-10-04', slots: [slot(0)] },
    { effectiveFrom: '2026-10-05', slots: [] }
  ])], [], { now });
  assert.equal(overview.pendingCount, 1);
  assert.equal(visibleReminder('onPendingTap', overview), true);
  assert.equal(visibleReminder('onNextTap', overview), false);
});
