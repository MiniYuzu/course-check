// 云函数：打卡功能
// 功能：打卡、取消打卡、查询打卡记录、检查今日是否已打卡

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

// 验证用户权限
async function verifyAuth(context) {
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID;

  if (!OPENID) {
    throw new Error('Unauthorized');
  }

  return OPENID;
}

// 获取打卡记录列表
async function getCheckins(openid, event) {
  const { courseId, page = 1, limit = 50, startDate, endDate } = event;
  const skip = (page - 1) * limit;

  let whereCondition = {
    _openid: openid
  };

  if (courseId) {
    whereCondition.courseId = courseId;
  }

  if (startDate && endDate) {
    whereCondition.date = _.gte(startDate).and(_.lte(endDate));
  } else if (startDate) {
    whereCondition.date = _.gte(startDate);
  } else if (endDate) {
    whereCondition.date = _.lte(endDate);
  }

  const { data: checkins } = await db.collection('checkins')
    .where(whereCondition)
    .orderBy('date', 'desc')
    .skip(skip)
    .limit(limit)
    .get();

  // 获取关联的课程信息
  const courseIds = [...new Set(checkins.map(c => c.courseId))];
  const courseMap = {};

  for (const id of courseIds) {
    const { data: courses } = await db.collection('courses')
      .where({ _id: id, _openid: openid })
      .limit(1)
      .get();
    if (courses.length > 0) {
      courseMap[id] = courses[0];
    }
  }

  const checkinsWithCourse = checkins.map(checkin => ({
    ...checkin,
    courseName: courseMap[checkin.courseId]?.name || '未知课程',
    courseIcon: courseMap[checkin.courseId]?.icon || '📖'
  }));

  const { total } = await db.collection('checkins')
    .where(whereCondition)
    .count();

  return {
    checkins: checkinsWithCourse,
    total,
    page,
    limit
  };
}

// 检查某天是否已打卡
async function hasCheckedIn(openid, event) {
  const { courseId, date } = event;

  const checkDate = date || new Date().toISOString().split('T')[0];

  let whereCondition = {
    _openid: openid,
    date: checkDate
  };

  if (courseId) {
    whereCondition.courseId = courseId;
  }

  const { total } = await db.collection('checkins')
    .where(whereCondition)
    .count();

  return {
    hasCheckedIn: total > 0,
    date: checkDate,
    courseId: courseId || null,
    count: total
  };
}

// 打卡
async function checkin(openid, event) {
  const { courseId, date, notes = '', mood = '', photos = [] } = event;

  if (!courseId) {
    throw new Error('Course ID is required');
  }

  // 检查课程是否存在
  const { data: courses } = await db.collection('courses')
    .where({
      _id: courseId,
      _openid: openid,
      isDeleted: _.neq(true)
    })
    .limit(1)
    .get();

  if (courses.length === 0) {
    throw new Error('Course not found');
  }

  const checkDate = date || new Date().toISOString().split('T')[0];

  // 检查是否已打卡
  const { data: existing } = await db.collection('checkins')
    .where({
      courseId,
      _openid: openid,
      date: checkDate
    })
    .limit(1)
    .get();

  if (existing.length > 0) {
    throw new Error('Already checked in today');
  }

  const now = Date.now();
  const checkinData = {
    _openid: openid,
    courseId,
    date: checkDate,
    notes: notes.trim(),
    mood,
    photos: photos || [],
    createdAt: now,
    updatedAt: now
  };

  const { _id } = await db.collection('checkins').add({
    data: checkinData
  });

  // 更新用户总打卡数
  await db.collection('users')
    .where({ _openid: openid })
    .update({
      data: {
        totalCheckins: _.inc(1),
        updatedAt: now
      }
    });

  // 更新连续打卡天数
  await updateStreakDays(openid);

  return {
    _id,
    ...checkinData,
    courseName: courses[0].name
  };
}

