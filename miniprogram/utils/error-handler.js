// 错误处理模块
const { CONFIG } = require('./config');
const { showError, showModal } = require('./util');

const ErrorHandler = {
  /**
   * 处理错误（主入口）
   * @param {Error|Object} error - 原始错误对象
   * @param {Object} context - 错误上下文 { operation, data, silent, retry }
   * @returns {Object} 错误信息对象
   */
  handle(error, context = {}) {
    const errorInfo = this.classify(error);

    // 记录日志
    this.log(errorInfo, context);

    // 静默模式不显示给用户
    if (context.silent) return errorInfo;

    // 显示用户友好的错误
    this.showUserFeedback(errorInfo, context);

    // 尝试自动恢复
    this.attemptRecovery(errorInfo, context);

    return errorInfo;
  },

  /**
   * 错误分类
   * @param {Error|Object} error - 错误对象
   * @returns {Object} 标准化的错误信息
   */
  classify(error) {
    // CloudBase 错误
    if (error.errCode) {
      return this.parseCloudError(error);
    }

    // 业务错误（自定义错误码）
    if (error.code && CONFIG.ERROR_CODES[Object.keys(CONFIG.ERROR_CODES).find(k => CONFIG.ERROR_CODES[k] === error.code)]) {
      return this.parseBusinessError(error);
    }

    // 网络错误
    if (error.message?.includes('network') ||
        error.message?.includes('timeout') ||
        error.message?.includes('fail') ||
        error.message?.includes('连接')) {
      return {
        code: CONFIG.ERROR_CODES.NETWORK_ERROR,
        message: '网络连接不稳定',
        type: 'network',
        retryable: true,
        original: error
      };
    }

    // 权限错误
    if (error.message?.includes('permission') ||
        error.message?.includes('auth') ||
        error.message?.includes('登录') ||
        error.message?.includes('权限')) {
      return {
        code: CONFIG.ERROR_CODES.PERMISSION_DENIED,
        message: '没有权限执行此操作',
        type: 'permission',
        retryable: false,
        original: error
      };
    }

    // 默认错误
    return {
      code: CONFIG.ERROR_CODES.UNKNOWN_ERROR,
      message: error.message || '操作失败，请重试',
      type: 'unknown',
      retryable: false,
      original: error
    };
  },

  /**
   * 解析 CloudBase 错误
   * @param {Object} error - CloudBase 错误对象
   */
  parseCloudError(error) {
    const codeMap = {
      'DATABASE_PERMISSION_DENIED': {
        code: CONFIG.ERROR_CODES.PERMISSION_DENIED,
        message: '没有权限执行此操作',
        type: 'permission',
        retryable: false
      },
      'NETWORK_TIMEOUT': {
        code: CONFIG.ERROR_CODES.NETWORK_TIMEOUT,
        message: '请求超时，请检查网络',
        type: 'network',
        retryable: true
      },
      'NETWORK_ERROR': {
        code: CONFIG.ERROR_CODES.NETWORK_ERROR,
        message: '网络连接失败',
        type: 'network',
        retryable: true
      },
      'INVALID_PARAM': {
        code: CONFIG.ERROR_CODES.VALIDATION_ERROR,
        message: '数据格式不正确',
        type: 'validation',
        retryable: false
      },
      'DATABASE_TRANSACTION_FAIL': {
        code: CONFIG.ERROR_CODES.SERVER_ERROR,
        message: '数据库操作失败',
        type: 'server',
        retryable: true
      }
    };

    const mapped = codeMap[error.errCode];
    if (mapped) {
      return { ...mapped, original: error };
    }

    return {
      code: CONFIG.ERROR_CODES.SERVER_ERROR,
      message: '服务繁忙，请稍后重试',
      type: 'server',
      retryable: true,
      original: error
    };
  },

  /**
   * 解析业务错误
   * @param {Object} error - 业务错误对象
   */
  parseBusinessError(error) {
    const typeMap = {
      [CONFIG.ERROR_CODES.CHECKIN_DUPLICATE]: 'business',
      [CONFIG.ERROR_CODES.COURSE_NOT_FOUND]: 'business',
      [CONFIG.ERROR_CODES.INVALID_DATE]: 'validation'
    };

    return {
      code: error.code,
      message: error.message,
      type: typeMap[error.code] || 'business',
      retryable: false,
      original: error
    };
  },

  /**
   * 显示用户反馈
   * @param {Object} errorInfo - 错误信息
   * @param {Object} context - 上下文
   */
  showUserFeedback(errorInfo, context) {
    const { type, message, retryable } = errorInfo;

    switch (type) {
      case 'network':
        this.showNetworkError(message, retryable ? context.retry : null);
        break;
      case 'permission':
        this.showPermissionError(message, context);
        break;
      case 'business':
        // 业务错误使用轻量 Toast
        wx.showToast({
          title: message,
          icon: 'none',
          duration: 2000
        });
        break;
      case 'validation':
        wx.showToast({
          title: message,
          icon: 'none',
          duration: 2000
        });
        break;
      default:
        showError(message);
    }
  },

  /**
   * 显示网络错误
   * @param {string} message - 错误消息
   * @param {Function} retryCallback - 重试回调
   */
  showNetworkError(message, retryCallback) {
    const content = retryCallback
      ? '打卡记录已保存到本地，网络恢复后自动同步'
      : '请检查网络连接后重试';

    showModal('网络不太稳定', content, {
      confirmText: retryCallback ? '立即重试' : '知道了',
      showCancel: !!retryCallback,
      cancelText: '知道了'
    }).then(confirmed => {
      if (confirmed && retryCallback) {
        retryCallback();
      }
    });
  },

  /**
   * 显示权限错误
   * @param {string} message - 错误消息
   * @param {Object} context - 上下文
   */
  showPermissionError(message, context) {
    showModal('需要登录', '您的登录已过期，请重新授权以继续使用', {
      confirmText: '重新登录',
      cancelText: '稍后再说'
    }).then(confirmed => {
      if (confirmed) {
        // 重新登录
        wx.cloud.callFunction({ name: 'login' })
          .then(() => {
            // 刷新页面
            wx.reLaunch({ url: '/pages/index/index' });
          })
          .catch(err => {
            console.error('重新登录失败:', err);
            showError('登录失败，请稍后重试');
          });
      }
    });
  },

  /**
   * 尝试自动恢复
   * @param {Object} errorInfo - 错误信息
   * @param {Object} context - 上下文
   */
  attemptRecovery(errorInfo, context) {
    if (!errorInfo.retryable) return;

    // 网络错误：已由 SyncQueue 处理
    // 其他可恢复错误：延迟重试
    if (context.retry && typeof context.retry === 'function') {
      const delay = Math.min(
        CONFIG.SYNC.BASE_DELAY * Math.pow(2, context.retryCount || 0),
        CONFIG.SYNC.MAX_DELAY
      );

      setTimeout(() => {
        context.retry();
      }, delay);
    }
  },

  /**
   * 记录错误日志
   * @param {Object} errorInfo - 错误信息
   * @param {Object} context - 上下文
   */
  log(errorInfo, context) {
    const logData = {
      ...errorInfo,
      context: {
        operation: context.operation,
        data: context.data,
        timestamp: new Date().toISOString()
      }
    };

    console.error('[ErrorHandler]', logData);

    // 关键错误上报
    if (this.shouldReport(errorInfo)) {
      this.report(errorInfo, context);
    }
  },

  /**
   * 判断是否应该上报错误
   * @param {Object} errorInfo - 错误信息
   */
  shouldReport(errorInfo) {
    // 只上报服务器错误和未知错误
    return errorInfo.type === 'server' || errorInfo.type === 'unknown';
  },

  /**
   * 上报错误到云函数
   * @param {Object} errorInfo - 错误信息
   * @param {Object} context - 上下文
   */
  async report(errorInfo, context) {
    try {
      await wx.cloud.callFunction({
        name: 'logError',
        data: {
          error: {
            code: errorInfo.code,
            message: errorInfo.message,
            type: errorInfo.type
          },
          context: {
            operation: context.operation,
            page: getCurrentPages().pop()?.route,
            timestamp: Date.now()
          }
        }
      });
    } catch (e) {
      // 上报失败不打断用户体验
      console.error('Error report failed:', e);
    }
  },

  /**
   * 全局错误处理（用于 app.js）
   * @param {Error} error - 错误对象
   * @param {string} type - 错误类型
   */
  handleGlobal(error, type = 'unknown') {
    console.error(`[Global ${type}]`, error);

    this.handle(error, {
      operation: `global_${type}`,
      silent: type === 'unhandledRejection' // 静默处理未捕获的 Promise 错误
    });
  }
};

module.exports = { ErrorHandler };
