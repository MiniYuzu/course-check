// 课程卡片组件 - 活力版
Component({
  /**
   * 组件属性
   */
  properties: {
    // 课程ID
    courseId: {
      type: String,
      value: ''
    },
    // 课程类型（决定渐变色）
    type: {
      type: String,
      value: 'swim' // swim, piano, english
    },
    // 图标
    icon: {
      type: String,
      value: '🏊'
    },
    // 课程名称
    name: {
      type: String,
      value: '课程名称'
    },
    // 上课时间
    schedule: {
      type: String,
      value: '每周二、四'
    },
    // 已完成课时
    completedCount: {
      type: Number,
      value: 0
    },
    // 总课时
    totalCount: {
      type: Number,
      value: 20
    },
    // 今日是否已打卡
    isCheckedIn: {
      type: Boolean,
      value: false
    }
  },

  /**
   * 组件数据
   */
  data: {
    progressPercent: 0
  },

  /**
   * 生命周期
   */
  lifetimes: {
    attached() {
      this.calculateProgress()
    }
  },

  /**
   * 数据监听器
   */
  observers: {
    'completedCount, totalCount': function(completed, total) {
      this.calculateProgress()
    }
  },

  /**
   * 组件方法
   */
  methods: {
    // 计算进度百分比
    calculateProgress() {
      const { completedCount, totalCount } = this.properties
      let percent = 0
      if (totalCount > 0) {
        percent = Math.round((completedCount / totalCount) * 100)
      }
      this.setData({ progressPercent: percent })
    },

    // 点击卡片
    onCardTap() {
      const { courseId } = this.properties
      this.triggerEvent('cardtap', { courseId })
    },

    // 点击打卡按钮
    onCheckinTap(e) {
      // 阻止冒泡，避免触发卡片点击
      e.stopPropagation()

      const { courseId, isCheckedIn } = this.properties
      if (isCheckedIn) return

      this.triggerEvent('checkin', { courseId })
    }
  }
})
