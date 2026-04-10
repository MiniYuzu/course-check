// 个人中心页
const { showToast, showModal } = require('../../utils/util');
const { SyncQueue } = require('../../utils/sync-queue');

Page({
  data: {
    userId: '',
    settings: {
      advancedMode: false
    }
  },

  onLoad() {
    this.loadUserInfo();
    this.loadSettings();
  },

  onShow() {
    this.loadSettings();
  },

  // 加载用户信息
  loadUserInfo() {
    const { userInfo } = getApp().globalData;
    if (userInfo) {
      this.setData({
        userId: userInfo.openid || '未知'
      });
    }
  },

  // 加载设置
  loadSettings() {
    const settings = wx.getStorageSync('cc_user_settings') || {};
    this.setData({
      settings: {
        advancedMode: settings.advancedMode || false
      }
    });
  },

  // 同步状态点击
  async onSyncTap() {
    try {
      wx.showLoading({ title: '同步中...' });
      const result = await SyncQueue.sync();
      wx.hideLoading();

      if (result.failed === 0) {
        showToast('同步完成', 'success');
      } else {
        showToast(`${result.failed}条同步失败`, 'none');
      }
    } catch (error) {
      wx.hideLoading();
      showToast('同步失败', 'error');
    }
  },

  // 家庭成员
  onFamilyShare() {
    showToast('功能开发中', 'none');
  },

  // 上课提醒
  onReminder() {
    wx.navigateTo({
      url: '/pages/reminder/reminder'
    });
  },

  // 数据导出
  onDataExport() {
    showModal('数据导出', '确定要导出所有数据吗？导出后可以通过邮件发送给您。', {
      confirmText: '导出'
    }).then(confirmed => {
      if (confirmed) {
        showToast('导出功能开发中', 'none');
      }
    });
  },

  // 切换高级模式
  onToggleAdvanced(e) {
    const advancedMode = e.detail.value;
    const settings = wx.getStorageSync('cc_user_settings') || {};
    settings.advancedMode = advancedMode;
    wx.setStorageSync('cc_user_settings', settings);

    this.setData({
      'settings.advancedMode': advancedMode
    });

    showToast(advancedMode ? '已开启高级模式' : '已关闭高级模式', 'success');
  },

  // 高级模式页面
  onAdvancedMode() {
    // 如果点击的不是 switch，也跳转设置页
  },

  // 意见反馈
  onFeedback() {
    wx.navigateTo({
      url: '/pages/feedback/feedback'
    });
  },

  // 关于我们
  onAbout() {
    wx.navigateTo({
      url: '/pages/about/about'
    });
  },

  // Tab 切换
  onTabChange(e) {
    const { tab } = e.detail;
    const urlMap = {
      home: '/pages/index/index',
      stats: '/pages/stats/stats',
      achieve: '/pages/achieve/achieve',
      profile: '/pages/profile/profile'
    };

    if (tab !== 'profile') {
      wx.switchTab({ url: urlMap[tab] });
    }
  }
});
