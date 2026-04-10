// 空状态组件
Component({
  /**
   * 组件属性
   */
  properties: {
    // 空状态类型
    type: {
      type: String,
      value: 'default' // default | compact | full
    },
    // 图标
    icon: {
      type: String,
      value: '🌱'
    },
    // 标题
    title: {
      type: String,
      value: '记录孩子的每一次成长'
    },
    // 描述
    desc: {
      type: String,
      value: '从添加第一节课开始\n记录他们的进步'
    },
    // 是否显示按钮
    showBtn: {
      type: Boolean,
      value: true
    },
    // 按钮文字
    btnText: {
      type: String,
      value: '开始记录'
    },
    // 按钮类型
    btnType: {
      type: String,
      value: 'primary' // primary | secondary
    }
  },

  /**
   * 组件方法
   */
  methods: {
    onTap() {
      this.triggerEvent('tap');
    }
  }
});