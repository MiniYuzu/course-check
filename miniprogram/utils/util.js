// 工具函数

/**
 * 格式化日期
 * @param {Date} date 日期对象
 * @param {string} format 格式模板，默认 'YYYY-MM-DD'
 */
function formatDate(date, format = 'YYYY-MM-DD') {
  if (!date) date = new Date();
  if (typeof date === 'string') date = new Date(date);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return format
    .replace('YYYY', year)
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds);
}

/**
 * 获取今天的日期字符串
 */
function getToday() {
  return formatDate(new Date());
}

function addDays(dateStr, amount) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + amount);
  return formatDate(date);
}

/**
 * 获取星期几
 * @param {Date} date 日期对象
 */
function getWeekday(date) {
  if (!date) date = new Date();
  if (typeof date === 'string') date = new Date(date);

  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return weekdays[date.getDay()];
}

/**
 * 格式化相对时间
 * @param {string|Date} date 日期
 */
function formatRelativeTime(date) {
  if (!date) return '';

  const now = new Date();
  const target = typeof date === 'string' ? new Date(date) : date;
  const diff = now - target;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;

  return formatDate(target);
}

/**
 * 防抖函数
 * @param {Function} fn 要执行的函数
 * @param {number} delay 延迟时间（毫秒）
 */
function debounce(fn, delay = 300) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn.apply(this, args);
    }, delay);
  };
}

/**
 * 节流函数
 * @param {Function} fn 要执行的函数
 * @param {number} interval 间隔时间（毫秒）
 */
function throttle(fn, interval = 300) {
  let lastTime = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastTime >= interval) {
      lastTime = now;
      fn.apply(this, args);
    }
  };
}

/**
 * 生成唯一ID
 */
function generateId() {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 深拷贝
 * @param {any} obj 要拷贝的对象
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (Array.isArray(obj)) return obj.map(item => deepClone(item));

  const cloned = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  return cloned;
}

/**
 * 合并对象
 * @param {Object} target 目标对象
 * @param {Object} source 源对象
 */
function merge(target, source) {
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = target[key] || {};
        merge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
  return target;
}

/**
 * 显示成功提示
 * @param {string} title 提示文字
 * @param {Function} callback 回调函数
 */
function showSuccess(title, callback) {
  wx.showToast({
    title,
    icon: 'success',
    duration: 1500,
    success: callback
  });
}

/**
 * 显示错误提示
 * @param {string} title 提示文字
 */
function showError(title) {
  wx.showToast({
    title,
    icon: 'error',
    duration: 2000
  });
}

/**
 * 显示加载中
 * @param {string} title 提示文字
 */
function showLoading(title = '加载中...') {
  wx.showLoading({ title, mask: true });
}

/**
 * 隐藏加载
 */
function hideLoading() {
  wx.hideLoading();
}

/**
 * 显示确认对话框
 * @param {string} title 标题
 * @param {string} content 内容
 * @param {Object} options 其他选项
 */
function showModal(title, content, options = {}) {
  return new Promise((resolve, reject) => {
    wx.showModal({
      title,
      content,
      showCancel: options.showCancel !== false,
      cancelText: options.cancelText || '取消',
      confirmText: options.confirmText || '确定',
      confirmColor: options.confirmColor || '#2563EB',
      success: (res) => {
        resolve(res.confirm);
      },
      fail: (error) => reject(new Error(error.errMsg || '暂时无法打开确认框，请重试'))
    });
  });
}

/**
 * 计算连续打卡天数
 * @param {Array} checkins 打卡记录数组
 */
function calculateStreak(checkins) {
  if (!checkins || checkins.length === 0) return 0;

  const checkedDates = new Set(checkins.map(c => c.date).filter(Boolean));
  const todayStr = getToday();
  let checkDate = checkedDates.has(todayStr) ? todayStr : addDays(todayStr, -1);

  let streak = 0;
  while (checkedDates.has(checkDate)) {
    streak++;
    checkDate = addDays(checkDate, -1);
  }

  return streak;
}

/**
 * 获取课程类型配置
 * @param {string} type 类型标识
 */
function getCourseTypeConfig(type) {
  const { CONFIG } = require('./config');
  return CONFIG.COURSE_TYPES[type.toUpperCase()] || CONFIG.COURSE_TYPES.OTHER;
}

/**
 * 验证表单数据
 * @param {Object} data 数据对象
 * @param {Object} rules 验证规则
 */
function validate(data, rules) {
  const errors = [];

  for (const field in rules) {
    const value = data[field];
    const rule = rules[field];

    if (rule.required && (!value || value === '')) {
      errors.push(rule.message || `${field}不能为空`);
      continue;
    }

    if (value && rule.minLength && value.length < rule.minLength) {
      errors.push(rule.message || `${field}最少${rule.minLength}个字符`);
    }

    if (value && rule.maxLength && value.length > rule.maxLength) {
      errors.push(rule.message || `${field}最多${rule.maxLength}个字符`);
    }

    if (value && rule.pattern && !rule.pattern.test(value)) {
      errors.push(rule.message || `${field}格式不正确`);
    }
  }

  return errors;
}

module.exports = {
  formatDate,
  addDays,
  getToday,
  getWeekday,
  formatRelativeTime,
  debounce,
  throttle,
  generateId,
  deepClone,
  merge,
  showSuccess,
  showError,
  showLoading,
  hideLoading,
  showModal,
  calculateStreak,
  getCourseTypeConfig,
  validate
};
