// 同步状态组件
const { SyncQueue } = require('../../utils/sync-queue');

Component({
  /**
   * 组件数据
   */
  data: {
    status: 'synced', // synced | syncing | pending | failed
    count: 0,
    visible: false,
    icon: '✓',
    text: '已同步'
  },

  /**
   * 生命周期
   */
  lifetimes: {
    attached() {
      this.updateStatus();

      // 监听队列变化
      SyncQueue.onChange(() => {
        this.updateStatus();
      });

      // 定期更新状态
      this.updateInterval = setInterval(() => {
        this.updateStatus();
      }, 5000);
    },

    detached() {
      if (this.updateInterval) {
        clearInterval(this.updateInterval);
      }
    }
  },

  /**
   * 组件方法
   */
  methods: {
    async updateStatus() {
      const stats = await SyncQueue.getStats();

      let status = 'synced';
      let icon = '✓';
      let text = '已同步';
      let visible = false;

      if (stats.failed > 0) {
        status = 'failed';
        icon = '✗';
        text = '同步失败';
        visible = true;
      } else if (stats.syncing > 0) {
        status = 'syncing';
        text = '正在同步...';
        visible = true;
      } else if (stats.pending > 0) {
        status = 'pending';
        icon = '⏳';
        text = `${stats.pending}条待同步`;
        visible = true;
      }

      this.setData({
        status,
        icon,
        text,
        count: stats.failed || stats.pending,
        visible
      });
    },

    async onTap() {
      if (this.data.status === 'failed' || this.data.status === 'pending') {
        this.setData({ status: 'syncing', text: '正在同步...' });

        try {
          await SyncQueue.sync();
          wx.showToast({ title: '同步完成', icon: 'success' });
        } catch (error) {
          wx.showToast({ title: '同步失败', icon: 'none' });
        }

        this.updateStatus();
      }
    }
  }
});