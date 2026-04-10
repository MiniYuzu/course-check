# 错误处理技术规范

## 设计原则

1. **优雅降级** — 出错时提供最低限度的可用性
2. **用户知情** — 用户必须知道发生了什么，以及能做什么
3. **自动恢复** — 能自动修复的不要麻烦用户
4. **一致体验** — 所有错误使用统一的处理方式

---

## 错误分类

| 类别 | 描述 | 用户可见 | 自动恢复 |
|------|------|----------|----------|
| **网络错误** | 无网络、超时、DNS 失败 | ✅ 是 | ✅ 队列重试 |
| **权限错误** | 未登录、无权限访问 | ✅ 是 | ❌ 需重新授权 |
| **业务错误** | 重复打卡、数据不存在 | ✅ 是 | ❌ 需用户调整 |
| **系统错误** | 服务端异常、数据库错误 | ⚠️ 简化 | ✅ 自动重试 |
| **客户端错误** | 代码异常、数据解析失败 | ⚠️ 简化 | ❌ 需重启 |

---

## 错误码体系

```javascript
const ERROR_CODES = {
  // 网络相关 (1xxx)
  NETWORK_OFFLINE: 1000,
  NETWORK_TIMEOUT: 1001,
  NETWORK_ERROR: 1002,
  
  // 权限相关 (2xxx)
  AUTH_REQUIRED: 2000,
  PERMISSION_DENIED: 2001,
  
  // 业务相关 (3xxx)
  CHECKIN_DUPLICATE: 3000,
  COURSE_NOT_FOUND: 3001,
  INVALID_DATE: 3002,
  
  // 数据相关 (4xxx)
  VALIDATION_ERROR: 4000,
  SYNC_CONFLICT: 4001,
  
  // 系统相关 (5xxx)
  SERVER_ERROR: 5000,
  UNKNOWN_ERROR: 9999
};
```

---

## Error Handler API

```javascript
// error-handler.js

const ErrorHandler = {
  /**
   * 处理错误（主入口）
   * @param {Error} error - 原始错误对象
   * @param {Object} context - 错误上下文 { operation, data, silent }
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
   */
  classify(error) {
    // CloudBase 错误
    if (error.errCode) {
      return this.parseCloudError(error);
    }
    
    // 网络错误
    if (error.message?.includes('network') || error.message?.includes('timeout')) {
      return {
        code: ERROR_CODES.NETWORK_ERROR,
        message: '网络连接不稳定',
        type: 'network',
        retryable: true
      };
    }
    
    // 默认
    return {
      code: ERROR_CODES.UNKNOWN_ERROR,
      message: '操作失败，请重试',
      type: 'unknown',
      retryable: false
    };
  },

  /**
   * 解析 CloudBase 错误
   */
  parseCloudError(error) {
    const codeMap = {
      'DATABASE_PERMISSION_DENIED': {
        code: ERROR_CODES.PERMISSION_DENIED,
        message: '没有权限执行此操作',
        type: 'permission',
        retryable: false
      },
      'NETWORK_TIMEOUT': {
        code: ERROR_CODES.NETWORK_TIMEOUT,
        message: '请求超时，请检查网络',
        type: 'network',
        retryable: true
      },
      'INVALID_PARAM': {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: '数据格式不正确',
        type: 'validation',
        retryable: false
      }
    };
    
    return codeMap[error.errCode] || {
      code: ERROR_CODES.SERVER_ERROR,
      message: '服务繁忙，请稍后重试',
      type: 'server',
      retryable: true
    };
  },

  /**
   * 显示用户反馈
   */
  showUserFeedback(errorInfo, context) {
    const { type, message, retryable } = errorInfo;
    
    switch (type) {
      case 'network':
        this.showNetworkError(message, retryable ? context.retry : null);
        break;
      case 'permission':
        this.showPermissionError(message);
        break;
      case 'business':
        this.showBusinessError(message);
        break;
      default:
        this.showGenericError(message);
    }
  },

  /**
   * 尝试自动恢复
   */
  attemptRecovery(errorInfo, context) {
    if (!errorInfo.retryable) return;
    
    // 网络错误：已由 SyncQueue 处理
    // 其他可恢复错误：延迟重试
    if (context.retry && typeof context.retry === 'function') {
      setTimeout(() => {
        context.retry();
      }, 2000);
    }
  },

  /**
   * 记录错误日志
   */
  log(errorInfo, context) {
    console.error('[Error]', {
      ...errorInfo,
      context,
      timestamp: new Date().toISOString(),
      userInfo: getUserInfo() // 脱敏后的用户信息
    });
    
    // 关键错误上报（可选）
    if (this.shouldReport(errorInfo)) {
      this.report(errorInfo, context);
    }
  }
};
```

---

## 用户反馈 UI

### 网络错误提示

```
┌─────────────────────────────────┐
│  ⚠️ 网络不太稳定                  │
│                                 │
│  打卡记录已保存到本地             │
│  网络恢复后自动同步               │
│                                 │
│  [知道了]  [立即重试]            │
└─────────────────────────────────┘
```

### 权限错误提示

```
┌─────────────────────────────────┐
│  🔒 登录已过期                    │
│                                 │
│  请重新授权以继续使用             │
│                                 │
│  [重新登录]                      │
└─────────────────────────────────┘
```

