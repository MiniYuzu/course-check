// 全局应用配置
const { ErrorHandler } = require('./utils/error-handler');
const { getNetworkMonitor } = require('./utils/network-monitor');
const { SyncQueue } = require('./utils/sync-queue');

App({
  globalData: {
    userInfo: null,
    isLogin: false
  },

  onLaunch() {
    // 初始化云开发
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'course-check-env', // 替换为你的云开发环境ID
        traceUser: true
      });
    }

    // 初始化网络监控
    getNetworkMonitor();

    // 检查登录状态
    this.checkLogin();

    // 全局错误处理
    this.setupErrorHandling();

    // 应用启动时触发一次同步
    this.triggerInitialSync();

    console.log('[App] Launched');
  },

  onShow() {
    // 应用从后台进入前台时触发同步
    SyncQueue.sync().catch(err => {
      console.error('Sync on app show failed:', err);
    });
  },

  onHide() {
    console.log('[App] Hidden');
  },

  onError(error) {
    console.error('[App Error]', error);
    ErrorHandler.handleGlobal(error, 'error');
  },

  onUnhandledRejection(res) {
    console.error('[Unhandled Rejection]', res.reason);
    ErrorHandler.handleGlobal(res.reason, 'unhandledRejection');
  },

  onPageNotFound(res) {
    wx.redirectTo({
      url: '/pages/index/index'
    });
  },

  // 检查登录状态
  async checkLogin() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'login'
      });

      if (result && result.openid) {
        this.globalData.userInfo = result;
        this.globalData.isLogin = true;
        console.log('[App] Login success:', result.openid);
      }
    } catch (error) {
      console.error('[App] Login check failed:', error);
    }
  },

  // 设置全局错误处理
  setupErrorHandling() {
    // 监听未捕获的 Promise 错误
    wx.onUnhandledRejection((res) => {
      ErrorHandler.handleGlobal(res.reason, 'unhandledRejection');
    });

    // 监听 JS 错误
    wx.onError((error) => {
      ErrorHandler.handleGlobal(new Error(error), 'globalError');
    });
  },

  // 触发初始同步
  async triggerInitialSync() {
    try {
      // 延迟2秒执行，让页面先加载
      setTimeout(() => {
        SyncQueue.sync().catch(err => {
          console.error('Initial sync failed:', err);
        });
      }, 2000);
    } catch (error) {
      console.error('Trigger initial sync failed:', error);
    }
  }
});
