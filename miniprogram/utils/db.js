// 数据库层 - 封装 Cloud Function 操作，支持离线优先
const { CONFIG } = require('./config');
const { SyncQueue } = require('./sync-queue');
const { ErrorHandler } = require('./error-handler');
const { formatDate, generateId } = require('./util');

// API 调用封装
const callCloudFunction = async (name, data) => {
  try {
    const { result } = await wx.cloud.callFunction({
      name,
      data
    });

    if (!result.success) {
      const error = new Error(result.message);
      error.code = result.code;
      throw error;
    }

    return result.data;
  } catch (error) {
    console.error(`Cloud function ${name} error:`, error);
    throw error;
  }
};

const db = {
  // ========== 登录相关 ==========

  /**
   * 用户登录
   * @param {Object} userInfo - 用户信息
   */
  async login(userInfo = {}) {
    const data = await callCloudFunction('login', {
      nickName: userInfo.nickName || '',
      avatarUrl: userInfo.avatarUrl || ''
    });

    // 缓存用户信息
    await wx.setStorage({
      key: CONFIG.STORAGE_KEYS.USER_INFO,
      data: data
    });

    return data;
  },

  /**
   * 获取缓存的用户信息
   */
  async getCachedUserInfo() {
    try {
      const { data } = await wx.getStorage({ key: CONFIG.STORAGE_KEYS.USER_INFO });
      return data;
    } catch (e) {
      return null;
    }
  },

  // ========== 课程相关操作 ==========

  /**
   * 获取课程列表
   * @param {boolean} forceRefresh - 强制从云端刷新
   * @returns {Promise<Array>}
   */
  async getCourses(forceRefresh = false) {
    try {
      // 1. 先读本地缓存
      const cached = await this.getCachedCourses();

      // 2. 如果不需要强制刷新，立即返回缓存
      if (!forceRefresh && cached && cached.length > 0) {
        // 后台刷新
        this.refreshCoursesFromCloud().catch(console.error);
        return cached;
      }

      // 3. 从云端获取
      const data = await callCloudFunction('course', {
        action: 'list',
        includeStats: true
      });

      // 4. 更新缓存
      await this.cacheCourses(data.courses || []);

      return data.courses || [];
    } catch (error) {
      console.error('Get courses failed:', error);
      // 出错时返回缓存
      const cached = await this.getCachedCourses();
      return cached || [];
    }
  },

  /**
   * 获取单个课程
   * @param {string} courseId
   */
  async getCourse(courseId) {
    try {
      const data = await callCloudFunction('course', {
        action: 'get',
        courseId
      });
      return data;
    } catch (error) {
      console.error('Get course failed:', error);
      // 从缓存获取
      const courses = await this.getCachedCourses();
      return courses.find(c => c._id === courseId) || null;
    }
  },

  /**
   * 添加课程
   * @param {Object} courseData
   */
  async addCourse(courseData) {
    const payload = {
      ...courseData,
      _id: generateId(),
      completedCount: 0,
      isCheckedIn: false
    };

    // 1. 立即写入本地缓存
    const courses = await this.getCachedCourses();
    courses.unshift(payload);
    await this.cacheCourses(courses);

    // 2. 加入同步队列
    await SyncQueue.enqueue('add_course', payload);

    return payload;
  },

  /**
   * 更新课程
   * @param {string} courseId
   * @param {Object} updates
   */
  async updateCourse(courseId, updates) {
    const payload = {
      courseId,
      updates: {
        ...updates,
        updatedAt: Date.now()
      }
    };

    // 1. 更新本地缓存
    const courses = await this.getCachedCourses();
    const index = courses.findIndex(c => c._id === courseId);
    if (index !== -1) {
      courses[index] = { ...courses[index], ...payload.updates };
      await this.cacheCourses(courses);
    }

    // 2. 加入同步队列
    await SyncQueue.enqueue('update_course', payload);

    return payload;
  },

  /**
   * 删除课程
   * @param {string} courseId
   * @param {boolean} hardDelete - 是否硬删除
   */
  async deleteCourse(courseId, hardDelete = false) {
    // 1. 从本地缓存删除
    const courses = await this.getCachedCourses();
    const filtered = courses.filter(c => c._id !== courseId);
    await this.cacheCourses(filtered);

    // 2. 删除本地打卡记录缓存
    await this.clearCheckinsCache(courseId);

    // 3. 加入同步队列
    await SyncQueue.enqueue('delete_course', { courseId, hardDelete });

    return { success: true };
  },

  // ========== 打卡相关操作 ==========

  /**
   * 获取课程的打卡记录
   * @param {string} courseId
   * @param {Object} options - 分页选项
   */
  async getCheckins(courseId, options = {}) {
    const { page = 1, limit = 50 } = options;

    try {
      const data = await callCloudFunction('checkin', {
        action: 'list',
        courseId,
        page,
        limit
      });

      // 更新本地缓存
      await this.cacheCheckins(courseId, data.checkins || []);

      return data.checkins || [];
    } catch (error) {
      console.error('Get checkins failed:', error);
      return await this.getCachedCheckins(courseId);
    }
  },

  /**
   * 检查某天是否已打卡
   * @param {string} courseId
   * @param {string} date - 日期字符串 YYYY-MM-DD
   */
  async hasCheckedIn(courseId, date) {
    const checkDate = date || formatDate(new Date());

    try {
      const data = await callCloudFunction('checkin', {
        action: 'hasCheckedIn',
        courseId,
        date: checkDate
      });

      return data.hasCheckedIn;
    } catch (error) {
      console.error('Check checkin failed:', error);
      // 检查本地缓存
      const checkins = await this.getCachedCheckins(courseId);
      return checkins.some(c => c.date === checkDate);
    }
  },

  /**
   * 添加打卡记录
   * @param {string} courseId
   * @param {Object} checkinData
   */
  async addCheckin(courseId, checkinData) {
    const date = checkinData.date || formatDate(new Date());

    // 检查是否已打卡
    const hasCheckedIn = await this.hasCheckedIn(courseId, date);
    if (hasCheckedIn) {
      const error = {
        code: CONFIG.ERROR_CODES.CHECKIN_DUPLICATE,
        message: '今天已经打卡啦',
        type: 'business'
      };
      throw error;
    }

    const payload = {
      ...checkinData,
      courseId,
      date,
      _id: generateId(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // 1. 更新本地打卡缓存
    const checkins = await this.getCachedCheckins(courseId);
    checkins.unshift(payload);
    await this.cacheCheckins(courseId, checkins);

    // 2. 更新课程缓存中的打卡计数
    const courses = await this.getCachedCourses();
    const courseIndex = courses.findIndex(c => c._id === courseId);
    if (courseIndex !== -1) {
      courses[courseIndex].completedCount = (courses[courseIndex].completedCount || 0) + 1;
      courses[courseIndex].isCheckedIn = true;
      await this.cacheCourses(courses);
    }

    // 3. 加入同步队列
    await SyncQueue.enqueue('checkin', payload);

    return payload;
  },

  /**
   * 取消打卡
   * @param {string} courseId
   * @param {string} date
   */
  async cancelCheckin(courseId, date) {
    const checkDate = date || formatDate(new Date());

    // 1. 从本地缓存删除
    const checkins = await this.getCachedCheckins(courseId);
    const filtered = checkins.filter(c => c.date !== checkDate);
    await this.cacheCheckins(courseId, filtered);

    // 2. 更新课程缓存中的打卡计数
    const courses = await this.getCachedCourses();
    const courseIndex = courses.findIndex(c => c._id === courseId);
    if (courseIndex !== -1) {
      courses[courseIndex].completedCount = Math.max(0, (courses[courseIndex].completedCount || 0) - 1);
      courses[courseIndex].isCheckedIn = false;
      await this.cacheCourses(courses);
    }

    // 3. 加入同步队列
    await SyncQueue.enqueue('cancel_checkin', { courseId, date: checkDate });

    return { success: true };
  },

  // ========== 统计相关操作 ==========

  /**
   * 获取总览统计
   */
  async getOverview() {
    try {
      const data = await callCloudFunction('stats', {
        action: 'overview'
      });
      return data;
    } catch (error) {
      console.error('Get overview failed:', error);
      // 返回本地计算的统计数据
      return this.getLocalOverview();
    }
  },

  /**
   * 获取周统计
   * @param {number} offset - 周偏移量
   */
  async getWeeklyStats(offset = 0) {
    try {
      const data = await callCloudFunction('stats', {
        action: 'weekly',
        offset
      });
      return data;
    } catch (error) {
      console.error('Get weekly stats failed:', error);
      return { dailyStats: [], total: 0 };
    }
  },

  /**
   * 获取课程排行
   */
  async getCourseRanking() {
    try {
      const data = await callCloudFunction('stats', {
        action: 'ranking'
      });
      return data.ranking || [];
    } catch (error) {
      console.error('Get ranking failed:', error);
      // 返回本地排序
      const courses = await this.getCachedCourses();
      return courses.sort((a, b) => (b.completedCount || 0) - (a.completedCount || 0));
    }
  },

  /**
   * 获取月度统计
   * @param {number} year
   * @param {number} month
   */
  async getMonthlyStats(year, month) {
    try {
      const data = await callCloudFunction('stats', {
        action: 'monthly',
        year,
        month
      });
      return data;
    } catch (error) {
      console.error('Get monthly stats failed:', error);
      return { calendar: [], totalCheckins: 0 };
    }
  },

  /**
   * 获取热力图数据
   * @param {number} days
   */
  async getHeatmapData(days = 365) {
    try {
      const data = await callCloudFunction('stats', {
        action: 'heatmap',
        days
      });
      return data;
    } catch (error) {
      console.error('Get heatmap failed:', error);
      return { heatmapData: [], totalDays: 0 };
    }
  },

  /**
   * 获取本地计算的概览数据
   */
  async getLocalOverview() {
    const courses = await this.getCachedCourses();
    let totalCheckins = 0;

    for (const course of courses) {
      const checkins = await this.getCachedCheckins(course._id);
      totalCheckins += checkins.length;
    }

    return {
      totalCourses: courses.length,
      totalCheckins,
      streakDays: 0,
      weekCheckins: 0,
      monthCheckins: 0,
      todayCheckins: 0,
      hasCheckedInToday: false
    };
  },

  // ========== 缓存操作 ==========

  /**
   * 获取缓存的课程列表
   */
  async getCachedCourses() {
    try {
      const { data } = await wx.getStorage({ key: CONFIG.STORAGE_KEYS.COURSES_CACHE });
      return data || [];
    } catch (e) {
      return [];
    }
  },

  /**
   * 缓存课程列表
   * @param {Array} courses
   */
  async cacheCourses(courses) {
    await wx.setStorage({
      key: CONFIG.STORAGE_KEYS.COURSES_CACHE,
      data: courses
    });
  },

  /**
   * 获取缓存的打卡记录
   * @param {string} courseId
   */
  async getCachedCheckins(courseId) {
    try {
      const { data } = await wx.getStorage({
        key: `${CONFIG.STORAGE_KEYS.CHECKINS_CACHE_PREFIX}${courseId}`
      });
      return data || [];
    } catch (e) {
      return [];
    }
  },

  /**
   * 缓存打卡记录
   * @param {string} courseId
   * @param {Array} checkins
   */
  async cacheCheckins(courseId, checkins) {
    await wx.setStorage({
      key: `${CONFIG.STORAGE_KEYS.CHECKINS_CACHE_PREFIX}${courseId}`,
      data: checkins
    });
  },

  /**
   * 清除打卡记录缓存
   * @param {string} courseId
   */
  async clearCheckinsCache(courseId) {
    try {
      await wx.removeStorage({
        key: `${CONFIG.STORAGE_KEYS.CHECKINS_CACHE_PREFIX}${courseId}`
      });
    } catch (e) {
      // 忽略错误
    }
  },

  /**
   * 从云端刷新课程
   */
  async refreshCoursesFromCloud() {
    try {
      const data = await callCloudFunction('course', {
        action: 'list',
        includeStats: true
      });

      await this.cacheCourses(data.courses || []);
      return data.courses || [];
    } catch (error) {
      console.error('Refresh courses failed:', error);
      return [];
    }
  }
};

module.exports = { db };
