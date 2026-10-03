// Tab Bar 组件 - 活力版
Component({
  /**
   * 组件属性
   */
  properties: {
    // 当前选中的 tab
    current: {
      type: String,
      value: 'home'
    },
    // 是否需要安全区域填充
    safeArea: {
      type: Boolean,
      value: true
    }
  },

  /**
   * 组件方法
   */
  methods: {
    onTabTap(e) {
      const { tab } = e.currentTarget.dataset
      if (tab === this.properties.current) return

      this.triggerEvent('change', { tab })
    }
  }
})
