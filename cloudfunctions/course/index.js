// 云函数：课程管理
// 功能：课程的增删改查，带权限验证

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

// 获取课程列表
async function getCourses(openid, event) {
  const { page = 1, limit = 50, includeStats = true } = event;
  const skip = (page - 1) * limit;

  // 获取课程列表
  const { data: courses } = await db.collection('courses')
    .where({
      _openid: openid,
      isDeleted: _.neq(true)
    })
    .orderBy('createdAt', 'desc')
    .skip(skip)
    .limit(limit)
    .get();

  if (!includeStats) {
    return { courses, total: courses.length };
  }

  // 获取每个课程的打卡统计
  const coursesWithStats = await Promise.all(
    courses.map(async (course) => {
      const { total } = await db.collection('checkins')
        .where({
          courseId: course._id,
          _openid: openid
        })
        .count();

      // 获取今天是否已打卡
      const today = new Date().toISOString().split('T')[0];
      const { data: todayCheckins } = await db.collection('checkins')
        .where({
          courseId: course._id,
          _openid: openid,
          date: today
        })
        .limit(1)
        .get();

      return {
        ...course,
        completedCount: total,
        isCheckedIn: todayCheckins.length > 0
      };
    })
  );

  return { courses: coursesWithStats, total: coursesWithStats.length };
}

// 获取单个课程
async function getCourse(openid, event) {
  const { courseId } = event;

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

  const course = courses[0];

  // 获取打卡统计
  const { total } = await db.collection('checkins')
    .where({
      courseId: course._id,
      _openid: openid
    })
    .count();

  return {
    ...course,
    completedCount: total
  };
}

// 添加课程
async function addCourse(openid, event) {
  const {
    name,
    type = 'other',
    icon,
    schedule,
    totalLessons,
    notes,
    reminder,
    location,
    teacher
  } = event;

  // 参数校验
  if (!name || name.trim().length === 0) {
    throw new Error('Course name is required');
  }

  if (name.length > 50) {
    throw new Error('Course name too long (max 50 chars)');
  }

  const now = Date.now();
  const courseData = {
    _openid: openid,
    name: name.trim(),
    type,
    icon: icon || '',
    schedule: schedule || '',
    totalLessons: totalLessons || 0,
    notes: notes || '',
    reminder: reminder || { enabled: false, time: '20:00' },
    location: location || '',
    teacher: teacher || '',
    isDeleted: false,
    createdAt: now,
    updatedAt: now
  };

  const { _id } = await db.collection('courses').add({
    data: courseData
  });

  return {
    _id,
    ...courseData,
    completedCount: 0
  };
}

// 更新课程
async function updateCourse(openid, event) {
  const { courseId, updates } = event;

  // 检查权限
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

  // 过滤允许更新的字段
  const allowedFields = [
    'name', 'type', 'icon', 'schedule', 'totalLessons',
    'notes', 'reminder', 'location', 'teacher'
  ];

  const updateData = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      updateData[field] = updates[field];
    }
  }

  // 校验名称
  if (updateData.name !== undefined) {
    if (updateData.name.trim().length === 0) {
      throw new Error('Course name cannot be empty');
    }
    if (updateData.name.length > 50) {
      throw new Error('Course name too long');
    }
    updateData.name = updateData.name.trim();
  }

  updateData.updatedAt = Date.now();

  await db.collection('courses').doc(courseId).update({
    data: updateData
  });

  // 获取更新后的课程
  return getCourse(openid, { courseId });
}

// 删除课程（软删除）
async function deleteCourse(openid, event) {
  const { courseId, hardDelete = false } = event;

  // 检查权限
  const { data: courses } = await db.collection('courses')
    .where({
      _id: courseId,
      _openid: openid
    })
    .limit(1)
    .get();

  if (courses.length === 0) {
    throw new Error('Course not found');
  }

  if (hardDelete) {
    // 硬删除：删除课程和所有打卡记录
    await db.collection('courses').doc(courseId).remove();

    // 删除关联的打卡记录
    const { data: checkins } = await db.collection('checkins')
      .where({
        courseId,
        _openid: openid
      })
      .get();

    for (const checkin of checkins) {
      await db.collection('checkins').doc(checkin._id).remove();
    }
  } else {
    // 软删除
    await db.collection('courses').doc(courseId).update({
      data: {
        isDeleted: true,
        deletedAt: Date.now(),
        updatedAt: Date.now()
      }
    });
  }

  return { success: true, courseId };
}

// 主入口
exports.main = async (event, context) => {
  try {
    const openid = await verifyAuth(context);
    const { action } = event;

    let result;
    switch (action) {
      case 'list':
        result = await getCourses(openid, event);
        break;
      case 'get':
        result = await getCourse(openid, event);
        break;
      case 'add':
        result = await addCourse(openid, event);
        break;
      case 'update':
        result = await updateCourse(openid, event);
        break;
      case 'delete':
        result = await deleteCourse(openid, event);
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
    console.error('Course function error:', error);

    const errorCode = error.message === 'Unauthorized' ? 401 :
                      error.message === 'Course not found' ? 404 :
                      error.message.includes('required') ? 400 : 500;

    return {
      success: false,
      code: errorCode,
      data: null,
      message: error.message
    };
  }
};
