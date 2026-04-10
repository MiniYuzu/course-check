// 添加/编辑课程页
const { db } = require('../../utils/db');
const { showSuccess, showError, showLoading, hideLoading } = require('../../utils/util');
const { CONFIG } = require('../../utils/config');

Page({
  data: {
    isEdit: false,
    courseId: '',
    course: {
      name: '',
      type: 'swim',
      icon: '🏊',
      totalLessons: '',
      schedule: '',
      notes: '',
      reminder: false,
      reminderTime: 60 // 默认提前1小时
    },
    selectedType: 'swim',
    showAdvanced: false,
    reminderOptions: ['课前15分钟', '课前30分钟', '课前1小时', '课前2小时'],
    reminderIndex: 2,
    canSave: false,
    courseTypes: [
      { type: 'swim', name: '游泳', icon: '🏊' },
      { type: 'piano', name: '钢琴', icon: '🎹' },
      { type: 'english', name: '英语', icon: '📚' },
      { type: 'art', name: '美术', icon: '🎨' },
      { type: 'dance', name: '舞蹈', icon: '💃' },
      { type: 'sports', name: '运动', icon: '⚽' },
      { type: 'music', name: '音乐', icon: '🎵' },
      { type: 'other', name: '其他', icon: '📖' }
    ]
  },

  onLoad(options) {
    if (options.id) {
      // 编辑模式
      this.setData({ isEdit: true, courseId: options.id });
      this.loadCourse();
    }
  },

  // 加载课程信息
  async loadCourse() {
    try {
      showLoading();
      const course = await db.getCourse(this.data.courseId);

      // 找到对应的类型索引
      const typeIndex = this.data.courseTypes.findIndex(t => t.type === course.type);

      this.setData({
        course: {
          ...course,
          totalLessons: course.totalLessons || ''
        },
        selectedType: course.type || 'other',
        canSave: true
      });

    } catch (error) {
      console.error('Load course failed:', error);
      showError('加载失败');
    } finally {
      hideLoading();
    }
  },

  // 选择类型
  onSelectType(e) {
    const type = e.currentTarget.dataset.type;
    const typeConfig = this.data.courseTypes.find(t => t.type === type);

    this.setData({
      selectedType: type,
      'course.type': type,
      'course.icon': typeConfig.icon
    });

    this.checkCanSave();
  },

  // 输入课程名称
  onNameInput(e) {
    this.setData({
      'course.name': e.detail.value
    });
    this.checkCanSave();
  },

  // 输入总课时
  onTotalLessonsInput(e) {
    this.setData({
      'course.totalLessons': e.detail.value
    });
  },

  // 输入上课时间
  onScheduleInput(e) {
    this.setData({
      'course.schedule': e.detail.value
    });
  },

  // 输入备注
  onNotesInput(e) {
    this.setData({
      'course.notes': e.detail.value
    });
  },

  // 切换高级选项
  toggleAdvanced() {
    this.setData({
      showAdvanced: !this.data.showAdvanced
    });
  },

  // 切换提醒
  onReminderChange(e) {
    this.setData({
      'course.reminder': e.detail.value
    });
  },

  // 选择提醒时间
  onReminderTimeChange(e) {
    const index = parseInt(e.detail.value);
    const minutesMap = [15, 30, 60, 120];

    this.setData({
      reminderIndex: index,
      'course.reminderTime': minutesMap[index]
    });
  },

  // 检查是否可以保存
  checkCanSave() {
    const { course, selectedType } = this.data;
    const canSave = course.name.trim() && selectedType;
    this.setData({ canSave });
  },

  // 保存
  async onSave() {
    if (!this.data.canSave) return;

    try {
      showLoading('保存中...');

      const courseData = {
        ...this.data.course,
        type: this.data.selectedType,
        totalLessons: this.data.course.totalLessons ? parseInt(this.data.course.totalLessons) : null
      };

      if (this.data.isEdit) {
        // 更新
        await db.updateCourse(this.data.courseId, courseData);
        showSuccess('保存成功');
      } else {
        // 新增
        const newCourse = await db.addCourse(courseData);
        showSuccess('添加成功');
      }

      // 返回上一页
      setTimeout(() => {
        wx.navigateBack();
      }, 500);

    } catch (error) {
      console.error('Save course failed:', error);
      showError('保存失败');
    } finally {
      hideLoading();
    }
  },

  // 返回
  onBack() {
    wx.navigateBack();
  }
});
