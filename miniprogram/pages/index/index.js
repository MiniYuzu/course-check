const { db } = require('../../utils/db');
const { today } = require('../../utils/records');
const pageState = require('../../utils/page-state');
const { scheduleLabel, sortHomeCourses } = require('../../utils/attendance-view');

Page({
  data: { courses: [], today: '', todayLessons: 0, nextSession: null, pendingCount: 0, hasData: false, isLoading: true, ready: false, error: '', offline: '', busyId: '' },
  onLoad() { pageState.watch(this); },
  onShow() { return this.loadCourses(); },
  onUnload() { pageState.unwatch(this); },
  onPullDownRefresh() { return this.loadCourses(); },
  loadCourses() { return pageState.load(this); },
  render() {
    const snapshot = db.snapshot();
    const date = today();
    const courses = sortHomeCourses(snapshot.courses.filter(course => !course.isDeleted), date)
      .map(course => ({ ...course, scheduleLabel: scheduleLabel(course, date) }));
    this.setData({ courses, today: date, todayLessons: snapshot.todayLessons, nextSession: snapshot.nextSession, pendingCount: snapshot.pendingCount, hasData: snapshot.hasSnapshot || snapshot.courses.length > 0 });
  },
  onCourseTap(event) { wx.navigateTo({ url: `/pages/course-detail/course-detail?id=${encodeURIComponent(event.detail.courseId)}` }); },
  onNextTap() { if (this.data.nextSession) this.onCourseTap({ detail: { courseId: this.data.nextSession.courseId } }); },
  onPendingTap() { wx.navigateTo({ url: '/pages/attendance/attendance?filter=pending' }); },
  async onCheckin(event) {
    if (this.data.busyId || !this.data.ready) return;
    const course = this.data.courses.find(item => item._id === event.detail.courseId);
    if (course && ['absent', 'cancelled'].includes(course.todayStatus)) return this.onCourseTap(event);
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
