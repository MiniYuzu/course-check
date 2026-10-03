const { db } = require('../../utils/db');
const storage = require('../../utils/storage');
const { lessonCount } = require('../../utils/records');
const { toast } = require('../../utils/page-state');

Page({
  data: {
    isEdit: false, courseId: '', selectedType: 'swim', canSave: false, saving: false, saved: false, ready: false, error: '',
    course: { name: '', type: 'swim', totalLessons: '', initialLessons: '', schedule: '', notes: '' },
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
        if (!this._loaded) this.setData({ course: { ...course, totalLessons: course.totalLessons || '', initialLessons: course.initialLessons || '' }, selectedType: course.type, canSave: true });
      }
      this._loaded = true;
      this.setData({ ready: true, error: '' });
    } catch (error) { if (!this._unloaded) this.setData({ error: error.message, ready: false }); }
  },
  onSelectType(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ selectedType: event.currentTarget.dataset.type, 'course.type': event.currentTarget.dataset.type }); },
  onNameInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.name': event.detail.value, canSave: !!event.detail.value.trim() }); },
  onTotalLessonsInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.totalLessons': event.detail.value }); },
  onInitialLessonsInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.initialLessons': event.detail.value }); },
  onScheduleInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.schedule': event.detail.value }); },
  onNotesInput(event) { if (!this.data.ready || this.data.saving || this.data.saved) return; this.setData({ 'course.notes': event.detail.value }); },
  async onSave() {
    if (!this.data.ready || !this.data.canSave || this.data.saving || this.data.saved) return;
    this.setData({ saving: true });
    try {
      this.requireDraftAccount();
      const course = { ...this.data.course, type: this.data.selectedType, totalLessons: lessonCount(this.data.course.totalLessons), initialLessons: lessonCount(this.data.course.initialLessons) };
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
