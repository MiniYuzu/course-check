const { SyncQueue } = require('../../utils/sync-queue');
const storage = require('../../utils/storage');
Component({
  data: { status: 'synced', text: '', visible: false, busy: false },
  lifetimes: {
    attached() {
      this._onQueueChange = () => this.updateStatus();
      SyncQueue.onChange(this._onQueueChange);
      this.updateStatus();
    },
    detached() { this._detached = true; SyncQueue.offChange(this._onQueueChange); }
  },
  methods: {
    async updateStatus() {
      const stats = await SyncQueue.getStats();
      if (this._detached) return;
      const session = storage.getSession();
      const status = stats.failed ? 'failed' : stats.syncing ? 'syncing' : stats.pending ? 'pending' : 'synced';
      const text = status === 'failed' ? `${stats.total} 项修改未完成同步 · 点击重试` : status === 'syncing' ? '正在同步，记录已保存在本机…' : status === 'pending' ? `${stats.total} 项修改待同步 · 点击重试` : '';
      this.setData({ status, text, visible: !!session && stats.total > 0 });
    },
    async onTap() {
      if (this.data.busy || this.data.status === 'syncing') return;
      this.setData({ busy: true });
      try {
        const result = await SyncQueue.sync();
        wx.showToast({ title: result.success ? '同步完成' : (result.message || '仍有记录未同步'), icon: result.success ? 'success' : 'none' });
      } catch (error) { wx.showToast({ title: error.message || '同步失败，记录仍保留', icon: 'none' }); }
      finally { this.setData({ busy: false }); await this.updateStatus(); }
    }
  }
});
