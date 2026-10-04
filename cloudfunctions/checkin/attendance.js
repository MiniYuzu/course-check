// Self-contained rules shared by the mini program and standalone cloud functions.
const DAY = 24 * 3600000;
function chinaDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function normalizeAttendance(input = {}, { allowVoided = false } = {}) {
  const status = input.status === undefined ? 'attended' : input.status;
  if (!['attended', 'absent', 'cancelled'].includes(status) && !(allowVoided && status === 'voided')) throw new Error('请选择出席、缺席或停课');
  const debit = status === 'attended' ? 1 : status === 'absent' && input.debit !== undefined ? input.debit : 0;
  if (debit !== 0 && debit !== 1) throw new Error('缺席只能选择不扣课时或扣 1 节');
  const reason = status === 'absent' ? String(input.reason || '').trim() : '';
  if (!['', '请假', '身体不适', '临时有事', '其他'].includes(reason)) throw new Error('请选择有效的缺席原因');
  const notes = String(input.notes || '').replace(/\s+/g, ' ').trim();
  if (notes.length > 60) throw new Error('课后备注最多填写 60 个字，请精简后保存');
  return { status, debit, reason, notes };
}
function normalizeScheduleChange(input, { today = chinaDate() } = {}) {
  if (!input || typeof input !== 'object') throw new Error('请设置上课安排');
  const effectiveFrom = input.effectiveFrom;
  const requestedOn = input.requestedOn === undefined ? today : input.requestedOn;
  if (!calendarDate(effectiveFrom) || !calendarDate(requestedOn) || !calendarDate(today)) throw new Error('请选择有效的排课日期');
  if (requestedOn > today) throw new Error('排课修改日期不能在未来');
  if (!Array.isArray(input.slots) || input.slots.length > 7) throw new Error('请选择每周上课时间');
  const seen = new Set();
  const slots = input.slots.map(item => {
    if (!item || !Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6 || seen.has(item.weekday)) throw new Error('同一课程每天最多安排 1 节');
    seen.add(item.weekday);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.start || '') || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.end || '') || item.end <= item.start) throw new Error('结束时间须晚于开始时间，暂不支持跨天课程');
    return { weekday: item.weekday, start: item.start, end: item.end };
  }).sort((a, b) => a.weekday - b.weekday);
  const expectedVersion = input.expectedVersion === undefined ? '' : input.expectedVersion;
  if (typeof expectedVersion !== 'string') throw new Error('上课安排版本无效，请重新打开课程');
  return { effectiveFrom, slots, requestedOn, expectedVersion };
}
function applyScheduleChange(course, input, { today = chinaDate(), operationId } = {}) {
  const existing = Array.isArray(course.scheduleVersions) ? course.scheduleVersions : [];
  if (operationId && existing.some(item => item.operationId === operationId)) return existing;
  const change = normalizeScheduleChange(input, { today });
  const history = [...existing].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const latest = history[history.length - 1];
  if (latest) {
    if (change.expectedVersion !== (latest.operationId || latest.effectiveFrom)) throw new Error('上课安排已更新，请重新打开后再修改');
    if (change.effectiveFrom <= change.requestedOn) throw new Error('已有安排的修改须从修改日之后生效，最早为明天');
  } else if (change.expectedVersion) throw new Error('上课安排已更新，请重新打开后再修改');
  return [...history.filter(item => item.effectiveFrom < change.effectiveFrom), {
    effectiveFrom: change.effectiveFrom, slots: change.slots, ...(operationId ? { operationId } : {})
  }];
}
function attendanceStatus(record = {}) {
  return ['attended', 'absent', 'cancelled', 'voided'].includes(record.status) ? record.status : 'attended';
}
function attendanceDebit(record = {}) {
  const status = attendanceStatus(record);
  return status === 'attended' ? 1 : status === 'absent' && Number(record.debit) === 1 ? 1 : 0;
}
function revision(record) {
  return Number.isSafeInteger(record.attendanceRevision) && record.attendanceRevision >= 0 ? record.attendanceRevision : 0;
}
function updatedTime(record) {
  const value = record.updatedAt;
  const time = typeof value === 'number' ? value : new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}
function selectRecords(checkins = []) {
  const records = new Map();
  checkins.forEach(item => {
    const key = `${item.courseId}|${item.date}`;
    const previous = records.get(key);
    if (!previous || revision(item) > revision(previous) || (revision(item) === revision(previous) && updatedTime(item) >= updatedTime(previous))) records.set(key, item);
  });
  return [...records.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.courseId).localeCompare(String(b.courseId)));
}

