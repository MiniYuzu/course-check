const { db } = require('../../utils/db');
const storage = require('../../utils/storage');
const { SyncQueue } = require('../../utils/sync-queue');
const { showModal } = require('../../utils/util');
const { buildExport, shareExport } = require('../../utils/export');
const pageState = require('../../utils/page-state');
Page({
  data: { archived: [], queueStats: {}, pending: [], legacyCount: 0, conflictOperationId: '', adopting: false, isLoading: true, ready: false, error: '', offline: '', syncing: false, exporting: false },
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
      return { ...item, courseName: course ? course.name : (item.payload.name || '课程记录'), label: ({ add_course: '新增课程', update_course: '修改课程', checkin: '记课', set_attendance: '确认或更正上课结果', update_checkin_notes: '修改课后备注', cancel_checkin: '撤销记录', archive_course: '归档课程', restore_course: '恢复课程' })[item.type] || item.type };
    });
    const head = state.queue[0];
    const eligible = head && head.status === 'failed' && head.lastErrorCode === 409 && (['set_attendance', 'update_checkin_notes', 'cancel_checkin'].includes(head.type) || (head.type === 'update_course' && head.payload.updates && head.payload.updates.scheduleChange));
    this.setData({ archived: courses.filter(course => course.isDeleted), pending, conflictOperationId: eligible ? head._id : '', legacyCount: Object.keys(storage.legacyData()).length });
    SyncQueue.getStats().then(queueStats => { if (!this._unloaded) this.setData({ queueStats }); });
  },
  async onAdoptCloudResult() {
    if (this.data.adopting || this.data.syncing || !this.data.conflictOperationId) return;
    const operationId = this.data.conflictOperationId, accountKey = storage.getSession()?.key;
    this.setData({ adopting: true });
    try {
      const head = storage.read().queue[0];
      const schedule = head && head.type === 'update_course';
      if (!await showModal('采用云端结果？', '先联网刷新，再采用云端已保存的结果。' + (schedule ? '这次安排修改及依赖它的后续安排修改' : '这门课程这一天尚未同步的结果、备注和撤销修改') + '将从待同步队列移出，并保留在完整 JSON 备份中；其他修改保留，仍可手动重试。请确认放弃这些本机修改。', { confirmText: '采用云端' })) return;
      if (storage.requireSession().key !== accountKey) throw new Error('账号已变化，请重新确认冲突记录');
      const result = await db.adoptCloudResult(operationId);
      if (this._unloaded || storage.getSession()?.key !== accountKey) return;
      this.render(); wx.showToast({ title: result.discardedCount + ' 项已备份，采用云端结果', icon: 'none' });
    } catch (error) { if (!this._unloaded) pageState.toast(error); }
    finally { if (!this._unloaded) this.setData({ adopting: false }); }
  },
  async onSyncTap() {
    if (this.data.syncing || this.data.adopting) return;
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
    const courseId = event.currentTarget.dataset.id, accountKey = storage.getSession()?.key;
    try {
      if (!await showModal('恢复课程', '恢复后可在首页记课，历史不变；原上课安排不会自动恢复，请编辑设置新的未来安排。')) return;
      if (this._unloaded) return;
      if (storage.requireSession().key !== accountKey) throw new Error('账号已变化，请重新打开课程');
      await db.restoreCourse(courseId);
      if (this._unloaded || storage.getSession()?.key !== accountKey) return;
      this.render();
    } catch (error) { if (!this._unloaded) pageState.toast(error); }
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
  onHelp() { return showModal('记课说明', '同一课程同一天最多 1 节。出席扣 1 节；缺席默认不扣，可按约定选择扣 1 节；停课不扣。安排结束后只会待确认，不会自动算缺席。补记选择真实日期，误记可更正或撤销。初始课时只计累计，不计月份。归档停止未来安排并保留历史；恢复后请设置新的未来安排。续课可增加总课时。待同步时请勿卸载或清除缓存。', { showCancel: false }); }
});
