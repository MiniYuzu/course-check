// 全局配置
const CONFIG = {
  // 存储键名
  STORAGE_KEYS: {
    SYNC_QUEUE: 'cc_sync_queue',
    COURSES_CACHE: 'cc_courses',
    CHECKINS_CACHE_PREFIX: 'cc_checkins_',
    LAST_SYNC: 'cc_last_sync',
    USER_SETTINGS: 'cc_user_settings',
    AUTH_TOKEN: 'cc_auth_token',
    USER_INFO: 'cc_user_info'
  },

  // 同步配置
  SYNC: {
    MAX_RETRIES: 3,
    BASE_DELAY: 1000,
    MAX_DELAY: 30000,
    TIMEOUT: 5000
  },

  // 错误码
  ERROR_CODES: {
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
  },

  // 课程类型（决定渐变色）
  COURSE_TYPES: {
    SWIM: { type: 'swim', color: '#2563EB', gradient: 'linear-gradient(135deg, #2563EB 0%, #06B6D4 100%)', icon: '🏊' },
    PIANO: { type: 'piano', color: '#F59E0B', gradient: 'linear-gradient(135deg, #F59E0B 0%, #EF4444 100%)', icon: '🎹' },
    ENGLISH: { type: 'english', color: '#10B981', gradient: 'linear-gradient(135deg, #10B981 0%, #059669 100%)', icon: '📚' },
    ART: { type: 'art', color: '#EC4899', gradient: 'linear-gradient(135deg, #EC4899 0%, #BE185D 100%)', icon: '🎨' },
    DANCE: { type: 'dance', color: '#8B5CF6', gradient: 'linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%)', icon: '💃' },
    SPORTS: { type: 'sports', color: '#F97316', gradient: 'linear-gradient(135deg, #F97316 0%, #EA580C 100%)', icon: '⚽' },
    MUSIC: { type: 'music', color: '#06B6D4', gradient: 'linear-gradient(135deg, #06B6D4 0%, #0891B2 100%)', icon: '🎵' },
    OTHER: { type: 'other', color: '#64748B', gradient: 'linear-gradient(135deg, #64748B 0%, #475569 100%)', icon: '📖' }
  }
};

module.exports = { CONFIG };
