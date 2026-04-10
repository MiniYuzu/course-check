// 网络监控模块
const { SyncQueue } = require('./sync-queue');

class NetworkMonitor {
  constructor() {
    this.isOnline = true;
    this.networkType = 'unknown';
    this.listeners = [];

    this.init();
  }

  /**
   * 初始化网络监听
   */
  init() {
    // 获取初始网络状态
    this.checkNetworkStatus();

    // 监听网络状态变化
    wx.onNetworkStatusChange((res) => {
      const wasOffline = !this.isOnline;
      this.isOnline = res.isConnected;
      this.networkType = res.networkType;

      console.log('[NetworkMonitor]', res.isConnected ? 'online' : 'offline', res.networkType);

      // 网络恢复时触发同步
      if (wasOffline && res.isConnected) {
        console.log('[NetworkMonitor] Network restored, triggering sync...');
        SyncQueue.sync().catch(err => {
          console.error('Sync on network restore failed:', err);
        });
      }

      // 通知监听器
      this.notifyListeners({
        isOnline: this.isOnline,
        networkType: this.networkType
      });
    });

    // 应用回到前台时检查同步
    wx.onAppShow(() => {
      this.checkNetworkStatus().then(() => {
        if (this.isOnline) {
          SyncQueue.sync().catch(err => {
            console.error('Sync on app show failed:', err);
          });
        }
      });
    });
  }

  /**
   * 检查网络状态
   */
  async checkNetworkStatus() {
    try {
      const res = await wx.getNetworkType();
      this.networkType = res.networkType;
      this.isOnline = res.networkType !== 'none';
      return this.isOnline;
    } catch (e) {
      console.error('Check network status failed:', e);
      this.isOnline = false;
      return false;
    }
  }

  /**
   * 获取当前网络状态
   */
  getStatus() {
    return {
      isOnline: this.isOnline,
      networkType: this.networkType
    };
  }

  /**
   * 添加状态变化监听器
   * @param {Function} callback - 回调函数
   */
  onStatusChange(callback) {
    this.listeners.push(callback);
  }

  /**
   * 移除状态变化监听器
   * @param {Function} callback - 回调函数
   */
  offStatusChange(callback) {
    const index = this.listeners.indexOf(callback);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * 通知所有监听器
   * @param {Object} status - 网络状态
   */
  notifyListeners(status) {
    this.listeners.forEach(callback => {
      try {
        callback(status);
      } catch (e) {
        console.error('NetworkMonitor listener error:', e);
      }
    });
  }
}

// 单例实例
let instance = null;

function getNetworkMonitor() {
  if (!instance) {
    instance = new NetworkMonitor();
  }
  return instance;
}

module.exports = { getNetworkMonitor, NetworkMonitor };
