# 离线同步队列技术规范

## 概述

确保「数据不能丢」的核心机制。当网络不稳定或离线时，操作被队列化，网络恢复后自动同步。

---

## 设计原则

1. **本地优先** — 用户操作立即反映到本地，不等待云端
2. **后台静默同步** — 网络恢复时自动重试，无需用户干预
3. **最终一致性** — 云端和本地最终一致，允许短暂不一致
4. **可观测性** — 用户能感知同步状态（正在同步 / 已同步 / 失败）

---

## 数据模型

### 同步队列项 (SyncQueueItem)

```javascript
{
  _id: "local_timestamp_random",  // 本地唯一ID
  type: "checkin",                // 操作类型: checkin | update_course | delete_course
  status: "pending",              // 状态: pending | syncing | synced | failed
  payload: {                      // 实际操作数据
    courseId: "xxx",
    date: "2026-04-09",
    // ... 其他字段
  },
  retryCount: 0,                  // 重试次数
  lastError: null,                // 上次错误信息
  createdAt: 1712640000000,       // 本地创建时间戳
  syncedAt: null                  // 同步完成时间戳
}
```

### 本地缓存结构

```javascript
// storage keys
const STORAGE_KEYS = {
  SYNC_QUEUE: 'cc_sync_queue',      // 待同步队列
  COURSES_CACHE: 'cc_courses',      // 课程列表缓存
  CHECKINS_CACHE: 'cc_checkins_',   // 打卡记录缓存 (key + courseId)
  LAST_SYNC: 'cc_last_sync'         // 上次同步时间
};
```

---

## 状态流转图

```
用户操作
    │
    ▼
[创建队列项] ──▶ 写入本地缓存
    │
    ▼
[Pending] ◀───────────────────┐
    │                         │
    ▼                         │
[Syncing] ──▶ 调用 CloudBase   │
    │              │           │
    ▼              ▼           │
[Synced] ◀── 成功 ──┘           │
                 │              │
                 ▼              │
[Failed] ◀── 失败 ──────────────┘
    │
    ▼ (重试3次后)
[持久失败] ──▶ 提示用户手动处理
```

---

## API 设计

### SyncQueue 模块

```javascript
// sync-queue.js

const SyncQueue = {
  /**
   * 添加操作到队列
   * @param {string} type - 操作类型
   * @param {Object} payload - 操作数据
   * @returns {Promise<string>} queueItemId
   */
  async enqueue(type, payload) {
    const item = {
      _id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      status: 'pending',
      payload,
      retryCount: 0,
      lastError: null,
      createdAt: Date.now(),
      syncedAt: null
    };
    
    const queue = await this.getQueue();
    queue.push(item);
    await this.saveQueue(queue);
    
    // 触发同步（如果在线）
    this.triggerSync();
    
    return item._id;
  },

  /**
   * 获取当前队列
   */
  async getQueue() {
    const { data } = await wx.getStorage({ key: STORAGE_KEYS.SYNC_QUEUE });
    return data || [];
  },

  /**
   * 执行同步
   */
  async sync() {
    const queue = await this.getQueue();
    const pending = queue.filter(item => item.status === 'pending');
    
    for (const item of pending) {
      await this.processItem(item);
    }
  },

  /**
   * 处理单个队列项
   */
  async processItem(item) {
    item.status = 'syncing';
    await this.updateItem(item);

    try {
      await this.executeOperation(item);
      
      item.status = 'synced';
      item.syncedAt = Date.now();
      await this.updateItem(item);
      
    } catch (error) {
      item.retryCount++;
      item.lastError = error.message;
      
      if (item.retryCount >= 3) {
        item.status = 'failed';
      } else {
        item.status = 'pending';
      }
      
      await this.updateItem(item);
      throw error;
    }
  },

  /**
   * 执行具体操作
   */
  async executeOperation(item) {
    const { db } = require('./db');
    
    switch (item.type) {
      case 'checkin':
        return await db.checkins.add(item.payload);
      case 'update_course':
        return await db.courses.update(item.payload._id, item.payload);
      case 'delete_course':
        return await db.courses.remove(item.payload._id);
      default:
        throw new Error(`Unknown operation type: ${item.type}`);
    }
  }
};
```

---

## 重试策略

### 指数退避

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,  // 1秒
  maxDelay: 30000   // 30秒
};

function getRetryDelay(retryCount) {
  const delay = RETRY_CONFIG.baseDelay * Math.pow(2, retryCount);
  return Math.min(delay, RETRY_CONFIG.maxDelay);
}

// 重试时添加随机抖动，避免 thundering herd
function getJitteredDelay(retryCount) {
  const delay = getRetryDelay(retryCount);
  const jitter = Math.random() * 1000;
  return delay + jitter;
}
```

---

## 网络状态监听

```javascript
// app.js 或专用网络模块

