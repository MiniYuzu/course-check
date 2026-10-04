const { db } = require('../../utils/db');
const storage = require('../../utils/storage');
const { lessonCount, today, addDays } = require('../../utils/records');
const { toast } = require('../../utils/page-state');
const { courseNotes } = require('../../utils/attendance-view');

Page({
  data: {
    isEdit: false, courseId: '', selectedType: 'swim', canSave: false, saving: false, saved: false, ready: false, error: '',
    course: { name: '', type: 'swim', totalLessons: '', initialLessons: '', schedule: '', notes: '' },
    scheduleEnabled: false, scheduleDirty: false, scheduleSlots: [], scheduleDate: '', scheduleMinDate: '1900-01-01', scheduleRequestedOn: '', scheduleExpectedVersion: '', hasScheduleHistory: false,
    weekdays: [{ weekday: 1, label: '一' }, { weekday: 2, label: '二' }, { weekday: 3, label: '三' }, { weekday: 4, label: '四' }, { weekday: 5, label: '五' }, { weekday: 6, label: '六' }, { weekday: 0, label: '日' }],
    courseTypes: [{ type: 'swim', name: '游泳', icon: '🏊' }, { type: 'piano', name: '钢琴', icon: '🎹' }, { type: 'english', name: '英语', icon: '📚' }, { type: 'art', name: '美术', icon: '🎨' }, { type: 'dance', name: '舞蹈', icon: '💃' }, { type: 'sports', name: '运动', icon: '⚽' }, { type: 'music', name: '音乐', icon: '🎵' }, { type: 'other', name: '其他', icon: '📖' }]
  },
  async onLoad(options) {
    this._sessionKey = storage.getSession()?.key || '';
    this._onSessionChange = () => {
      if (!this._unloaded && this._sessionKey && storage.getSession()?.key !== this._sessionKey) {
        this.setData({ ready: false, error: '登录身份已变化。请重新连接原账号继续编辑；切换账号后请返回首页重新打开，草稿不会提交到其他账号。' });
      }
    };
    storage.onChange(this._onSessionChange);
    this.setData({ courseId: options.id || '', isEdit: !!options.id });
    wx.setNavigationBarTitle({ title: options.id ? '编辑课程' : '添加课程' });
    await this.loadCourse();
  },
  onUnload() { this._unloaded = true; storage.offChange(this._onSessionChange); },
  requireDraftAccount() {
    const session = storage.requireSession();
    if (this._sessionKey && session.key !== this._sessionKey) throw new Error('账号已切换，请返回首页重新打开。原草稿不会提交到其他账号。');
    return session.key;
  },
  async loadCourse() {
    try {
      await getApp().ensureReady();
      if (this._unloaded) return;
      this._sessionKey = this.requireDraftAccount();
      if (this.data.isEdit) {
        let course = await db.getCourse(this.data.courseId);
        if (!course) { await db.refresh(); course = await db.getCourse(this.data.courseId); }
        if (this._unloaded) return;
        this.requireDraftAccount();
        if (!course) throw new Error('课程不存在，请返回首页刷新');
        if (course.isDeleted) throw new Error('请先恢复归档课程，再编辑');
        if (!this._loaded) { this.setData({ course: { ...course, schedule: '', notes: courseNotes(course), totalLessons: course.totalLessons || '', initialLessons: course.initialLessons || '' }, selectedType: course.type, canSave: true }); this.initializeSchedule(course); }
      }
      if (!this._loaded && !this.data.isEdit) this.initializeSchedule({});
      this._loaded = true;
      this.setData({ ready: true, error: '' });
    } catch (error) { if (!this._unloaded) this.setData({ error: error.message, ready: false }); }
  },
  onSelectType(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ selectedType: event.currentTarget.dataset.type, 'course.type': event.currentTarget.dataset.type }); },
  onNameInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.name': event.detail.value, canSave: !!event.detail.value.trim() }); },
  onTotalLessonsInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.totalLessons': event.detail.value }); },
  onInitialLessonsInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.initialLessons': event.detail.value }); },
  onNotesInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.notes': event.detail.value }); },
  initializeSchedule(course) {
    const versions = [...(course.scheduleVersions || [])].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const latest = versions[versions.length - 1];
    const requestedOn = today(), minimum = latest ? addDays(requestedOn, 1) : '1900-01-01';
    const slots = latest ? latest.slots.map(slot => ({ ...slot, label: '周' + ['日', '一', '二', '三', '四', '五', '六'][slot.weekday] })) : [];
    this.setData({ scheduleEnabled: !!slots.length, scheduleSlots: slots, scheduleDate: latest ? (latest.effectiveFrom > minimum ? latest.effectiveFrom : minimum) : requestedOn, scheduleMinDate: minimum, scheduleRequestedOn: requestedOn, scheduleExpectedVersion: latest ? latest.operationId || latest.effectiveFrom : '', hasScheduleHistory: !!latest, scheduleDirty: false, weekdays: this.data.weekdays.map(day => ({ ...day, selected: slots.some(slot => slot.weekday === day.weekday) })) });
    this._scheduleBaseline = this.scheduleSignature();
  },
  scheduleSignature() { return JSON.stringify({ enabled: this.data.scheduleEnabled, date: this.data.scheduleEnabled || this.data.hasScheduleHistory ? this.data.scheduleDate : '', slots: this.data.scheduleEnabled ? this.data.scheduleSlots.map(({ weekday, start, end }) => ({ weekday, start, end })) : [] }); },
  canEditSchedule() { return this.data.ready && !this.data.saving && !this.data.saved; },
  onScheduleToggle(event) { if (this.canEditSchedule()) this.setData({ scheduleEnabled: event.detail.value, scheduleDirty: true }); },
  onWeekdayTap(event) {
    if (!this.canEditSchedule()) return;
    const weekday = Number(event.currentTarget.dataset.weekday);
    const selected = this.data.scheduleSlots.some(slot => slot.weekday === weekday);
    const slots = selected ? this.data.scheduleSlots.filter(slot => slot.weekday !== weekday) : [...this.data.scheduleSlots, { weekday, label: '周' + ['日', '一', '二', '三', '四', '五', '六'][weekday], start: '10:00', end: '11:00' }].sort((a, b) => a.weekday - b.weekday);
    this.setData({ scheduleSlots: slots, scheduleDirty: true, weekdays: this.data.weekdays.map(day => ({ ...day, selected: slots.some(slot => slot.weekday === day.weekday) })) });
  },
  onTimeChange(event) {
    if (!this.canEditSchedule()) return;
    const { weekday, field } = event.currentTarget.dataset;
    if (!['start', 'end'].includes(field)) return;
    this.setData({ scheduleSlots: this.data.scheduleSlots.map(slot => slot.weekday === Number(weekday) ? { ...slot, [field]: event.detail.value } : slot), scheduleDirty: true });
  },
  onEffectiveDateChange(event) { if (this.canEditSchedule()) this.setData({ scheduleDate: event.detail.value, scheduleDirty: true }); },
  async onSave() {
    if (!this.data.ready || !this.data.canSave || this.data.saving || this.data.saved) return;
    this.setData({ saving: true });
    try {
      this.requireDraftAccount();
      // Save the unified note and retire its legacy field in the same operation.
      const course = { ...this.data.course, schedule: '', type: this.data.selectedType, totalLessons: lessonCount(this.data.course.totalLessons), initialLessons: lessonCount(this.data.course.initialLessons) };
      // A pending projection may contain its original request; only this draft's changes can submit a new one.
      delete course.scheduleChange;
      if (this.data.scheduleDirty && this.scheduleSignature() !== this._scheduleBaseline) {
        if (this.data.scheduleEnabled && !this.data.scheduleSlots.length) throw new Error('请至少选择一个上课日');
        course.scheduleChange = { effectiveFrom: this.data.scheduleDate, slots: this.data.scheduleEnabled ? this.data.scheduleSlots.map(({ weekday, start, end }) => ({ weekday, start, end })) : [], requestedOn: this.data.scheduleRequestedOn, expectedVersion: this.data.scheduleExpectedVersion };
      }
      if (this.data.isEdit) await db.updateCourse(this.data.courseId, course);
      else await db.addCourse(course);
      if (this._unloaded) return;
      this.setData({ saved: true });
      wx.showToast({ title: '已保存，等待同步', icon: 'none' });
      wx.navigateBack();
    } catch (error) { if (!this._unloaded) toast(error); }
    finally { if (!this._unloaded) this.setData({ saving: false }); }
  }
});