### 业务错误提示（轻量）

```
┌─────────────────┐
│  ⚡ 今天已经打卡啦  │  ← Toast, 显示 1.5 秒
└─────────────────┘
```

---

## 具体错误处理方案

### 1. 重复打卡

```javascript
// 检查逻辑
async function checkIn(courseId, date) {
  try {
    // 先检查本地缓存
    const existing = await db.checkins.getByCourseAndDate(courseId, date);
    if (existing) {
      throw {
        code: ERROR_CODES.CHECKIN_DUPLICATE,
        message: '今天已经打卡啦',
        type: 'business'
      };
    }
    
    // 执行打卡
    await db.checkins.add({ courseId, date });
    
  } catch (error) {
    ErrorHandler.handle(error, {
      operation: 'checkIn',
      data: { courseId, date },
      silent: error.code === ERROR_CODES.CHECKIN_DUPLICATE
    });
  }
}

// UI 反馈（轻量 Toast）
wx.showToast({
  title: '今天已经打卡啦',
  icon: 'none',
  duration: 1500
});
```

### 2. 网络超时

```javascript
// db.js 集成
const db = {
  async queryWithTimeout(operation, timeout = 5000) {
    return Promise.race([
      operation(),
      new Promise((_, reject) => 
        setTimeout(() => reject({
          code: ERROR_CODES.NETWORK_TIMEOUT,
          message: '请求超时'
        }), timeout)
      )
    ]);
  },
  
  async getCourses() {
    try {
      return await this.queryWithTimeout(
        () => wx.cloud.database().collection('courses').get()
      );
    } catch (error) {
      // 返回缓存数据
      const cached = await this.getCachedCourses();
      if (cached) {
        ErrorHandler.handle(error, {
          operation: 'getCourses',
          silent: true  // 有缓存就不打扰用户
        });
        return cached;
      }
      
      // 无缓存，必须报错
      throw error;
    }
  }
};
```

### 3. 权限被拒绝

```javascript
// 云函数返回权限错误时
async function handlePermissionError() {
  const res = await wx.showModal({
    title: '需要登录',
    content: '您的登录已过期，请重新授权',
    confirmText: '重新登录',
    cancelText: '稍后再说'
  });
  
  if (res.confirm) {
    // 重新登录
    await wx.cloud.callFunction({ name: 'login' });
    // 刷新页面
    wx.reLaunch({ url: '/pages/index/index' });
  }
}
```

---

## 全局错误捕获

### App.js 集成

```javascript
// app.js

App({
  onLaunch() {
    // 全局未捕获 Promise 错误
    wx.onUnhandledRejection((res) => {
      ErrorHandler.handle(res.reason, {
        operation: 'unhandledRejection',
        silent: false
      });
    });
    
    // 全局 JS 错误
    wx.onError((error) => {
      ErrorHandler.handle(new Error(error), {
        operation: 'globalError',
        silent: true  // 避免重复提示
      });
    });
  },
  
  // 页面跳转错误
  onPageNotFound(res) {
    wx.redirectTo({
      url: '/pages/index/index'
    });
  }
});
```

---

## 错误上报（可选）

```javascript
// 关键错误上报到云函数
async function reportError(errorInfo, context) {
  try {
    await wx.cloud.callFunction({
      name: 'logError',
      data: {
        error: errorInfo,
        context: {
          ...context,
          page: getCurrentPages().pop()?.route,
          timestamp: Date.now()
        }
      }
    });
  } catch (e) {
    // 上报失败不打断用户体验
    console.error('Error report failed:', e);
  }
}
```

---

## 使用示例

### 页面中使用

```javascript
// pages/index/index.js

const { ErrorHandler } = require('../../utils/error-handler');

Page({
  async onCheckIn(e) {
    const courseId = e.currentTarget.dataset.id;
    
    try {
      await this.performCheckIn(courseId);
      wx.showToast({ title: '打卡成功', icon: 'success' });
      
    } catch (error) {
      ErrorHandler.handle(error, {
        operation: 'onCheckIn',
        data: { courseId },
        retry: () => this.onCheckIn(e)  // 可重试的操作
      });
    }
  },
  
  async performCheckIn(courseId) {
    const { db } = require('../../utils/db');
    
    // 业务检查
    const today = formatDate(new Date());
    const existing = await db.checkins.getByCourseAndDate(courseId, today);
    
    if (existing) {
      throw {
        code: ERROR_CODES.CHECKIN_DUPLICATE,
        message: '今天已经打卡啦',
        type: 'business'
      };
    }
    
    // 执行打卡（加入同步队列）
    await db.checkins.add({
      courseId,
      date: today,
      createdAt: Date.now()
    });
  }
});
```

---

## 测试检查清单

- [ ] 离线状态下打卡，显示「已保存到本地」
- [ ] 网络恢复后自动同步，状态更新
- [ ] 重复打卡显示 Toast 提示，不报错
- [ ] 权限过期时显示重新登录弹窗
- [ ] 服务端错误时显示「服务繁忙」并可重试
- [ ] 页面未找到时重定向到首页
- [ ] 全局未捕获错误被记录但不闪退

---

*规范版本: 1.0*  
*创建日期: 2026-04-09*
