// 云函数：以服务端微信身份登录，保留已有用户资料。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });

// wx 4.0.2 会丢失文档冲突的 code；仅识别官方冲突码/包装后的官方短语。
async function runTransaction(callback) {
  for (let attempt = 0; ; attempt++) {
    try {
      // 关闭 SDK 内层重试，整体最多尝试 3 次，失败事务由 SDK 回滚。
      return await db.runTransaction(callback, 0);
    } catch (error) {
      const conflict = error && (error.code === 'DATABASE_TRANSACTION_CONFLICT' ||
        (error.errCode === -501001 && /\bdatabase transaction conflict\b/i.test(`${error.message || ''} ${error.errMsg || ''}`)));
      if (!conflict || attempt >= 2) throw error;
    }
  }
}

exports.main = async (event = {}) => {
  try {
    const { OPENID, APPID, UNIONID } = cloud.getWXContext();
    if (!OPENID) throw new Error('Unauthorized');
    const { data: legacyUsers } = await db.collection('users').where({ _openid: OPENID })
      .orderBy('_id', 'asc').limit(1).get();
    const stableId = `user_${crypto.createHash('sha256').update(OPENID).digest('hex')}`;
    const userId = legacyUsers[0]?._id || stableId;
    const result = await runTransaction(async transaction => {
      const ref = transaction.collection('users').doc(userId);
      const { data: user } = await ref.get();
      const now = Date.now();
      if (user) {
        if (user._openid !== OPENID) throw new Error('Unauthorized');
        await ref.update({ data: { lastLoginAt: now, updatedAt: now, loginCount: (user.loginCount || 0) + 1 } });
        return { user, isNewUser: false };
      }
      const profile = event.data || event;
      const newUser = {
        _openid: OPENID,
        unionid: UNIONID || '',
        appid: APPID,
        nickName: profile.nickName || '',
        avatarUrl: profile.avatarUrl || '',
        settings: { reminderEnabled: false, reminderTime: '20:00', theme: 'default' },
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
        loginCount: 1
      };
      await ref.set({ data: newUser });
      return { user: newUser, isNewUser: true };
    });
    return {
      success: true,
      code: 200,
      data: {
        openid: OPENID,
        unionid: UNIONID,
        appid: APPID,
        userId,
        isNewUser: result.isNewUser,
        userInfo: { nickName: result.user.nickName || '', avatarUrl: result.user.avatarUrl || '' }
      },
      message: '登录成功'
    };
  } catch (error) {
    console.error('Login error:', error);
    return { success: false, code: error.message === 'Unauthorized' ? 401 : 500, data: null, message: error.message || '登录失败' };
  }
};
