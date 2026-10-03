const { env } = require('./config');
const storage = require('./utils/storage');
const { call, SyncQueue } = require('./utils/sync-queue');

App({
  globalData: { userInfo: null, isLogin: false, configError: '' },
  onLaunch() {
    if (!wx.cloud || !env) {
      this.globalData.configError = !env ? '尚未配置云环境。请在 miniprogram/config.js 填写环境 ID，再重新编译。' : '当前微信版本不支持云开发，请升级微信。';
      return;
    }
    wx.cloud.init({ env, traceUser: false });
    wx.onNetworkStatusChange(result => {
      if (result.isConnected) this.ensureReady().then(() => SyncQueue.sync()).catch(error => console.warn(error.message));
    });
    this.ensureReady().then(() => SyncQueue.sync()).catch(error => console.warn(error.message));
  },
  onShow() {
    if (this.globalData.configError) return;
    this.ensureReady().then(() => SyncQueue.sync()).catch(error => console.warn(error.message));
  },
  ensureReady() {
    if (this.globalData.configError || !env) return Promise.reject(new Error(this.globalData.configError || '请先配置云环境'));
    if (storage.getSession()) return Promise.resolve(this.globalData.userInfo);
    if (!this._login) {
      this._login = call('login', {}).then(data => {
        if (!data || !data.openid) throw new Error('登录未返回有效身份，请检查云函数部署');
        storage.activate(env, data.openid);
        this.globalData.userInfo = data;
        this.globalData.isLogin = true;
        return data;
      }).catch(error => { throw new Error(`暂时无法确认登录身份，请联网重试。未同步数据仍保留。${error.message || ''}`); }).finally(() => { this._login = null; });
    }
    return this._login;
  },
  onError(error) { console.error('[App]', error); },
  onUnhandledRejection(result) { console.error('[Promise]', result.reason); },
  onPageNotFound() { wx.switchTab({ url: '/pages/index/index' }); }
});
