const storage = require('./storage');
const { SyncQueue, view, call } = require('./sync-queue');
const { CONFIG } = require('./config');
const { generateId } = require('./util');
const { today, validateDate, lessonCount, normalizeCheckinNotes } = require('./records');
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
    await SyncQueue.enqueue('add_course', course);
    return course;
  },
  async updateCourse(id, input) {
    storage.requireSession();
    const courseId = resolveId(id);
    if (!view().courses.some(course => course._id === courseId)) throw new Error('未找到课程，请刷新');
    await SyncQueue.enqueue('update_course', { courseId, updates: courseFields(input, true) });
  },
  async archiveCourse(id) { return this.setArchived(id, true); },
  async restoreCourse(id) { return this.setArchived(id, false); },
  async setArchived(id, archived) {
    storage.requireSession();
    const courseId = resolveId(id);
    if (!view().courses.some(course => course._id === courseId)) throw new Error('未找到课程，请刷新');
    await SyncQueue.enqueue(archived ? 'archive_course' : 'restore_course', { courseId });
  },
  async deleteCourse(id) { return this.archiveCourse(id); },
  async getCheckins(id, { month } = {}) {
    return view().checkins.filter(item => (!id || item.courseId === resolveId(id)) && (!month || item.date.startsWith(month)));
  },
  async hasCheckedIn(id, date = today()) { return view().checkins.some(item => item.courseId === resolveId(id) && item.date === date); },
  async addCheckin(id, data = {}) {
    storage.requireSession();
    const courseId = resolveId(id);
    const date = validateDate(data.date || today());
    const current = view();
    const course = current.courses.find(item => item._id === courseId);
    if (!course || course.isDeleted) throw new Error('请先恢复归档课程再记课');
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
    await SyncQueue.enqueue('update_checkin_notes', { courseId, date, notes: normalizeCheckinNotes(notes) });
  },
  async cancelCheckin(id, date) {
    storage.requireSession();
    // 撤销按原始日期精确匹配，也允许纠正旧版保存的不存在/未来日期。
    if (typeof date !== 'string' || !date) throw new Error('请选择要撤销的上课记录');
    await SyncQueue.enqueue('cancel_checkin', { courseId: resolveId(id), date });
  },
  async getOverview() { return view(); },
  snapshot: view, onChange: storage.onChange, offChange: storage.offChange
};
module.exports = { db };
