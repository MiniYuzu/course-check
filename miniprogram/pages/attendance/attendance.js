const { db } = require('../../utils/db');
const { today } = require('../../utils/records');
const { courseTimeline } = require('../../utils/attendance');
const { filters, monthBounds, displayRow } = require('../../utils/attendance-view');
const pageState = require('../../utils/page-state');
Page({
  data: { filters, filter: 'pending', month: '', today: '', records: [], visibleRecords: [], visibleCount: 30, isLoading: true, ready: false, error: '', offline: '', attendanceOpen: false, attendanceRow: null },
  onLoad(options) { this.setData({ filter: filters.some(item => item.value === options.filter) ? options.filter : 'pending', month: /^\d{4}-(0[1-9]|1[0-2])$/.test(options.month || '') ? options.month : '', today: today() }); pageState.watch(this); },
  onShow() { return this.loadAttendance(); },
  onUnload() { pageState.unwatch(this); },
  onPullDownRefresh() { return this.loadAttendance(); },
  loadAttendance() { return pageState.load(this); },
  render() {
    const snapshot = db.snapshot();
    const rows = snapshot.courses.flatMap(course => courseTimeline(course, snapshot.rawCheckins, monthBounds(this.data.month)).filter(row => !course.isDeleted || ['attended', 'absent', 'cancelled'].includes(row.status)).map(row => displayRow({ ...row, archived: course.isDeleted })));
    const records = rows.filter(row => this.data.filter === 'all' || row.status === this.data.filter).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.courseId).localeCompare(String(b.courseId)));
    this.setData({ records, visibleRecords: records.slice(0, this.data.visibleCount), today: today() });
  },
  onFilterTap(event) { this.setData({ filter: event.currentTarget.dataset.filter, visibleCount: 30 }); this.render(); },
  onMonthChange(event) { this.setData({ month: event.detail.value, visibleCount: 30 }); this.render(); },
  onAllMonths() { this.setData({ month: '', visibleCount: 30 }); this.render(); },
  onLoadMore() { this.setData({ visibleCount: this.data.visibleCount + 30 }); this.render(); },
  onOpenAttendance(event) { if (!this.data.ready) return; const row = this.data.records.find(item => item.key === event.currentTarget.dataset.key); if (row && row.canConfirm) this.setData({ attendanceOpen: true, attendanceRow: { ...row } }); },
  onCloseAttendance() { this.setData({ attendanceOpen: false, attendanceRow: null }); },
  onAttendanceSaved() { this.render(); },
  onCourseTap(event) { wx.navigateTo({ url: '/pages/course-detail/course-detail?id=' + encodeURIComponent(event.currentTarget.dataset.id) }); }
});
