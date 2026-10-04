const { attendanceStatus, attendanceDebit, selectRecords } = require('./attendance');
// Calendar dates are always interpreted in China time.
function today(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
function addDays(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
function validateDate(date, maximum = today()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('请选择有效日期');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date < '1900-01-01') throw new Error('日期不存在');
  if (date > maximum) throw new Error('不能记录未来的课程');
  return date;
}
function lessonCount(value) {
  if (value === '' || value === undefined || value === null) return 0;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('课时必须是非负整数');
  return Number(value);
}
function normalizeCheckinNotes(value) {
  const notes = String(value || '').replace(/\s+/g, ' ').trim();
  if (notes.length > 60) throw new Error('课后备注最多填写 60 个字，请精简后保存');
  return notes;
}
function uniqueCheckins(checkins) {
  return selectRecords(checkins);
}
function isDatedRecord(item, date = today()) {
  if (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || item.date.startsWith('0000') || item.date > date) return false;
  const parsed = new Date(`${item.date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === item.date;
}
function monthOptions(date = today(), count = 24) {
  const [year, month] = date.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const value = new Date(Date.UTC(year, month - 1 - index, 1)).toISOString().slice(0, 7);
    return { value, label: `${value.slice(0, 4)} 年 ${Number(value.slice(5))} 月` };
  });
}
function summarize(courses, checkins, month = today().slice(0, 7), date = today()) {
  const rawCheckins = uniqueCheckins(checkins);
  const records = rawCheckins.filter(item => attendanceStatus(item) !== 'voided');
  const attended = records.filter(item => attendanceStatus(item) === 'attended');
  const dated = records.filter(item => isDatedRecord(item, date));
  const monthRecords = dated.filter(item => item.date.startsWith(month));
  const decorated = courses.map(course => {
    const items = records.filter(item => item.courseId === course._id);
    const present = items.filter(item => attendanceStatus(item) === 'attended');
    const monthItems = items.filter(item => isDatedRecord(item, date) && item.date.startsWith(month));
    const initialLessons = Number(course.initialLessons) || 0;
    const totalLessons = Number(course.totalLessons) || 0;
    const completedCount = initialLessons + present.length;
    const consumedCount = initialLessons + items.reduce((total, item) => total + attendanceDebit(item), 0);
    const todayRecord = items.find(item => item.date === date);
    return {
      ...course, initialLessons, totalLessons, completedCount, consumedCount, recordCount: present.length,
      absentCount: items.filter(item => attendanceStatus(item) === 'absent').length,
      cancelledCount: items.filter(item => attendanceStatus(item) === 'cancelled').length,
      monthCount: monthItems.filter(item => attendanceStatus(item) === 'attended').length,
      monthAbsentCount: monthItems.filter(item => attendanceStatus(item) === 'absent').length,
      monthConsumedLessons: monthItems.reduce((total, item) => total + attendanceDebit(item), 0),
      remainingCount: totalLessons ? Math.max(totalLessons - consumedCount, 0) : null,
      overdrawnCount: totalLessons ? Math.max(consumedCount - totalLessons, 0) : 0,
      progress: totalLessons ? Math.min(100, Math.round(consumedCount / totalLessons * 100)) : null,
      isCheckedIn: Boolean(todayRecord && attendanceStatus(todayRecord) === 'attended'),
      todayStatus: todayRecord ? attendanceStatus(todayRecord) : ''
    };
  });
  const dates = new Set(dated.filter(item => attendanceStatus(item) === 'attended').map(item => item.date));
  let cursor = dates.has(date) ? date : addDays(date, -1);
  let streakDays = 0;
  while (dates.has(cursor)) { streakDays++; cursor = addDays(cursor, -1); }
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(date, index - 6);
    return { date: day, label: day.slice(5).replace('-', '/'), count: attended.filter(item => item.date === day).length };
  });
  const peak = Math.max(1, ...week.map(item => item.count));
  week.forEach(item => { item.height = Math.round(item.count / peak * 100); });
  return {
    courses: decorated, checkins: records, rawCheckins,
    activeCourses: courses.filter(course => !course.isDeleted).length,
    totalLessons: attended.length + decorated.reduce((total, course) => total + course.initialLessons, 0),
    recordedLessons: attended.length,
    consumedCount: records.reduce((total, item) => total + attendanceDebit(item), 0) + decorated.reduce((total, course) => total + course.initialLessons, 0),
    absentCount: records.filter(item => attendanceStatus(item) === 'absent').length,
    cancelledCount: records.filter(item => attendanceStatus(item) === 'cancelled').length,
    initialLessons: decorated.reduce((total, course) => total + course.initialLessons, 0),
    monthLessons: monthRecords.filter(item => attendanceStatus(item) === 'attended').length,
    monthAbsentCount: monthRecords.filter(item => attendanceStatus(item) === 'absent').length,
    monthConsumedLessons: monthRecords.reduce((total, item) => total + attendanceDebit(item), 0),
    todayLessons: attended.filter(item => item.date === date).length,
    streakDays, week
  };
}
module.exports = { today, addDays, validateDate, lessonCount, normalizeCheckinNotes, uniqueCheckins, monthOptions, summarize, isDatedRecord };
