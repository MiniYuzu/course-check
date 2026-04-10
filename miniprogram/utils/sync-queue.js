// 同步队列模块 - 离线数据同步
const { CONFIG } = require('./config');
const { ErrorHandler } = require('./error-handler');

// 回调函数存储
const listeners = [];

const SyncQueue = {
  /**
   * 添加操作到队列
   * @param {string} type - 操作类型: checkin | update_course | delete_course | add_course
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

    // 通知监听器
    this.notifyListeners();

    // 触发同步（如果在线）
    this.triggerSync();

    return item._id;
  },

  /**
   * 获取当前队列
   * @returns {Promise<Array>} 队列数组
   */
  async getQueue() {
    try {
      const { data } = await wx.getStorage({ key: CONFIG.STORAGE_KEYS.SYNC_QUEUE });
      return data || [];
    } catch (e) {
      return [];
    }
  },

  /**
   * 保存队列
   * @param {Array} queue - 队列数组
   */
  async saveQueue(queue) {
    await wx.setStorage({
      key: CONFIG.STORAGE_KEYS.SYNC_QUEUE,
      data: queue
    });
  },

  /**
   * 获取队列统计
   * @returns {Promise<Object>} 统计信息
   */
  async getStats() {
    const queue = await this.getQueue();
    return {
      total: queue.length,
      pending: queue.filter(i => i.status === 'pending').length,
      syncing: queue.filter(i => i.status === 'syncing').length,
      synced: queue.filter(i => i.status === 'synced').length,
      failed: queue.filter(i => i.status === 'failed').length
    };
  },

  /**
   * 执行同步
   * @returns {Promise<Object>} 同步结果
   */
  async sync() {
    const queue = await this.getQueue();
    const pending = queue.filter(item => item.status === 'pending' || item.status === 'failed');

    if (pending.length === 0) {
      return { success: true, synced: 0, failed: 0 };
    }

    let synced = 0;
    let failed = 0;

    for (const item of pending) {
      try {
        await this.processItem(item);
        synced++;
      } catch (error) {
        failed++;
        console.error('Sync item failed:', item._id, error);
      }
    }

    // 通知监听器
    this.notifyListeners();

    return { success: failed === 0, synced, failed };
  },

  /**
   * 处理单个队列项
   * @param {Object} item - 队列项
   */
  async processItem(item) {
    // 更新状态为同步中
    item.status = 'syncing';
    await this.updateItem(item);

    try {
      await this.executeOperation(item);

      // 同步成功
      item.status = 'synced';
      item.syncedAt = Date.now();
      await this.updateItem(item);

    } catch (error) {
      item.retryCount++;
      item.lastError = error.message || 'Unknown error';

      if (item.retryCount >= CONFIG.SYNC.MAX_RETRIES) {
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
   * @param {Object} item - 队列项
   */
  async executeOperation(item) {
    switch (item.type) {
      case 'checkin':
        // 调用 checkin 云函数
        const { result: checkinResult } = await wx.cloud.callFunction({
          name: 'checkin',
          data: {
            action: 'checkin',
            courseId: item.payload.courseId,
            date: item.payload.date,
            notes: item.payload.notes,
            mood: item.payload.mood,
            photos: item.payload.photos
          }
        });

        if (!checkinResult.success) {
          // 如果已经打卡，视为成功
          if (checkinResult.code === 409) {
            return { success: true, message: 'Already checked in' };
          }
          throw new Error(checkinResult.message);
        }
        return checkinResult.data;

      case 'cancel_checkin':
        // 调用取消打卡
        const { result: cancelResult } = await wx.cloud.callFunction({
          name: 'checkin',
          data: {
            action: 'cancel',
            courseId: item.payload.courseId,
            date: item.payload.date
          }
        });

        if (!cancelResult.success && cancelResult.code !== 404) {
          throw new Error(cancelResult.message);
        }
        return cancelResult.data;

      case 'add_course':
        // 调用 course 云函数
        const { result: addResult } = await wx.cloud.callFunction({
          name: 'course',
          data: {
            action: 'add',
            name: item.payload.name,
            type: item.payload.type,
            icon: item.payload.icon,
            schedule: item.payload.schedule,
            totalLessons: item.payload.totalLessons,
            notes: item.payload.notes,
            reminder: item.payload.reminder,
            location: item.payload.location,
            teacher: item.payload.teacher
          }
        });

        if (!addResult.success) {
          throw new Error(addResult.message);
        }
        return addResult.data;

      case 'update_course':
        // 调用 course 云函数
        const { result: updateResult } = await wx.cloud.callFunction({
          name: 'course',
          data: {
            action: 'update',
            courseId: item.payload.courseId,
            updates: item.payload.updates
          }
        });

        if (!updateResult.success) {
          throw new Error(updateResult.message);
        }
        return updateResult.data;

      case 'delete_course':
        // 调用 course 云函数
        const { result: deleteResult } = await wx.cloud.callFunction({
          name: 'course',
          data: {
            action: 'delete',
            courseId: item.payload.courseId,
            hardDelete: item.payload.hardDelete
          }
        });

        if (!deleteResult.success) {
          throw new Error(deleteResult.message);
        }
        return deleteResult.data;

      default:
        throw new Error(`Unknown operation type: ${item.type}`);
    }
  },

  /**
   * 更新队列项
   * @param {Object} item - 队列项
   */
  async updateItem(item) {
    const queue = await this.getQueue();
    const index = queue.findIndex(i => i._id === item._id);

    if (index !== -1) {
      queue[index] = item;
      await this.saveQueue(queue);
    }
  },

  /**
   * 删除已同步的队列项
   * @param {number} maxAge - 最大保留时间（毫秒），默认7天
   */
  async cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) {
    const queue = await this.getQueue();
    const now = Date.now();

    const filtered = queue.filter(item => {
      // 保留 pending 和 syncing 状态的
      if (item.status === 'pending' || item.status === 'syncing') {
        return true;
      }

      // 保留 synced 7天内的
      if (item.status === 'synced' && item.syncedAt) {
        return (now - item.syncedAt) < maxAge;
      }

      // 保留 failed 的
      if (item.status === 'failed') {
        return true;
      }

      return false;
    });

    await this.saveQueue(filtered);
  },

  /**
   * 触发同步（如果在线）
   */
  async triggerSync() {
    try {
      const networkType = await wx.getNetworkType();

      if (networkType.networkType !== 'none') {
        // 在线，执行同步
        this.sync().catch(err => {
          console.error('Background sync failed:', err);
        });
      }
    } catch (e) {
      console.error('Check network failed:', e);
    }
  },

  /**
   * 添加状态变化监听器
   * @param {Function} callback - 回调函数
   */
  onChange(callback) {
    listeners.push(callback);
  },

  /**
   * 移除状态变化监听器
   * @param {Function} callback - 回调函数
   */
  offChange(callback) {
    const index = listeners.indexOf(callback);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  },

  /**
   * 通知所有监听器
   */
  notifyListeners() {
    listeners.forEach(callback => {
      try {
        callback();
      } catch (e) {
        console.error('SyncQueue listener error:', e);
      }
    });
  }
};

module.exports = { SyncQueue };
