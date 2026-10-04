const { db } = require('../../utils/db');
const storage = require('../../utils/storage');
const { today, normalizeCheckinNotes } = require('../../utils/records');
const { showModal, getCourseTypeConfig } = require('../../utils/util');
const pageState = require('../../utils/page-state');
const { courseTimeline, attendanceStatus, attendanceDebit } = require('../../utils/attendance');
const { filters, monthBounds, displayRow, scheduleLabel, courseNotes } = require('../../utils/attendance-view');

const draftKey = (courseId, date) => JSON.stringify([courseId, date]);

Page({
  data: {
    courseId: '', course: null, courseGradient: getCourseTypeConfig('other').gradient, records: [], visibleRecords: [], visibleCount: 30, month: '', selectedDate: '', today: '',
    isLoading: true, ready: false, error: '', offline: '', busy: false, hasSelectedRecord: false, selectedRecord: null,
    noteDraft: '', noteOpen: false, noteModalOpen: false, modalCourseId: '', modalCourseName: '', modalDate: '', modalDateLabel: '', modalNotes: '',
    filter: 'all', filters, attendanceOpen: false, attendanceRow: null, selectedStatus: '', allRecords: [], scheduleLabel: '', courseNotes: ''
  },
  onLoad(options) { this.setData({ courseId: options.id || '', selectedDate: today(), today: today() }); pageState.watch(this); },
  onShow() { return this.loadCourse(); },
  onUnload() { pageState.unwatch(this); },
  onPullDownRefresh() { return this.loadCourse(); },
  loadCourse() { return pageState.load(this); },
  draftFor(courseId, date, record) {
    const account = storage.getSession();
    const accountKey = account ? account.key : '';
    if (this._draftAccount !== accountKey) { this._draftAccount = accountKey; this._drafts = {}; this.setData({ noteModalOpen: false, modalNotes: '', attendanceOpen: false, attendanceRow: null }); }
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
    const allRecords = course ? courseTimeline(course, snapshot.rawCheckins, monthBounds(this.data.month)).map(displayRow) : [];
    const records = allRecords.filter(row => this.data.filter === 'all' || row.status === this.data.filter);
    const draft = this.draftFor(courseId, this.data.selectedDate, selectedRecord);
    this.setData({ courseId, course, scheduleLabel: scheduleLabel(course), courseNotes: courseNotes(course), courseGradient: getCourseTypeConfig((course && course.type) || 'other').gradient, allRecords, records, visibleRecords: records.slice(0, this.data.visibleCount), today: today(), selectedRecord, selectedStatus: selectedRecord ? attendanceStatus(selectedRecord) : '', hasSelectedRecord: !!selectedRecord, noteDraft: draft.text, noteOpen: draft.open });
  },
  onFilterTap(event) { this.setData({ filter: event.currentTarget.dataset.filter, visibleCount: 30 }); this.render(); },
  onOpenAttendance(event) {
    if (this.data.busy || !this.data.ready) return;
    const row = this.data.allRecords.find(item => item.key === event.currentTarget.dataset.key);
    if (!row || !row.canConfirm || (this.data.course.isDeleted && !row.isOutcome)) return;
    this.setData({ attendanceOpen: true, attendanceRow: { ...row } });
  },
  onCloseAttendance() { this.setData({ attendanceOpen: false, attendanceRow: null }); },
  onAttendanceSaved(event) { this.clearDraft(event.detail.courseId, event.detail.date); this.render(); },
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
    if (this.data.busy || !this.data.ready || (this.data.course && this.data.course.isDeleted)) return;
    if (this.data.hasSelectedRecord) {
      if (['absent', 'cancelled'].includes(this.data.selectedStatus)) {
        const row = displayRow({ ...this.data.selectedRecord, status: this.data.selectedStatus, courseName: this.data.course.name });
        if (row.canConfirm) this.setData({ attendanceOpen: true, attendanceRow: row });
      }
      return;
    }
    const { courseId, selectedDate: date, noteDraft } = this.data;
    const accountKey = storage.getSession()?.key;
    this.setData({ busy: true });
    try {
      const notes = normalizeCheckinNotes(noteDraft);
      if (date !== today() && !await showModal('补记一节课', '确认在 ' + date + ' 上过这节课？同一课程同一天只记 1 节。', { confirmText: '确认补记' })) return;
      if (this._unloaded) return;
      if (storage.requireSession().key !== accountKey) throw new Error('账号已变化，请重新打开课程');
      await db.addCheckin(courseId, { date, notes });
      if (this._unloaded || storage.getSession()?.key !== accountKey) return;
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
    if (!record.isOutcome) return;
    this._modalAccountKey = storage.getSession()?.key;
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
      if (storage.requireSession().key !== this._modalAccountKey) throw new Error('账号已变化，请重新打开记录');
      await db.updateCheckinNotes(courseId, date, notes);
      this.clearDraft(courseId, date); this.setData({ noteModalOpen: false, modalNotes: '' }); this.render();
      wx.showToast({ title: notes ? '备注已保存，待同步' : '备注已清空，待同步', icon: 'none' });
    } catch (error) { pageState.toast(error); }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  async onCancelCheckin(event) {
    if (this.data.busy || !this.data.ready) return;
    const courseId = this.data.courseId, date = event.currentTarget.dataset.date;
    const accountKey = storage.getSession()?.key;
    const record = this.data.allRecords.find(row => row.date === date);
    this.setData({ busy: true });
    try {
      const balanceHint = record && attendanceDebit(record) ? '课时余额返还 1 节。' : '课时余额不变。';
      const countHint = record && attendanceStatus(record) === 'attended' ? '已上课时减 1。' : '已上课时不变。';
      if (!await showModal('撤销这次记录？', String(date || '日期待核对') + ' 的记录和备注将一并移除。' + countHint + balanceHint + '已安排的课程会重新显示待确认或待上课。', { confirmText: '撤销记录' })) return;
      if (this._unloaded) return;
      if (storage.requireSession().key !== accountKey) throw new Error('账号已变化，请重新打开课程');
      await db.cancelCheckin(courseId, date);
      if (this._unloaded || storage.getSession()?.key !== accountKey) return;
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
    const accountKey = storage.getSession()?.key;
    this.setData({ busy: true });
    try {
      const pendingCount = archived ? 0 : db.snapshot().pending.filter(item => item.courseId === courseId).length;
      const pendingHint = pendingCount ? `还有 ${pendingCount} 节课待确认，建议先处理；归档后将不再提醒。\n\n` : '';
      const archiveHint = '归档不是删除。\n课程从首页隐藏，停止后续排课和待确认提醒，不再计入正在上的课程。\n总课时、已上和剩余课时不变，历史记录仍计入统计。\n可在“我的”恢复，恢复后需重新设置上课安排。';
      if (!await showModal(archived ? '恢复课程' : '归档课程', archived ? '恢复后课程重新出现在首页，历史不变；原安排不会自动恢复，请编辑设置新的未来安排。' : pendingHint + archiveHint, archived ? {} : { confirmText: '确认归档', cancelText: '暂不归档' })) return;
      if (this._unloaded) return;
      if (storage.requireSession().key !== accountKey) throw new Error('账号已变化，请重新打开课程');
      if (archived) await db.restoreCourse(courseId);
      else await db.archiveCourse(courseId);
      if (this._unloaded || storage.getSession()?.key !== accountKey) return;
      this.render();
    } catch (error) { if (!this._unloaded) pageState.toast(error); }
    finally { if (!this._unloaded) this.setData({ busy: false }); }
  }
});
