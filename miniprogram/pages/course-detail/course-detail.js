const { db } = require('../../utils/db');
const storage = require('../../utils/storage');
const { today, isDatedRecord, normalizeCheckinNotes } = require('../../utils/records');
const { showModal, getCourseTypeConfig } = require('../../utils/util');
const pageState = require('../../utils/page-state');

const draftKey = (courseId, date) => JSON.stringify([courseId, date]);
function timelineRecord(record) {
  const valid = isDatedRecord(record);
  return { ...record, day: valid ? record.date.slice(8) : '—', weekday: valid ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(record.date + 'T00:00:00Z').getUTCDay()] : '待核对', dateLabel: valid ? record.date.replace(/-/g, '.') : String(record.date || '日期待核对') };
}

Page({
  data: {
    courseId: '', course: null, courseGradient: getCourseTypeConfig('other').gradient, records: [], visibleRecords: [], visibleCount: 30, month: '', selectedDate: '', today: '',
    isLoading: true, ready: false, error: '', offline: '', busy: false, hasSelectedRecord: false, selectedRecord: null,
    noteDraft: '', noteOpen: false, noteModalOpen: false, modalCourseId: '', modalCourseName: '', modalDate: '', modalDateLabel: '', modalNotes: ''
  },
  onLoad(options) { this.setData({ courseId: options.id || '', selectedDate: today(), today: today() }); pageState.watch(this); },
  onShow() { return this.loadCourse(); },
  onUnload() { pageState.unwatch(this); },
  onPullDownRefresh() { return this.loadCourse(); },
  loadCourse() { return pageState.load(this); },
  draftFor(courseId, date, record) {
    const account = storage.getSession();
    const accountKey = account ? account.key : '';
    if (this._draftAccount !== accountKey) { this._draftAccount = accountKey; this._drafts = {}; this.setData({ noteModalOpen: false }); }
    const aliases = storage.read().aliases;
    // A local course ID can become a cloud ID while the user is still typing.
    Object.keys(this._drafts).forEach(key => {
      const draft = this._drafts[key], canonical = aliases[draft.courseId] || draft.courseId;
      if (canonical !== draft.courseId) { draft.courseId = canonical; this._drafts[draftKey(canonical, draft.date)] = draft; delete this._drafts[key]; }
    });
    const key = draftKey(courseId, date);
    if (!this._drafts[key]) this._drafts[key] = { courseId, date, text: '', open: false, dirty: false };
    const draft = this._drafts[key];
    if (!draft.dirty) draft.text = record ? String(record.notes || '') : '';
    return draft;
  },
  clearDraft(courseId, date) {
    if (!this._drafts) return;
    const aliases = storage.read().aliases;
    Object.keys(this._drafts).forEach(key => {
      const draft = this._drafts[key];
      if ((aliases[draft.courseId] || draft.courseId) === (aliases[courseId] || courseId) && draft.date === date) delete this._drafts[key];
    });
  },
  render() {
    const snapshot = db.snapshot();
    const aliases = storage.read().aliases;
    const courseId = aliases[this.data.courseId] || this.data.courseId;
    const course = snapshot.courses.find(item => item._id === courseId) || null;
    const history = snapshot.checkins.filter(item => item.courseId === courseId);
    const selectedRecord = history.find(item => item.date === this.data.selectedDate) || null;
    const records = history.filter(item => !this.data.month || (isDatedRecord(item) && item.date.startsWith(this.data.month))).map(timelineRecord);
    const draft = this.draftFor(courseId, this.data.selectedDate, selectedRecord);
    this.setData({ courseId, course, courseGradient: getCourseTypeConfig((course && course.type) || 'other').gradient, records, visibleRecords: records.slice(0, this.data.visibleCount), today: today(), selectedRecord, hasSelectedRecord: !!selectedRecord, noteDraft: draft.text, noteOpen: draft.open });
  },
  onDateChange(event) { if (this.data.busy) return; this.setData({ selectedDate: event.detail.value }); this.render(); },
  onMonthChange(event) { this.setData({ month: event.detail.value, visibleCount: 30 }); this.render(); },
  onAllMonths() { this.setData({ month: '', visibleCount: 30 }); this.render(); },
  onLoadMore() { this.setData({ visibleCount: this.data.visibleCount + 30 }); this.render(); },
  onToggleNotes() {
    if (this.data.busy) return;
    const draft = this.draftFor(this.data.courseId, this.data.selectedDate, this.data.selectedRecord);
    draft.open = !draft.open; this.setData({ noteOpen: draft.open });
  },
  onNotesInput(event) {
    if (this.data.busy) return;
    const draft = this.draftFor(this.data.courseId, this.data.selectedDate, this.data.selectedRecord);
    draft.text = event.detail.value; draft.dirty = true;
    this.setData({ noteDraft: draft.text });
  },
  async onCheckin() {
    if (this.data.busy || !this.data.ready || this.data.hasSelectedRecord || (this.data.course && this.data.course.isDeleted)) return;
    const { courseId, selectedDate: date, noteDraft } = this.data;
    this.setData({ busy: true });
    try {
      const notes = normalizeCheckinNotes(noteDraft);
      if (date !== today() && !await showModal('补记一节课', '确认在 ' + date + ' 上过这节课？同一课程同一天只记 1 节。', { confirmText: '确认补记' })) return;
      await db.addCheckin(courseId, { date, notes });
      this.clearDraft(courseId, date); this.render();
      wx.showToast({ title: '已保存，等待同步', icon: 'none' });
    } catch (error) { pageState.toast(error); }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  async onSaveNotes() {
    if (this.data.busy || !this.data.ready || !this.data.hasSelectedRecord) return;
    const { courseId, selectedDate: date, noteDraft } = this.data;
    this.setData({ busy: true });
    try {
      const notes = normalizeCheckinNotes(noteDraft);
      await db.updateCheckinNotes(courseId, date, notes);
      this.clearDraft(courseId, date); this.render();
      wx.showToast({ title: notes ? '备注已保存，待同步' : '备注已清空，待同步', icon: 'none' });
    } catch (error) { pageState.toast(error); }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  onOpenRecordNote(event) {
    if (this.data.busy || !this.data.ready) return;
    const { date, recordId } = event.currentTarget.dataset;
    const record = this.data.records.find(item => recordId ? item._id === recordId : item.date === date);
    if (!record || !this.data.course) return;
    this.setData({ noteModalOpen: true, modalCourseId: this.data.courseId, modalCourseName: this.data.course.name, modalDate: record.date, modalDateLabel: record.dateLabel, modalNotes: String(record.notes || '') });
  },
  onModalNotesInput(event) { if (!this.data.busy) this.setData({ modalNotes: event.detail.value }); },
  onCloseNoteModal() { if (!this.data.busy) this.setData({ noteModalOpen: false, modalNotes: '' }); },
  onModalTouchMove() {},
  async onSaveModalNotes() {
    if (this.data.busy || !this.data.ready || !this.data.noteModalOpen) return;
    const { modalCourseId: courseId, modalDate: date, modalNotes } = this.data;
    this.setData({ busy: true });
    try {
      const notes = normalizeCheckinNotes(modalNotes);
      await db.updateCheckinNotes(courseId, date, notes);
      this.clearDraft(courseId, date); this.setData({ noteModalOpen: false, modalNotes: '' }); this.render();
      wx.showToast({ title: notes ? '备注已保存，待同步' : '备注已清空，待同步', icon: 'none' });
    } catch (error) { pageState.toast(error); }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  async onCancelCheckin(event) {
    if (this.data.busy || !this.data.ready) return;
    const courseId = this.data.courseId, date = event.currentTarget.dataset.date;
    this.setData({ busy: true });
    try {
      if (!await showModal('撤销这次记课？', date + ' 的上课记录和这节课的备注将一并移除，已上课时减 1。需要时可以重新补记。', { confirmText: '撤销记录' })) return;
      await db.cancelCheckin(courseId, date);
      this.clearDraft(courseId, date); this.render();
      wx.showToast({ title: '撤销已保存，待同步', icon: 'none' });
    } catch (error) { pageState.toast(error); }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  onEdit() {
    if (!this.data.ready || this.data.busy || !this.data.course || this.data.course.isDeleted) return;
    wx.navigateTo({ url: '/pages/course-edit/course-edit?id=' + encodeURIComponent(this.data.courseId) });
  },
  async onArchive() {
    if (this.data.busy || !this.data.ready || !this.data.course) return;
    const courseId = this.data.courseId, archived = this.data.course.isDeleted;
    this.setData({ busy: true });
    try {
      if (!await showModal(archived ? '恢复课程' : '归档课程', archived ? '恢复后，课程会重新出现在首页。' : '课程将从首页隐藏，历史和统计都保留，可在“我的”恢复。')) return;
      if (archived) await db.restoreCourse(courseId);
      else await db.archiveCourse(courseId);
      this.render();
    } catch (error) { pageState.toast(error); }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  }
});
