const storage = require('./storage');
const { SyncQueue, view, call } = require('./sync-queue');
const { CONFIG } = require('./config');
const { generateId } = require('./util');
const { today, validateDate, lessonCount, normalizeCheckinNotes } = require('./records');
const { normalizeAttendance, normalizeScheduleChange, applyScheduleChange, attendanceStatus } = require('./attendance');
let refreshing = null;
function resolveId(id) { return storage.read().aliases[id] || id; }
function courseFields(input, partial = false) {
  const data = {};
  if (!partial || input.name !== undefined) {
    data.name = String(input.name || '').trim();
    if (!data.name || data.name.length > 50) throw new Error('课程名称请填写 1～50 个字');
  }
  if (!partial || input.type !== undefined) {
    data.type = input.type || 'other';
    const config = Object.values(CONFIG.COURSE_TYPES).find(item => item.type === data.type);
    if (!config) throw new Error('请选择课程类型');
    data.icon = config.icon;
  }
  ['initialLessons', 'totalLessons'].forEach(field => { if (!partial || input[field] !== undefined) data[field] = lessonCount(input[field]); });
  ['schedule', 'notes'].forEach(field => {
    if (!partial || input[field] !== undefined) {
      data[field] = String(input[field] || '').trim();
      if (data[field].length > (field === 'notes' ? 500 : 100)) throw new Error('课程说明过长，请精简后保存');
    }
  });
  if (input.scheduleChange !== undefined) data.scheduleChange = normalizeScheduleChange(input.scheduleChange, { today: today() });
  return data;
}
async function allPages(name, key, extra, session) {
  const records = [];
  const seen = new Set();
  let expectedTotal;
  for (let page = 1; ; page++) {
    const data = await call(name, { action: 'list', ...extra, page, limit: 50 }, session);
    const batch = data[key];
    if (!Array.isArray(batch) || !Number.isFinite(data.total)) throw new Error('云函数版本不匹配，请先部署全部云函数');
    if (expectedTotal === undefined) expectedTotal = data.total;
    if (expectedTotal !== data.total || batch.some(item => item._id && seen.has(item._id))) {
      const error = new Error('读取期间记录有变化，正在重新读取'); error.code = 'DATA_CHANGED'; throw error;
    }
    batch.forEach(item => { if (item._id) seen.add(item._id); });
    records.push(...batch);
    if (records.length === data.total) return records;
    if (records.length > data.total) throw new Error('云端分页结果不完整，请重试');
    if (!batch.length) throw new Error('历史记录读取不完整，请重试');
  }
}
const db = {
  async refresh() {
    const session = storage.requireSession();
    if (refreshing && refreshing.key === session.key) return refreshing.promise;
    const promise = (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const revision = storage.read().cloudRevision;
          let courses, checkins;
          try {
            [courses, checkins] = await Promise.all([
              allPages('course', 'courses', { includeArchived: true, includeStats: false }, session), allPages('checkin', 'checkins', {}, session)
            ]);
          } catch (error) { if (error.code === 'DATA_CHANGED') continue; throw error; }
          if (storage.getSession()?.key !== session.key) throw new Error('登录身份已变化');
          if (storage.read().cloudRevision !== revision) continue;
          storage.update(state => {
            // A lost add response is correlated by immutable operationId, never by name.
            for (const operation of state.queue.filter(item => item.type === 'add_course')) {
              const remote = courses.find(course => course.operationId === operation._id);
              if (!remote) continue;
              const localId = operation.payload._id;
              state.aliases[localId] = remote._id;
              state.queue.forEach(item => { if (item.payload.courseId === localId) item.payload.courseId = remote._id; });
            }
            state.courses = courses; state.checkins = checkins; state.hasSnapshot = true; state.lastRefresh = Date.now();
          });
          return { ...view(), offline: false };
        }
        throw new Error('同步仍在更新记录，请稍后刷新以读取完整历史');
      } catch (error) {
        if (storage.getSession()?.key !== session.key) throw error;
        const state = storage.read();
        if (!state.hasSnapshot && !state.queue.length) throw error;
        return { ...view(), offline: true, error: error.message || '无法连接云端，显示本机记录' };
      }
    })();
    refreshing = { key: session.key, promise };
    try { return await promise; } finally { if (refreshing?.promise === promise) refreshing = null; }
  },
  async refreshCoursesFromCloud() { return this.refresh(); },
  async getCourses(forceRefresh = false, { includeArchived = false } = {}) {
    if (forceRefresh) await this.refresh();
    return view().courses.filter(course => includeArchived || !course.isDeleted);
  },
  async getCourse(id) { return view().courses.find(course => course._id === resolveId(id)) || null; },
  async addCourse(input) {
    storage.requireSession();
    const course = { ...courseFields(input), _id: `local_${generateId()}`, isDeleted: false, createdAt: Date.now() };
    if (course.scheduleChange !== undefined) applyScheduleChange(course, course.scheduleChange, { today: today() });
    await SyncQueue.enqueue('add_course', course);
    return this.getCourse(course._id);
  },
  async updateCourse(id, input) {
    storage.requireSession();
    const courseId = resolveId(id);
    const course = view().courses.find(course => course._id === courseId);
    if (!course) throw new Error('未找到课程，请刷新');
    const updates = courseFields(input, true);
    if (updates.scheduleChange !== undefined) applyScheduleChange(course, updates.scheduleChange, { today: today() });
    await SyncQueue.enqueue('update_course', { courseId, updates });
  },
  async archiveCourse(id) { return this.setArchived(id, true); },
  async restoreCourse(id) { return this.setArchived(id, false); },
  async setArchived(id, archived) {
    storage.requireSession();
    const courseId = resolveId(id);
    const course = view().courses.find(course => course._id === courseId);
    if (!course) throw new Error('未找到课程，请刷新');
    await SyncQueue.enqueue(archived ? 'archive_course' : 'restore_course', { courseId, requestedOn: today(), scheduleRequired: Boolean(course.scheduleVersions && course.scheduleVersions.length) });
  },
  async deleteCourse(id) { return this.archiveCourse(id); },
  async getCheckins(id, { month } = {}) {
    return view().checkins.filter(item => (!id || item.courseId === resolveId(id)) && (!month || item.date.startsWith(month)));
  },
  async hasCheckedIn(id, date = today()) { return view().checkins.some(item => item.courseId === resolveId(id) && item.date === date && attendanceStatus(item) === 'attended'); },
  async setAttendance(id, input = {}) {
    storage.requireSession();
    const courseId = resolveId(id);
    const date = validateDate(input.date || today());
    const attendance = normalizeAttendance(input, { allowVoided: true });
    if (input.debit !== undefined && input.debit !== attendance.debit) throw new Error('扣课时选择与上课结果不一致');
    const snapshot = view();
    const course = snapshot.courses.find(item => item._id === courseId);
    const existing = snapshot.rawCheckins.find(item => item.courseId === courseId && item.date === date);
    if (!course || (course.isDeleted && (!existing || attendanceStatus(existing) === 'voided'))) throw new Error('请先恢复归档课程再记录新结果');
    const expectedRevision = existing && existing.attendanceRevision || 0;
    if (input.expectedRevision !== undefined && input.expectedRevision !== expectedRevision) throw new Error('记录已更新，请刷新后重新确认');
    const record = { _id: existing && existing._id || `local_${generateId()}`, courseId, date, ...attendance, expectedRevision, attendanceRevision: expectedRevision + 1 };
    await SyncQueue.enqueue('set_attendance', record);
    return view().rawCheckins.find(item => item.courseId === courseId && item.date === date);
  },
  async addCheckin(id, data = {}) {
    storage.requireSession();
    const courseId = resolveId(id);
    const date = validateDate(data.date || today());
    const current = view();
    const course = current.courses.find(item => item._id === courseId);
    if (!course || course.isDeleted) throw new Error('请先恢复归档课程再记课');
    const existing = current.rawCheckins.find(item => item.courseId === courseId && item.date === date);
    if ((course.scheduleVersions && course.scheduleVersions.length) || (existing && existing.attendanceRevision)) {
      if (existing && attendanceStatus(existing) === 'attended') throw new Error('这一天已记录，不会重复扣课时');
      return this.setAttendance(courseId, { ...data, date, status: 'attended', debit: 1 });
    }
    if (current.checkins.some(item => item.courseId === courseId && item.date === date)) throw new Error('这一天已记录，不会重复扣课时');
    const record = { _id: `local_${generateId()}`, courseId, date, notes: normalizeCheckinNotes(data.notes) };
    await SyncQueue.enqueue('checkin', record);
    return record;
  },
  async updateCheckinNotes(id, date, notes) {
    storage.requireSession();
    const courseId = resolveId(id);
    const current = view();
    if (!current.courses.some(course => course._id === courseId) ||
        !current.checkins.some(record => record.courseId === courseId && record.date === date)) throw new Error('未找到这次上课记录，请刷新');
    // 修改原记录，不新增课时；归档课程和旧日期的已有记录也可更正备注。
    const existing = current.rawCheckins.find(item => item.courseId === courseId && item.date === date);
    if (existing && existing.attendanceRevision) return this.setAttendance(courseId, { ...existing, notes, expectedRevision: existing.attendanceRevision });
    await SyncQueue.enqueue('update_checkin_notes', { courseId, date, notes: normalizeCheckinNotes(notes) });
  },
  async cancelCheckin(id, date) {
    storage.requireSession();
    // 撤销按原始日期精确匹配，也允许纠正旧版保存的不存在/未来日期。
    if (typeof date !== 'string' || !date) throw new Error('请选择要撤销的上课记录');
    const existing = view().rawCheckins.find(item => item.courseId === resolveId(id) && item.date === date);
    if (existing && existing.attendanceRevision) return this.setAttendance(id, { date, status: 'voided', debit: 0, expectedRevision: existing.attendanceRevision });
    await SyncQueue.enqueue('cancel_checkin', { courseId: resolveId(id), date });
  },
  async getOverview() { return view(); },
  async adoptCloudResult(operationId) {
    const session = storage.requireSession();
    const attendanceTypes = ['set_attendance', 'update_checkin_notes', 'cancel_checkin'];
    const matches = head => head && head._id === operationId && head.status === 'failed' && head.lastErrorCode === 409 && (attendanceTypes.includes(head.type) || (head.type === 'update_course' && head.payload.updates.scheduleChange));
    if (!matches((await SyncQueue.getQueue())[0])) throw new Error('冲突操作已变化，请重新查看失败记录');
    const refreshed = await this.refresh();
    if (refreshed.offline) throw new Error('请先联网成功刷新云端记录，再确认采用云端结果');
    if (storage.getSession()?.key !== session.key || !matches((await SyncQueue.getQueue())[0])) throw new Error('身份或失败操作已变化，请重新确认');
    let discardedCount = 0;
    storage.update(state => {
      if (!matches(state.queue[0])) throw new Error('失败操作已变化，请重新确认');
      const head = state.queue[0];
      const removedIds = new Set([head._id]);
      const discarded = state.queue.filter(item => {
        if (item._id === head._id) return true;
        if (item.payload.courseId !== head.payload.courseId) return false;
        if (attendanceTypes.includes(head.type)) return [...attendanceTypes, 'checkin'].includes(item.type) && item.payload.date === head.payload.date;
        const change = item.type === 'update_course' && item.payload.updates.scheduleChange;
        if (change && removedIds.has(change.expectedVersion)) { removedIds.add(item._id); return true; }
        return false;
      });
      const ids = new Set(discarded.map(item => item._id));
      state.discardedOperations = [...(state.discardedOperations || []), ...discarded.map(item => ({ ...item, discardedAt: Date.now(), discardedReason: '用户确认采用刷新后的云端结果' }))];
      state.queue = state.queue.filter(item => !ids.has(item._id));
      discardedCount = discarded.length;
    }, session.key);
    return { discardedCount };
  },
  snapshot: view, onChange: storage.onChange, offChange: storage.offChange
};
module.exports = { db };
