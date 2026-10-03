const { db } = require('../../utils/db');
const { today } = require('../../utils/records');
const pageState = require('../../utils/page-state');

Page({
  data: { courses: [], today: '', todayLessons: 0, hasData: false, isLoading: true, ready: false, error: '', offline: '', busyId: '' },
  onLoad() { pageState.watch(this); },
  onShow() { return this.loadCourses(); },
  onUnload() { pageState.unwatch(this); },
  onPullDownRefresh() { return this.loadCourses(); },
  loadCourses() { return pageState.load(this); },
  render() {
    const snapshot = db.snapshot();
    this.setData({ courses: snapshot.courses.filter(course => !course.isDeleted), today: today(), todayLessons: snapshot.todayLessons, hasData: snapshot.hasSnapshot || snapshot.courses.length > 0 });
  },
  onCourseTap(event) { wx.navigateTo({ url: `/pages/course-detail/course-detail?id=${encodeURIComponent(event.detail.courseId)}` }); },
  async onCheckin(event) {
    if (this.data.busyId || !this.data.ready) return;
    this.setData({ busyId: event.detail.courseId });
    try {
      await db.addCheckin(event.detail.courseId);
      this.render();
      wx.showToast({ title: '已保存，等待同步', icon: 'none' });
    } catch (error) { pageState.toast(error); }
    finally { this.setData({ busyId: '' }); }
  },
  onAddCourse() {
    if (!this.data.ready) return pageState.toast(new Error('请先连接云端确认登录'));
    wx.navigateTo({ url: '/pages/course-edit/course-edit' });
  }
});
