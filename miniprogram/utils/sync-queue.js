const storage = require('./storage');
const { generateId } = require('./util');
const { summarize } = require('./records');
let running = null;
let runtime = null;

function effectiveQueue(state = storage.read()) {
  return state.queue.map(item => runtime && runtime.key === storage.getSession()?.key && runtime.id === item._id
    ? { ...item, status: runtime.status, lastError: runtime.error || item.lastError }
    : item);
}

function applyOperation(state, item, result) {
  const payload = item.payload;
  if (item.type === 'add_course') {
    const course = result || payload;
    if (!state.courses.some(value => value._id === course._id || value.operationId === item._id)) state.courses.unshift({ ...course });
  } else if (item.type === 'update_course') {
    state.courses = state.courses.map(course => course._id === payload.courseId ? { ...course, ...payload.updates } : course);
  } else if (item.type === 'archive_course' || item.type === 'restore_course') {
    state.courses = state.courses.map(course => course._id === payload.courseId ? { ...course, isDeleted: item.type === 'archive_course' } : course);
  } else if (item.type === 'checkin') {
    if (!state.checkins.some(record => record.courseId === payload.courseId && record.date === payload.date)) state.checkins.push({ ...payload, ...(result || {}), _syncStatus: result ? 'synced' : item.status });
  } else if (item.type === 'update_checkin_notes') {
    state.checkins = state.checkins.map(record => record.courseId === payload.courseId && record.date === payload.date ? {
      ...record, notes: payload.notes,
      _syncStatus: result ? 'synced' : record._syncStatus === 'failed' || item.status === 'failed' ? 'failed' : item.status
    } : record);
  } else if (item.type === 'cancel_checkin') {
    state.checkins = state.checkins.filter(record => record.courseId !== payload.courseId || record.date !== payload.date);
  } else throw new Error(`不支持的同步操作：${item.type}`);
}
function view(state = storage.read()) {
  const projected = { courses: state.courses.map(item => ({ ...item })), checkins: state.checkins.map(item => ({ ...item })) };
  effectiveQueue(state).forEach(item => {
    applyOperation(projected, item);
    const id = item.payload.courseId || item.payload._id;
    const course = projected.courses.find(value => value._id === (state.aliases[id] || id));
    if (course) course._syncStatus = item.status === 'failed' || course._syncStatus === 'failed' ? 'failed' : item.status;
  });
  return { ...summarize(projected.courses, projected.checkins), hasSnapshot: state.hasSnapshot, lastRefresh: state.lastRefresh, lastSync: state.lastSync };
}
async function call(name, data, session = name === 'login' ? null : storage.requireSession()) {
  if (session && storage.getSession()?.key !== session.key) throw new Error('登录身份已变化，原账户数据仍保留');
  // 预期身份仅作串账号保护；云端授权仍使用可信微信上下文。
  const { result } = await wx.cloud.callFunction({ name, data: session ? { ...data, expectedOpenid: session.openid } : data });
  if (session && storage.getSession()?.key !== session.key) throw new Error('登录身份已变化，原账户数据仍保留');
  if (!result || !result.success) {
    if (session && result && result.code === 401) {
      storage.deactivate();
      throw new Error('登录身份已变化，请重新连接；原账户数据仍保留');
    }
    const error = new Error(result && result.message || '云端未确认，请重试');
    error.code = result && result.code;
    throw error;
  }
  return result.data;
}
function request(item, session) {
  const payload = item.payload;
  switch (item.type) {
    case 'add_course': return call('course', { action: 'add', data: { ...payload, operationId: item._id } }, session);
    case 'update_course': return call('course', { action: 'update', courseId: payload.courseId, updates: payload.updates }, session);
    case 'archive_course': return call('course', { action: 'archive', courseId: payload.courseId }, session);
    case 'restore_course': return call('course', { action: 'restore', courseId: payload.courseId }, session);
    case 'checkin': return call('checkin', { action: 'checkin', data: payload }, session);
    case 'update_checkin_notes': return call('checkin', { action: 'updateNotes', data: payload }, session);
    case 'cancel_checkin': return call('checkin', { action: 'cancel', data: payload }, session);
    default: throw new Error('未知同步操作，已保留数据');
  }
}
function acknowledge(state, item, result) {
  if (item.type === 'add_course') {
    if (!result || !result._id) throw new Error('云端未返回课程编号，已保留待同步数据');
    const localId = item.payload._id;
    const remoteId = result._id;
    state.aliases[localId] = remoteId;
    state.courses = state.courses.filter(course => course._id !== localId);
    state.checkins.forEach(record => { if (record.courseId === localId) record.courseId = remoteId; });
    state.queue.forEach(operation => { if (operation.payload.courseId === localId) operation.payload.courseId = remoteId; });
  }
  applyOperation(state, item, result);
  state.queue = state.queue.filter(operation => operation._id !== item._id);
  state.cloudRevision++;
  state.lastSync = Date.now();
}
async function performSync() {
  const session = storage.getSession();
  if (!session) return { success: false, synced: 0, failed: 0, message: '请先联网登录' };
  let synced = 0;
  try {
    if (!storage.read(session.key).queue.length) return { success: true, synced, failed: 0 };
    const identity = await call('login', {});
    if (storage.getSession()?.key !== session.key) throw new Error('当前账户已切换，原账户同步已停止');
    if (identity.openid !== session.openid) {
      storage.deactivate();
      throw new Error('登录身份已变化，请重新进入；原账户数据仍保留');
    }
    while (storage.getSession()?.key === session.key) {
      const item = storage.read(session.key).queue[0];
      if (!item) { runtime = null; storage.notify(); return { success: true, synced, failed: 0 }; }
      // In-flight is runtime state; the durable operation remains replayable after a crash.
      runtime = { key: session.key, id: item._id, status: 'syncing' };
      storage.notify();
      try {
        // Even a write with a lost response invalidates an in-flight list snapshot.
        storage.update(state => { state.cloudRevision++; }, session.key);
        const result = await request(item, session);
        storage.update(state => acknowledge(state, item, result), session.key);
        synced++;
      } catch (error) {
        runtime = { key: session.key, id: item._id, status: 'failed', error: error.message || error.errMsg || '同步失败' };
        try {
          storage.update(state => {
            const failed = state.queue.find(operation => operation._id === item._id);
            if (failed) { failed.status = 'failed'; failed.lastError = runtime.error; failed.retryCount++; }
          }, session.key);
        } catch (storageError) { runtime.error = `本机存储失败，原操作仍保留：${storageError.message}`; }
        storage.notify();
        // Later operations may depend on this one. Never leapfrog a failure.
        return { success: false, synced, failed: 1, message: error.message || '同步失败，请重试' };
      }
    }
    return { success: false, synced, failed: 0, message: '登录身份已变化，请重新进入' };
  } catch (error) {
    return { success: false, synced, failed: 1, message: error.message || '暂时无法同步' };
  }
}
const SyncQueue = {
  async enqueue(type, payload) {
    storage.requireSession();
    const item = { _id: generateId(), type, payload, status: 'pending', retryCount: 0, createdAt: Date.now(), lastError: null };
    storage.update(state => {
      const head = effectiveQueue(state)[0];
      if (type === 'restore_course' && head &&
          ['checkin', 'update_course'].includes(head.type) && head.payload.courseId === payload.courseId &&
          state.courses.some(course => course._id === payload.courseId && course.isDeleted)) {
        // 用户已明确确认恢复：先解除失败记录的归档前提，不丢弃或重排原操作。
        // 队尾仍保留恢复意图，防止中间已排队的归档/撤销改变最终结果。
        state.queue.unshift({ ...item, _id: generateId() });
      }
      state.queue.push(item);
    });
    this.triggerSync();
    return item._id;
  },
  async getQueue() { return effectiveQueue(); },
  async getStats() {
    const state = storage.read();
    const queue = effectiveQueue(state);
    return {
      total: queue.length,
      pending: queue.filter(item => item.status === 'pending').length,
      syncing: queue.filter(item => item.status === 'syncing').length,
      failed: queue.filter(item => item.status === 'failed').length,
      synced: 0, lastSync: state.lastSync,
      lastError: (queue.find(item => item.lastError) || {}).lastError || ''
    };
  },
  sync() {
    if (!running) running = performSync().finally(() => { running = null; });
    return running;
  },
  async triggerSync() {
    try {
      const { networkType } = await wx.getNetworkType();
      if (networkType !== 'none') await this.sync();
    } catch (error) { console.error('Sync deferred', error.message); }
  },
  onChange: storage.onChange, offChange: storage.offChange
};
module.exports = { SyncQueue, view, call };