function dayNumber(date) { return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY); }
function dayDate(day) { return new Date(day * DAY).toISOString().slice(0, 10); }
function firstWeekday(day, weekday) {
  return day + (weekday - new Date(day * DAY).getUTCDay() + 7) % 7;
}
function scheduleSegments(course) {
  const versions = (Array.isArray(course.scheduleVersions) ? course.scheduleVersions : [])
    .filter(item => item && calendarDate(item.effectiveFrom) && Array.isArray(item.slots))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return versions.map((item, index) => ({
    from: dayNumber(item.effectiveFrom),
    to: index + 1 < versions.length ? dayNumber(versions[index + 1].effectiveFrom) - 1 : dayNumber('9999-12-31'),
    slots: item.slots.filter(slot => slot && Number.isInteger(slot.weekday) && slot.weekday >= 0 && slot.weekday <= 6 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.start) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.end) && slot.end > slot.start)
  }));
}
function archiveDay(course) {
  if (!course.isDeleted) return dayNumber('9999-12-31');
  if (calendarDate(course.deletedAt)) return dayNumber(course.deletedAt);
  const deleted = new Date(course.deletedAt || NaN);
  // An old archive without a known cutoff is never assigned invented dates.
  return Number.isFinite(deleted.getTime()) ? dayNumber(chinaDate(deleted)) : -Infinity;
}
function scheduledRow(course, date, slot, now, previous) {
  return {
    _id: `schedule:${course._id}:${date}`, key: `${course._id}|${date}`,
    courseId: course._id, courseName: course.name || '', courseType: course.type || '', courseIcon: course.icon || '',
    date, start: slot.start, end: slot.end, time: `${slot.start}—${slot.end}`,
    scheduled: true, source: 'schedule', debit: 0,
    status: now.getTime() >= Date.parse(`${date}T${slot.end}:00+08:00`) ? 'pending' : 'upcoming',
    attendanceRevision: previous ? revision(previous) : 0
  };
}
function courseTimeline(course, checkins = [], { now = new Date(), from, to } = {}) {
  if ((from !== undefined && !calendarDate(from)) || (to !== undefined && !calendarDate(to))) throw new Error('请选择有效的时间线日期范围');
  const explicitBounds = from !== undefined || to !== undefined;
  const first = from === undefined ? dayNumber('1900-01-01') : dayNumber(from);
  const last = to === undefined ? dayNumber(chinaDate(now)) + 7 : dayNumber(to);
  const winners = selectRecords(checkins.filter(item => item.courseId === course._id));
  const byDate = new Map(winners.map(item => [item.date, item]));
  const rows = new Map();
  scheduleSegments(course).forEach(segment => {
    const begin = Math.max(first, segment.from);
    const end = Math.min(last, segment.to, archiveDay(course));
    segment.slots.forEach(slot => {
      for (let day = firstWeekday(begin, slot.weekday); day <= end; day += 7) {
        const date = dayDate(day);
        const record = byDate.get(date);
        const row = scheduledRow(course, date, slot, now, record);
        if (record && attendanceStatus(record) !== 'voided') Object.assign(row, record, { status: attendanceStatus(record), debit: attendanceDebit(record), source: 'record' });
        rows.set(date, row);
      }
    });
  });
  winners.forEach(record => {
    if (attendanceStatus(record) === 'voided' || rows.has(record.date)) return;
    if (explicitBounds && (!calendarDate(record.date) || (from && record.date < from) || (to && record.date > to))) return;
    rows.set(record.date, {
      ...record, key: `${course._id}|${record.date}`, courseName: course.name || '', courseType: course.type || '', courseIcon: course.icon || '',
      status: attendanceStatus(record), debit: attendanceDebit(record), source: 'record', scheduled: false, start: '', end: '', time: ''
    });
  });
  return [...rows.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}
function nextCourseSession(course, records, now) {
  const date = chinaDate(now);
  const currentDay = dayNumber(date);
  const confirmed = new Set(records.filter(item => item.courseId === course._id && attendanceStatus(item) !== 'voided').map(item => item.date));
  let next = null;
  scheduleSegments(course).forEach(segment => segment.slots.forEach(slot => {
    let day = firstWeekday(Math.max(currentDay, segment.from), slot.weekday);
    while (day <= segment.to) {
      const scheduledDate = dayDate(day);
      const row = scheduledRow(course, scheduledDate, slot, now);
      if (row.status === 'upcoming' && !confirmed.has(scheduledDate)) {
        const distance = day - currentDay;
        row.relativeDay = distance === 0 ? '今天' : distance === 1 ? '明天' : `${distance}天后`;
        if (!next || `${row.date} ${row.start}` < `${next.date} ${next.start}`) next = row;
        break;
      }
      day += 7;
    }
  }));
  return next;
}
function attendanceOverview(courses, checkins = [], { now = new Date(), month = chinaDate(now).slice(0, 7) } = {}) {
  const date = chinaDate(now);
  const records = selectRecords(checkins);
  const active = courses.filter(course => !course.isDeleted);
  const pending = active.flatMap(course => courseTimeline(course, records, { now, to: date }).filter(item => item.status === 'pending'))
    .sort((a, b) => `${a.date} ${a.start} ${a.courseId}`.localeCompare(`${b.date} ${b.start} ${b.courseId}`));
  const next = active.map(course => nextCourseSession(course, records, now)).filter(Boolean)
    .sort((a, b) => `${a.date} ${a.start} ${a.courseId}`.localeCompare(`${b.date} ${b.start} ${b.courseId}`));
  return {
    pending, pendingCount: pending.length,
    monthPendingCount: pending.filter(item => item.date.startsWith(month)).length,
    monthAbsentCount: records.filter(item => attendanceStatus(item) === 'absent' && calendarDate(item.date) && item.date <= date && item.date.startsWith(month)).length,
    nextSession: next[0] || null
  };
}

module.exports = { normalizeAttendance, normalizeScheduleChange, applyScheduleChange, attendanceStatus, attendanceDebit, selectRecords, courseTimeline, attendanceOverview };
