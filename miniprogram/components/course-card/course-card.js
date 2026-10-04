const { getCourseTypeConfig } = require('../../utils/util');

Component({
  properties: {
    courseId: { type: String, value: '' }, type: { type: String, value: 'other' }, icon: { type: String, value: '📖' },
    name: { type: String, value: '' }, schedule: { type: String, value: '' },
    completedCount: { type: Number, value: 0 }, totalCount: { type: Number, value: 0 },
    consumedCount: { type: Number, value: -1 }, todayStatus: { type: String, value: '' },
    isCheckedIn: { type: Boolean, value: false }, syncStatus: { type: String, value: '' }, busy: { type: Boolean, value: false }, disabled: { type: Boolean, value: false }
  },
  data: { progressPercent: 0, remaining: 0, overdrawn: 0, courseGradient: getCourseTypeConfig('other').gradient },
  lifetimes: { attached() { this.calculateProgress(); this.updateTheme(); } },
  observers: {
    'completedCount,consumedCount,totalCount': function () { this.calculateProgress(); },
    type() { this.updateTheme(); }
  },
  methods: {
    updateTheme() { this.setData({ courseGradient: getCourseTypeConfig(this.properties.type || 'other').gradient }); },
    calculateProgress() {
      const { completedCount, totalCount } = this.properties;
      const consumed = this.properties.consumedCount >= 0 ? this.properties.consumedCount : completedCount;
      this.setData({ progressPercent: totalCount ? Math.min(100, Math.round(consumed / totalCount * 100)) : 0, remaining: Math.max(0, totalCount - consumed), overdrawn: totalCount ? Math.max(0, consumed - totalCount) : 0 });
    },
    onCardTap() { this.triggerEvent('cardtap', { courseId: this.properties.courseId }); },
    onCheckinTap() {
      // WXML catchtap stops native propagation; WeChat events are not DOM events.
      if (this.properties.isCheckedIn || this.properties.busy || this.properties.disabled) return;
      if (['absent', 'cancelled'].includes(this.properties.todayStatus)) return this.onCardTap();
      this.triggerEvent('checkin', { courseId: this.properties.courseId });
    }
  }
});
