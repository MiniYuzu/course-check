const { db } = require('./db');
const storage = require('./storage');

function watch(page) {
  page._onDataChange = () => {
    if (page._unloaded) return;
    if (!storage.getSession()) page.setData({ ready: false, isLoading: false, offline: '', error: '登录身份需要重新确认。原账户的本机数据仍保留，请联网重新连接。' });
    page.render();
  };
  db.onChange(page._onDataChange);
}
function unwatch(page) {
  page._unloaded = true;
  db.offChange(page._onDataChange);
}
async function load(page) {
  if (page._loading) return page._loading;
  page.setData({ isLoading: true, error: '' });
  const promise = (async () => {
    try {
      await getApp().ensureReady();
      if (page._unloaded) return { success: false, error: '页面已关闭' };
      page.render();
      const result = await db.refresh();
      if (page._unloaded) return;
      page.render();
      page.setData({ ready: true, offline: result.offline ? (result.error || '未连接云端，显示本机记录') : '' });
      return { success: !result.offline, error: result.error || '' };
    } catch (error) {
      if (!page._unloaded) {
        page.render();
        page.setData({ ready: !!storage.getSession(), error: error.message || '加载失败，请重试' });
      }
      return { success: false, error: error.message || '加载失败，请重试' };
    } finally {
      if (!page._unloaded) page.setData({ isLoading: false });
      wx.stopPullDownRefresh();
    }
  })();
  page._loading = promise;
  try { return await promise; } finally { page._loading = null; }
}
function toast(error) { wx.showToast({ title: error.message || error.errMsg || '操作失败，请重试', icon: 'none' }); }
module.exports = { watch, unwatch, load, toast };
