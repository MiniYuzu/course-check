// 统计页
const { db } = require('../../utils/db');
const { calculateStreak, formatDate, showLoading, hideLoading } = require('../../utils/util');

Page({
  data: {
    totalStats: {
      courses: 0,
      checkins: 0,
      streak: 0,
      thisMonth: 0
    },
    weekData: [],
    courseRanks: [],
    months: [],
    selectedMonthIndex: 0,
    monthStats: {
      total: 0,
      activeDays: 0,
      avgPerWeek: 0
    },
    isLoading: true
  },

  onLoad() {
    this.initMonths();
    this.loadStats();
  },

  onShow() {
    this.loadStats();
  },

  // 初始化月份选择器
  initMonths() {
    const months = [];
    const now = new Date();

    for (let i = 0; i < 12; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      months.push(`${year}年${month}月`);
    }

    this.setData({ months });
  },

  // 加载统计数据
  async loadStats() {
    try {
      showLoading();

      // 获取所有课程
      const courses = await db.getCourses();

      // 获取所有打卡记录
      let allCheckins = [];
      for (const course of courses) {
        const checkins = await db.getCheckins(course._id);
        allCheckins = allCheckins.concat(checkins.map(c => ({
          ...c,
          courseName: course.name,
          courseType: course.type,
          courseIcon: course.icon
        })));
      }

      // 计算总览数据
      const thisMonth = allCheckins.filter(c => {
        const date = new Date(c.date);
        const now = new Date();
        return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
      }).length;

      const streak = calculateStreak(allCheckins);

      this.setData({
        totalStats: {
          courses: courses.length,
          checkins: allCheckins.length,
          streak,
          thisMonth
        }
      });

      // 计算周数据
      this.calculateWeekData(allCheckins);

      // 计算课程排行
      this.calculateCourseRanks(courses, allCheckins);

      // 计算月度统计
      this.calculateMonthStats(allCheckins);

    } catch (error) {
      console.error('Load stats failed:', error);
    } finally {
      hideLoading();
      this.setData({ isLoading: false });
    }
  },

  // 计算周数据
  calculateWeekData(checkins) {
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    const today = new Date();
    const weekData = [];

    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = formatDate(date);
      const dayIndex = date.getDay();

      const count = checkins.filter(c => c.date === dateStr).length;

      weekData.push({
        day: days[dayIndex],
        count,
        percent: Math.max(count * 20, 8) // 最小高度8%
      });
    }

    this.setData({ weekData });
  },

  // 计算课程排行
  calculateCourseRanks(courses, checkins) {
    const maxCount = Math.max(...courses.map(c => {
      return checkins.filter(ch => ch.courseId === c._id).length;
    }), 1);

    const courseRanks = courses.map(course => {
      const count = checkins.filter(c => c.courseId === course._id).length;
      return {
        id: course._id,
        name: course.name,
        type: course.type || 'other',
        icon: course.icon || '📖',
        count,
        progress: Math.round((count / maxCount) * 100)
      };
    }).sort((a, b) => b.count - a.count);

    this.setData({ courseRanks });
  },

  // 计算月度统计
  calculateMonthStats(checkins) {
    const now = new Date();
    const monthCheckins = checkins.filter(c => {
      const date = new Date(c.date);
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    });

    // 活跃天数（去重）
    const activeDays = new Set(monthCheckins.map(c => c.date)).size;

    // 周均课时
    const weekOfMonth = Math.ceil(now.getDate() / 7);
    const avgPerWeek = weekOfMonth > 0 ? Math.round(monthCheckins.length / weekOfMonth * 10) / 10 : 0;

    this.setData({
      monthStats: {
        total: monthCheckins.length,
        activeDays,
        avgPerWeek
      }
    });
  },

  // 切换月份
  onMonthChange(e) {
    const index = parseInt(e.detail.value);
    this.setData({ selectedMonthIndex: index });
    // TODO: 加载对应月份的统计数据
  },

  // Tab 切换
  onTabChange(e) {
    const { tab } = e.detail;
    const urlMap = {
      home: '/pages/index/index',
      stats: '/pages/stats/stats',
      achieve: '/pages/achieve/achieve',
      profile: '/pages/profile/profile'
    };

    if (tab !== 'stats') {
      wx.switchTab({ url: urlMap[tab] });
    }
  }
});