class NetworkMonitor {
  constructor() {
    this.isOnline = true;
    this.syncQueue = SyncQueue;
    
    // 监听网络状态变化
    wx.onNetworkStatusChange((res) => {
      this.isOnline = res.isConnected;
      
      if (res.isConnected) {
        // 网络恢复，触发同步
        this.syncQueue.sync();
      }
    });
    
    // 应用前台时检查同步
    wx.onAppShow(() => {
      if (this.isOnline) {
        this.syncQueue.sync();
      }
    });
  }
  
  async checkOnline() {
    try {
      await wx.getNetworkType();
      return true;
    } catch {
      return false;
    }
  }
}
```

---

## 冲突解决策略

### 场景：重复打卡

**问题：** 用户离线时打卡，云端已有同一天的记录

**解决方案：**

```javascript
async function resolveCheckinConflict(localItem, cloudItem) {
  // 策略：以最新的为准
  if (localItem.createdAt > cloudItem.createdAt) {
    // 本地较新，覆盖云端
    await db.checkins.update(cloudItem._id, localItem.payload);
  }
  // 否则保留云端，本地标记为已同步
}
```

### 数据库唯一索引

```javascript
// CloudBase 数据库索引
checkins.createIndex({
  courseId: 1,
  date: 1
}, {
  unique: true,
  partialFilterExpression: {
    date: { $exists: true }
  }
});
```

---

## UI 状态指示

### 同步状态组件

```
┌─────────────────────────────────┐
│  🔄 正在同步...                  │  ← syncing
│  ✓ 已同步至云端                  │  ← synced (显示1.5秒后消失)
│  ⚠️ 2条记录待同步                │  ← pending > 0
│  ✗ 同步失败，点击重试            │  ← failed
└─────────────────────────────────┘
```

### 实现代码

```javascript
// components/sync-status/sync-status.js

Component({
  data: {
    status: 'synced', // synced | syncing | pending | failed
    pendingCount: 0
  },
  
  lifetimes: {
    attached() {
      this.updateStatus();
      // 监听队列变化
      SyncQueue.onChange(() => this.updateStatus());
    }
  },
  
  methods: {
    async updateStatus() {
      const queue = await SyncQueue.getQueue();
      const pending = queue.filter(i => i.status === 'pending');
      const failed = queue.filter(i => i.status === 'failed');
      
      if (failed.length > 0) {
        this.setData({ status: 'failed', pendingCount: failed.length });
      } else if (pending.length > 0) {
        this.setData({ status: 'pending', pendingCount: pending.length });
      } else {
        this.setData({ status: 'synced', pendingCount: 0 });
      }
    },
    
    async onTap() {
      if (this.data.status === 'failed') {
        await SyncQueue.sync();
      }
    }
  }
});
```

---

## 数据完整性保证

### 本地数据优先读取

```javascript
// db.js 封装示例

const db = {
  async getCourses() {
    // 1. 先读本地缓存（立即返回）
    const cached = await this.getCachedCourses();
    
    // 2. 后台刷新云端数据
    this.refreshFromCloud().then(cloudData => {
      if (cloudData) {
        this.cacheCourses(cloudData);
      }
    });
    
    return cached || [];
  },
  
  async addCheckin(data) {
    // 1. 立即写入本地缓存
    await this.addLocalCheckin(data);
    
    // 2. 加入同步队列
    await SyncQueue.enqueue('checkin', data);
    
    // 3. 返回成功（不等待云端）
    return { success: true, localId: data._id };
  }
};
```

---

## 测试要点

| 场景 | 测试步骤 | 预期结果 |
|------|----------|----------|
| 离线打卡 | 关闭网络 → 打卡 → 查看队列 | 队列项状态为 pending |
| 网络恢复 | 开启网络 → 等待同步 | 云端出现打卡记录，状态 synced |
| 重复打卡 | 离线打卡2次同一天 → 恢复网络 | 云端只有1条记录（冲突解决） |
| 失败重试 | 模拟网络错误 → 观察重试 | 重试3次后标记 failed |
| 应用重启 | 杀掉进程 → 重新打开 | 未同步数据仍在队列中 |

---

## 实现检查清单

- [ ] SyncQueue 模块实现
- [ ] 队列持久化到 wx.storage
- [ ] 网络状态监听
- [ ] 应用生命周期监听（onAppShow 触发同步）
- [ ] 指数退避重试策略
- [ ] 冲突解决逻辑
- [ ] 同步状态 UI 组件
- [ ] db.js 集成队列写入
- [ ] 唯一索引创建（courseId + date）

---

*规范版本: 1.0*  
*创建日期: 2026-04-09*
