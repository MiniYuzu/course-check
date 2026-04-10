// 首页逻辑 - 活力版
Page({
  data: {
    // 连续打卡天数
    streakDays: 12,
    // 课程列表
    courses: [
      {
        id: '1',
        type: 'swim',
        icon: '🏊',
        name: '游泳课',
        schedule: '每周二、四、六',
        completedCount: 12,
        totalCount: 20,
        isCheckedIn: true
      },
      {
        id: '2',
        type: 'piano',
        icon: '🎹',
        name: '钢琴课',
        schedule: '每周一、三、五',
        completedCount: 8,
        totalCount: 20,
        isCheckedIn: false
      }
    ]
  },

  onLoad() {
    // 页面加载时获取数据
    this.loadCourses()
  },

  onShow() {
    // 每次显示时刷新数据
    this.loadCourses()
  },

  // 加载课程数据
  async loadCourses() {
    // TODO: 从云数据库获取
    // const db = wx.cloud.database()
    // const { data } = await db.collection('courses').get()
  },

  // 点击课程卡片
  onCourseTap(e) {
    const { courseId } = e.detail
    wx.navigateTo({
      url: `/pages/course-detail/course-detail?id=${courseId}`
    })
  },

  // 打卡
  async onCheckin(e) {
    const { courseId } = e.detail

    // 调用云函数或直接操作数据库
    wx.showLoading({ title: '打卡中' })

    try {
      // TODO: 调用云函数完成打卡
      // await wx.cloud.callFunction({
      //   name: 'checkin',
      //   data: { courseId }
      // })

      // 更新本地状态
      const courses = this.data.courses.map(course => {
        if (course.id === courseId) {
          return {
            ...course,
            isCheckedIn: true,
            completedCount: course.completedCount + 1
          }
        }
        return course
      })

      this.setData({ courses })

      wx.showToast({
        title: '打卡成功 🎉',
        icon: 'success'
      })

      // 触发连续打卡动画（如果有）
      if (this.shouldUpdateStreak()) {
        this.setData({ streakDays: this.data.streakDays + 1 })
      }

    } catch (err) {
      wx.showToast({
        title: '打卡失败',
        icon: 'error'
      })
    } finally {
      wx.hideLoading()
    }
  },

  // 判断是否更新连续打卡
  shouldUpdateStreak() {
    // TODO: 检查今天是否第一次打卡
    return false
  },

  // 添加课程
  onAddCourse() {
    wx.navigateTo({
      url: '/pages/course-edit/course-edit'
    })
  },

  // Tab 切换
  onTabChange(e) {
    const { tab } = e.detail
    const urlMap = {
      home: '/pages/index/index',
      stats: '/pages/stats/stats',
      achieve: '/pages/achieve/achieve',
      profile: '/pages/profile/profile'
    }

    if (tab !== 'home') {
      wx.switchTab({ url: urlMap[tab] })
    }
  }
})
