const { isDatedRecord, today } = require('./records');
const { courseTimeline } = require('./attendance');
const filters = [{ value: 'all', label: '全部' }, { value: 'pending', label: '待确认' }, { value: 'attended', label: '出席' }, { value: 'absent', label: '缺席' }];
function sortHomeCourses(courses, date = today()) {
  // Use the day's plan, not its outcome, so confirming a class never moves its card.
  return courses.map((course, index) => ({
    course, index, slot: courseTimeline(course, [], { from: date, to: date })[0]
  })).sort((a, b) => {
    if (a.slot && b.slot) return a.slot.start.localeCompare(b.slot.start) || a.index - b.index;
    if (a.slot) return -1;
    if (b.slot) return 1;
    return a.index - b.index;
  }).map(item => item.course);
}
function courseNotes(course) {
  const notes = String(course?.notes || '');
  const legacyMemo = String(course?.schedule || '').trim();
  if (!legacyMemo || notes.split(/\r?\n/).some(line => line.trim() === legacyMemo)) return notes;
  return notes ? notes + '\n' + legacyMemo : legacyMemo;
}
function scheduleLabel(course, date = today()) {
  if (!course) return '';
  const versions = [...(course.scheduleVersions || [])].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (!versions.length) return '';
  if (course.isDeleted) return '已归档 · 上课安排已停止';
  const current = versions.filter(version => version.effectiveFrom <= date).pop();
  const version = current || versions[0];
  if (!version.slots.length) return '上课安排已停止';
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const arrangement = version.slots.map(slot => '每周' + weekdays[slot.weekday] + ' ' + slot.start + '—' + slot.end).join(' · ');
  return current ? arrangement : version.effectiveFrom + ' 开始 · ' + arrangement;
}
function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return {};
  const [year, number] = month.split('-').map(Number);
  return { from: month + '-01', to: month + '-' + new Date(Date.UTC(year, number, 0)).getUTCDate() };
}
function displayRow(row) {
  const valid = isDatedRecord(row, row.scheduled && row.status === 'upcoming' ? '9999-12-31' : today());
  const statusLabel = ({ pending: '待确认', upcoming: '待上课', attended: '出席', absent: '缺席', cancelled: '停课' })[row.status] || '出席';
  return { ...row, day: valid ? row.date.slice(8) : '—', weekday: valid ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(row.date + 'T00:00:00Z').getUTCDay()] : '待核对', dateLabel: valid ? row.date.replace(/-/g, '.') : String(row.date || '日期待核对'), statusLabel, canConfirm: valid && row.date <= today(), isOutcome: ['attended', 'absent', 'cancelled'].includes(row.status), debitLabel: row.status === 'absent' ? (row.debit ? '扣 1 节' : '不扣课时') : (row.status === 'cancelled' ? '不扣课时' : '') };
}
module.exports = { filters, monthBounds, displayRow, scheduleLabel, courseNotes, sortHomeCourses };
