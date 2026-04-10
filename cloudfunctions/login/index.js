// 云函数：登录
// 功能：获取用户 openid，创建/更新用户记录

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const { OPENID, APPID, UNIONID } = wxContext;

  try {
    // 查询用户是否已存在
    const userCollection = db.collection('users');
    const { data: existingUsers } = await userCollection
      .where({
        _openid: OPENID
      })
      .limit(1)
      .get();

    const now = Date.now();

    if (existingUsers.length > 0) {
      // 更新登录时间
      const user = existingUsers[0];
      await userCollection.doc(user._id).update({
        data: {
          lastLoginAt: now,
          loginCount: db.command.inc(1),
          updatedAt: now
        }
      });

      return {
        success: true,
        code: 200,
        data: {
          openid: OPENID,
          unionid: UNIONID,
          appid: APPID,
          userId: user._id,
          isNewUser: false,
          userInfo: {
            nickName: user.nickName,
            avatarUrl: user.avatarUrl,
            streakDays: user.streakDays || 0,
            totalCheckins: user.totalCheckins || 0
          }
        },
        message: '登录成功'
      };
    }

    // 新用户，创建记录
    const newUser = {
      _openid: OPENID,
      unionid: UNIONID || '',
      appid: APPID,
      nickName: event.nickName || '',
      avatarUrl: event.avatarUrl || '',
      streakDays: 0,
      totalCheckins: 0,
      settings: {
        reminderEnabled: false,
        reminderTime: '20:00',
        theme: 'default'
      },
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
      loginCount: 1
    };

    const { _id } = await userCollection.add({
      data: newUser
    });

    return {
      success: true,
      code: 200,
      data: {
        openid: OPENID,
        unionid: UNIONID,
        appid: APPID,
        userId: _id,
        isNewUser: true,
        userInfo: {
          nickName: '',
          avatarUrl: '',
          streakDays: 0,
          totalCheckins: 0
        }
      },
      message: '新用户注册成功'
    };

  } catch (error) {
    console.error('Login error:', error);
    return {
      success: false,
      code: 500,
      data: null,
      message: error.message || '登录失败'
    };
  }
};
