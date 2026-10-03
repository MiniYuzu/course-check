// One synchronous commit keeps the queue and its acknowledged snapshot atomic.
// Legacy global keys are never migrated into an unverified account.
let session = null;
const listeners = new Set();
const empty = () => ({ version: 2, courses: [], checkins: [], queue: [], aliases: {}, hasSnapshot: false, revision: 0, cloudRevision: 0, lastRefresh: null, lastSync: null });
function read(key = session && session.key) {
  if (!key) return empty();
  const value = wx.getStorageSync(key);
  if (!value) return empty();
  if (value.version !== 2 || !Array.isArray(value.queue) || !Array.isArray(value.courses) || !Array.isArray(value.checkins)) throw new Error('本地数据格式异常，请先导出备份，不要清除缓存');
  return JSON.parse(JSON.stringify(value));
}
function notify() {
  listeners.forEach(callback => { try { callback(); } catch (error) { console.error('Data listener failed', error); } });
}
function requireSession() {
  if (!session) throw new Error('请先联网登录，确认数据归属');
  return { ...session };
}
function update(change, key = requireSession().key) {
  const state = read(key);
  change(state);
  state.revision++;
  // A quota error must escape before the UI claims data is saved.
  wx.setStorageSync(key, state);
  if (session && session.key === key) notify();
  return state;
}
function activate(env, openid) {
  if (!env || !openid) throw new Error('缺少云环境或登录身份');
  const key = `cc_v2:${encodeURIComponent(env)}:${encodeURIComponent(openid)}`;
  if (session && session.key === key) return;
  const state = read(key);
  state.queue.forEach(item => { if (item.status === 'syncing') item.status = 'pending'; });
  wx.setStorageSync(key, state);
  session = { env, openid, key };
  notify();
}
function legacyData() {
  const { keys } = wx.getStorageInfoSync();
  const result = {};
  keys.filter(key => key === 'cc_courses' || key === 'cc_sync_queue' || key.startsWith('cc_checkins_')).forEach(key => { result[key] = wx.getStorageSync(key); });
  return result;
}
module.exports = {
  activate, read, update, requireSession, legacyData, notify,
  getSession: () => session && { ...session },
  deactivate: () => { session = null; notify(); },
  onChange: callback => listeners.add(callback), offChange: callback => listeners.delete(callback)
};
