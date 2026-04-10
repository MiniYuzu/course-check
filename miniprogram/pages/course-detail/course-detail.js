// 课程详情页
const { db } = require('../../utils/db');
const { formatDate, getToday, showModal, showSuccess, showError, showLoading, hideLoading } = require('../../utils/util');
const { getCourseTypeConfig } = require('../../utils/util');

Page({
  data: {
    courseId: '',
    course: {},
    courseType: 'swim',
    stats: {
      total: 0,
      thisMonth: 0
    },
    progressPercent: 0,
    checkins: [],
    isLoading: true,
    isRefreshing: false,
    isCheckedInToday: false,
    showActionSheet: false
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ courseId: options.id });
      this.loadCourseDetail();
    } else {
      showError('课程ID不存在');
      wx.navigateBack();
    }
  },

  onShow() {
    // 刷新数据
    if (this.data.courseId) {
      this.loadCourseDetail();
    }
  },

  // 加载课程详情
  async loadCourseDetail() {
    try {
      showLoading();

      // 获取课程信息
      const course = await db.getCourse(this.data.courseId);

      // 获取打卡记录
      const checkins = await db.getCheckins(this.data.courseId);

      // 处理打卡记录
      const processedCheckins = checkins.map((item, index) => {
        const date = new Date(item.date);
        return {
          ...item,
          day: date.getDate(),
          month: date.getMonth() + 1,
          number: checkins.length - index
        };
      });

      // 检查今天是否已打卡
      const today = getToday();
      const isCheckedInToday = checkins.some(c => c.date === today);

      // 计算统计数据
      const thisMonth = checkins.filter(c => {
        const date = new Date(c.date);
        const now = new Date();
        return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
      }).length;

      // 获取课程类型配置
      const typeConfig = getCourseTypeConfig(course.type || 'other');

      // 计算进度
      let progressPercent = 0;
      if (course.totalLessons && course.totalLessons > 0) {
        progressPercent = Math.round((checkins.length / course.totalLessons) * 100);
      }

      this.setData({
        course,
        courseType: typeConfig.type,
        stats: {
          total: checkins.length,
          thisMonth
        },
        progressPercent,
        checkins: processedCheckins,
        isCheckedInToday,
        isLoading: false
      });

    } catch (error) {
      console.error('Load course detail failed:', error);
      showError('加载失败');
    } finally {
      hideLoading();
      this.setData({ isRefreshing: false });
    }
  },

  // 下拉刷新
  onRefresh() {
    this.setData({ isRefreshing: true });
    this.loadCourseDetail();
  },

  // 打卡
  async onCheckin() {
    if (this.data.isCheckedInToday) {
      showError('今天已经打卡啦');
      return;
    }

    try {
      showLoading('打卡中...');

      await db.addCheckin(this.data.courseId, {
        date: getToday(),
        simple: true
      });

      showSuccess('打卡成功 🎉');

      // 刷新数据
      this.loadCourseDetail();

    } catch (error) {
      if (error.code === 3000) {
        // 重复打卡
        showError('今天已经打卡啦');
      } else {
        showError('打卡失败');
      }
    } finally {
      hideLoading();
    }
  },

  // 点击打卡记录
  onCheckinTap(e) {
    const checkinId = e.currentTarget.dataset.id;
    // 可以跳转到打卡详情页
    console.log('Checkin tapped:', checkinId);
  },

  // 返回
  onBack() {
    wx.navigateBack();
  },

  // 更多操作
  onMore() {
    this.setData({ showActionSheet: true });
  },

  // 关闭操作菜单
  onCloseAction() {
    this.setData({ showActionSheet: false });
  },

  // 阻止冒泡
  onPreventBubble() {
    // 什么都不做，只是阻止冒泡
  },

  // 编辑课程
  onEdit() {
    this.setData({ showActionSheet: false });
    wx.navigateTo({
      url: `/pages/course-edit/course-edit?id=${this.data.courseId}`
    });
  },

  // 分享课程
  onShare() {
    this.setData({ showActionSheet: false });
    // 实现分享逻辑
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    });
  },

  // 删除课程
  async onDelete() {
    this.setData({ showActionSheet: false });

    const confirmed = await showModal(
      '删除课程',
      `确定要删除「${this.data.course.name}」吗？相关的所有打卡记录也会被删除。`,
      { confirmText: '删除', confirmColor: '#EF4444' }
    );

    if (confirmed) {
      try {
        showLoading('删除中...');
        await db.deleteCourse(this.data.courseId);
        showSuccess('删除成功');
        wx.navigateBack();
      } catch (error) {
        console.error('Delete course failed:', error);
        showError('删除失败');
      } finally {
        hideLoading();
      }
    }
  },

  // 分享
  onShareAppMessage() {
    return {
      title: `${this.data.course.name} - 已上${this.data.stats.total}节课`,
      path: `/pages/course-detail/course-detail?id=${this.data.courseId}`
    };
  }
});