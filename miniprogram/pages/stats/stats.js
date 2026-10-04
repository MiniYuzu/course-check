const { db } = require('../../utils/db');
const { today, summarize, isDatedRecord } = require('../../utils/records');
const pageState = require('../../utils/page-state');
const { attendanceStatus, attendanceOverview } = require('../../utils/attendance');
Page({
  data: { month: today().slice(0, 7), today: today(), summary: {}, monthRecords: [], visibleRecords: [], visibleCount: 30, monthCourses: [], activeDays: 0, weekTotal: 0, monthAbsentCount: 0, monthPendingCount: 0, hasData: false, isLoading: true, ready: false, error: '', offline: '' },
  onLoad() { pageState.watch(this); },
  onShow() { return this.loadStats(); },
  onUnload() { pageState.unwatch(this); },
  onPullDownRefresh() { return this.loadStats(); },
  loadStats() { return pageState.load(this); },
  render() {
    const snapshot = db.snapshot();
    const date = today();
    const summary = summarize(snapshot.courses, snapshot.checkins, this.data.month, date);
    summary.week = summary.week.map(item => ({ ...item, isToday: item.date === date, label: item.date === date ? '今天' : item.label }));
    const overview = attendanceOverview(snapshot.courses, snapshot.rawCheckins, { month: this.data.month });
    const monthRecords = summary.checkins.filter(item => attendanceStatus(item) === 'attended' && isDatedRecord(item) && item.date.startsWith(this.data.month)).map(item => {
      const course = summary.courses.find(value => value._id === item.courseId);
      return { ...item, courseName: course ? course.name : '历史课程', icon: course ? course.icon : '📖', archived: course && course.isDeleted };
    });
    const monthCourses = summary.courses.filter(course => course.monthCount > 0);
    const peak = Math.max(1, ...monthCourses.map(course => course.monthCount));
    this.setData({ summary, monthRecords, monthAbsentCount: overview.monthAbsentCount, monthPendingCount: overview.monthPendingCount, visibleRecords: monthRecords.slice(0, this.data.visibleCount), monthCourses: monthCourses.map(course => ({ ...course, monthPercent: Math.round(course.monthCount / peak * 100) })), activeDays: new Set(monthRecords.map(item => item.date)).size, today: date, weekTotal: summary.week.reduce((total, item) => total + item.count, 0), hasData: snapshot.hasSnapshot || snapshot.courses.length > 0 || snapshot.checkins.length > 0 });
  },
  onMonthChange(event) { this.setData({ month: event.detail.value, visibleCount: 30 }); this.render(); },
  onLoadMore() { this.setData({ visibleCount: this.data.visibleCount + 30 }); this.render(); },
  onAttendanceTap(event) { wx.navigateTo({ url: '/pages/attendance/attendance?filter=' + encodeURIComponent(event.currentTarget.dataset.filter) + '&month=' + encodeURIComponent(this.data.month) }); },
  onCourseTap(event) { wx.navigateTo({ url: `/pages/course-detail/course-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); }
});