// 更新连续打卡天数
async function updateStreakDays(openid) {
  // 获取最近的打卡记录
  const { data: checkins } = await db.collection('checkins')
    .where({ _openid: openid })
    .orderBy('date', 'desc')
    .limit(365)
    .get();

  if (checkins.length === 0) {
    await db.collection('users')
      .where({ _openid: openid })
      .update({
        data: { streakDays: 0 }
      });
    return;
  }

  // 计算连续打卡天数
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let streakDays = 0;
  let checkDate = new Date(today);

  // 检查今天是否打卡
  const todayStr = today.toISOString().split('T')[0];
  const hasToday = checkins.some(c => c.date === todayStr);

  if (!hasToday) {
    // 今天没打卡，检查昨天
    checkDate.setDate(checkDate.getDate() - 1);
  }

  const checkedDates = new Set(checkins.map(c => c.date));

  while (true) {
    const dateStr = checkDate.toISOString().split('T')[0];
    if (checkedDates.has(dateStr)) {
      streakDays++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  await db.collection('users')
    .where({ _openid: openid })
    .update({
      data: { streakDays }
    });
}

// 取消打卡
async function cancelCheckin(openid, event) {
  const { checkinId, courseId, date } = event;

  let deleteCondition = {
    _openid: openid
  };

  if (checkinId) {
    deleteCondition._id = checkinId;
  } else if (courseId && date) {
    deleteCondition.courseId = courseId;
    deleteCondition.date = date;
  } else {
    throw new Error('Checkin ID or (courseId + date) is required');
  }

  // 查找记录
  const { data: checkins } = await db.collection('checkins')
    .where(deleteCondition)
    .limit(1)
    .get();

  if (checkins.length === 0) {
    throw new Error('Checkin record not found');
  }

  // 删除记录
  await db.collection('checkins').doc(checkins[0]._id).remove();

  // 更新用户总打卡数
  await db.collection('users')
    .where({ _openid: openid })
    .update({
      data: {
        totalCheckins: _.inc(-1),
        updatedAt: Date.now()
      }
    });

  // 重新计算连续打卡
  await updateStreakDays(openid);

  return {
    success: true,
    deletedId: checkins[0]._id
  };
}

// 批量打卡（课程组打卡）
async function batchCheckin(openid, event) {
  const { courseIds, date, notes = '' } = event;

  if (!Array.isArray(courseIds) || courseIds.length === 0) {
    throw new Error('Course IDs array is required');
  }

  const results = [];
  const errors = [];

  for (const courseId of courseIds) {
    try {
      const result = await checkin(openid, { courseId, date, notes });
      results.push(result);
    } catch (error) {
      errors.push({ courseId, error: error.message });
    }
  }

  return {
    success: errors.length === 0,
    checkedIn: results,
    errors,
    total: courseIds.length,
    successCount: results.length,
    failedCount: errors.length
  };
}

// 主入口
exports.main = async (event, context) => {
  try {
    const openid = await verifyAuth(context);
    const { action } = event;

    let result;
    switch (action) {
      case 'list':
        result = await getCheckins(openid, event);
        break;
      case 'hasCheckedIn':
        result = await hasCheckedIn(openid, event);
        break;
      case 'checkin':
        result = await checkin(openid, event);
        break;
      case 'cancel':
        result = await cancelCheckin(openid, event);
        break;
      case 'batch':
        result = await batchCheckin(openid, event);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return {
      success: true,
      code: 200,
      data: result,
      message: 'Success'
    };

  } catch (error) {
    console.error('Checkin function error:', error);

    const errorCode = error.message === 'Unauthorized' ? 401 :
                      error.message === 'Course not found' ? 404 :
                      error.message === 'Already checked in today' ? 409 :
                      error.message.includes('required') ? 400 : 500;

    return {
      success: false,
      code: errorCode,
      data: null,
      message: error.message
    };
  }
};
