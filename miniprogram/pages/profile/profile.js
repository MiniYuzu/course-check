const { db } = require('../../utils/db');
const storage = require('../../utils/storage');
const { SyncQueue } = require('../../utils/sync-queue');
const { showModal } = require('../../utils/util');
const { buildExport, shareExport } = require('../../utils/export');
const pageState = require('../../utils/page-state');
Page({
  data: { archived: [], queueStats: {}, pending: [], legacyCount: 0, isLoading: true, ready: false, error: '', offline: '', syncing: false, exporting: false },
  onLoad() { pageState.watch(this); },
  onShow() { return this.loadProfile(); },
  onUnload() { pageState.unwatch(this); },
  onPullDownRefresh() { return this.loadProfile(); },
  loadProfile() { return pageState.load(this); },
  render() {
    const state = storage.read();
    const courses = db.snapshot().courses;
    const pending = state.queue.map(item => {
      const courseId = state.aliases[item.payload.courseId] || item.payload.courseId;
      const course = courses.find(value => value._id === courseId);
      return { ...item, courseName: course ? course.name : (item.payload.name || '课程记录'), label: ({ add_course: '新增课程', update_course: '修改课程', checkin: '记课', update_checkin_notes: '修改课后备注', cancel_checkin: '撤销记录', archive_course: '归档课程', restore_course: '恢复课程' })[item.type] || item.type };
    });
    this.setData({ archived: courses.filter(course => course.isDeleted), pending, legacyCount: Object.keys(storage.legacyData()).length });
    SyncQueue.getStats().then(queueStats => { if (!this._unloaded) this.setData({ queueStats }); });
  },
  async onSyncTap() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    try {
      await getApp().ensureReady();
      const result = await SyncQueue.sync();
      if (!result.success) throw new Error(result.message || '仍有记录未同步，请重试');
      const refresh = await this.loadProfile();
      if (!refresh || !refresh.success) throw new Error('暂时无法核对云端数据，请稍后刷新；本机记录仍保留');
      wx.showToast({ title: '同步完成', icon: 'success' });
    } catch (error) { pageState.toast(error); }
    finally { this.setData({ syncing: false }); }
  },
  async onRestore(event) {
    try {
      if (!await showModal('恢复课程', '恢复后可继续在首页记课，历史记录不变。')) return;
      await db.restoreCourse(event.currentTarget.dataset.id);
      this.render();
    } catch (error) { pageState.toast(error); }
  },
  onCourseTap(event) { wx.navigateTo({ url: `/pages/course-detail/course-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  async onDataExport() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    try {
      storage.requireSession();
      if (!await showModal('导出本机课时记录', '包含归档课程和待同步修改。未连接云端时可能不是最新数据；完整备份会保留待同步操作。文件含私人信息，请只分享给自己或信任的人。', { confirmText: '选择格式' })) return;
      const choice = await new Promise((resolve, reject) => wx.showActionSheet({ itemList: ['课时表（CSV，可用表格软件打开）', '完整备份（JSON，含待同步操作）'], success: resolve, fail: reject }));
      const source = storage.read();
      const output = buildExport(db.snapshot(), source.queue, source);
      await shareExport(choice.tapIndex === 0 ? output.csv : output.json, choice.tapIndex === 0 ? 'csv' : 'json');
    } catch (error) { if (!(error.errMsg || '').includes('cancel')) pageState.toast(error); }
    finally { this.setData({ exporting: false }); }
  },
  async onLegacyExport() {
    try {
      if (!await showModal('旧版缓存保护', '旧版数据没有可靠的账号和环境标记，已原样保留，未自动上传。先导出备份，再人工核对归属和日期；不要清除微信缓存。', { confirmText: '导出备份' })) return;
      await shareExport(JSON.stringify({ version: 'legacy-unverified', data: storage.legacyData() }, null, 2), 'json');
    } catch (error) { if (!(error.errMsg || '').includes('cancel')) pageState.toast(error); }
  },
  onHelp() { return showModal('记课说明', '同一课程同一天算 1 节。补记选择真实上课日期，误记可撤销。初始已上课时只计累计，不计月份。归档保留历史；续课时在编辑课程中增加总课时。标记“待同步”时请勿卸载或清除缓存。', { showCancel: false }); }
});
