// 云函数：课程管理
// 功能：课程的增删改查，带权限验证

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { applyScheduleChange, selectRecords, attendanceStatus, attendanceDebit } = require('./attendance');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database({ throwOnNotFound: false });
const _ = db.command;
const COURSE_TYPES = new Set(['swim', 'piano', 'english', 'art', 'dance', 'sports', 'music', 'other']);

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

function formatLocalDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeTotalLessons(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!['number', 'string'].includes(typeof value) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Total lessons must be a non-negative integer');
  }
  return parsed;
}

function normalizeReminder(reminder) {
  if (!reminder || typeof reminder !== 'object') {
    return { enabled: false, advanceMinutes: 60 };
  }

  const advanceMinutes = Number(reminder.advanceMinutes) || 60;
  if (![15, 30, 60, 120].includes(advanceMinutes)) {
    throw new Error('Invalid reminder');
  }

  return {
    enabled: Boolean(reminder.enabled),
    advanceMinutes
  };
}

// 验证用户权限
async function verifyAuth(event) {
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID;

  if (!OPENID || (event.expectedOpenid !== undefined && event.expectedOpenid !== OPENID)) {
    throw new Error('Unauthorized');
  }

  return OPENID;
}

// 获取课程列表
async function getCourses(openid, event) {
  const { page = 1, limit = 50, includeArchived = false } = event;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid pagination');
  }
  const skip = (page - 1) * limit;
  const condition = { _openid: openid };
  if (!includeArchived) condition.isDeleted = _.neq(true);

  // 获取课程列表
  const { data: courses } = await db.collection('courses')
    .where(condition)
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'asc')
    .skip(skip)
    .limit(limit)
    .get();

  const { total } = await db.collection('courses').where(condition).count();
  // 新客户端已单独分页取全记录；快照刷新无需为每门课再扫描一次历史。
  const coursesWithStats = event.includeStats === false
    ? courses.map(course => ({ ...course, initialLessons: course.initialLessons || 0, totalLessons: course.totalLessons || 0, isDeleted: course.isDeleted === true }))
    : await Promise.all(courses.map(course => withStats(openid, course)));
  return { courses: coursesWithStats, total };
}

async function withStats(openid, course) {
  const condition = { courseId: course._id, _openid: openid };
  const rows = [];
  let skip = 0;
  while (true) {
    const { data } = await db.collection('checkins').where(condition).orderBy('_id', 'asc')
      .skip(skip).limit(100).get();
    rows.push(...data);
    skip += data.length;
    if (data.length < 100) break;
  }
  const initialLessons = course.initialLessons || 0;
  const records = selectRecords(rows);
  const attended = records.filter(item => attendanceStatus(item) === 'attended');
  return {
    ...course,
    initialLessons,
    totalLessons: course.totalLessons || 0,
    isDeleted: course.isDeleted === true,
    completedCount: initialLessons + attended.length,
    consumedCount: initialLessons + records.reduce((total, item) => total + attendanceDebit(item), 0),
    absentCount: records.filter(item => attendanceStatus(item) === 'absent').length,
    isCheckedIn: attended.some(item => item.date === formatLocalDate())
  };
}

// 获取单个课程
async function getCourse(openid, event) {
  const { courseId } = event;
  if (!courseId) {
    throw new Error('Course ID is required');
  }

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

  return withStats(openid, courses[0]);
}

// 添加课程
async function addCourse(openid, event) {
  const {
    name,
    type = 'other',
    icon,
    schedule,
    totalLessons,
    initialLessons,
    notes,
    reminder,
    location,
    teacher,
    operationId
  } = event;

  if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 200) {
    throw new Error('Invalid operationId');
  }
  const courseId = `course_${crypto.createHash('sha256').update(JSON.stringify([openid, operationId])).digest('hex')}`;

  await runTransaction(async transaction => {
    const ref = transaction.collection('courses').doc(courseId);
    const { data: existing } = await ref.get();
    if (existing) {
      if (existing._openid !== openid) throw new Error('Course not found');
      return;
    }

    // 参数校验
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Course name is required');
    }

    if (name.length > 50) {
      throw new Error('Course name too long (max 50 chars)');
    }

    if (!COURSE_TYPES.has(type)) {
      throw new Error('Invalid course type');
    }

    const now = Date.now();
    const courseData = {
      _openid: openid,
      operationId,
      name: name.trim(),
      type,
      icon: icon || '',
      schedule: schedule || '',
      totalLessons: normalizeTotalLessons(totalLessons),
      initialLessons: normalizeTotalLessons(initialLessons),
      notes: notes || '',
      reminder: normalizeReminder(reminder),
      location: location || '',
      teacher: teacher || '',
      isDeleted: false,
      createdAt: now,
      updatedAt: now
    };
    if (event.scheduleChange !== undefined) courseData.scheduleVersions = scheduleVersions(courseData, event.scheduleChange, operationId);

    await ref.set({ data: courseData });
  });
  return getCourse(openid, { courseId });
}

// 更新课程
async function updateCourse(openid, event) {
  const { courseId, updates } = event;
  if (!courseId) {
    throw new Error('Course ID is required');
  }
  if (!updates || typeof updates !== 'object') {
    throw new Error('Updates are required');
  }

  // 过滤允许更新的字段
  const allowedFields = [
    'name', 'type', 'icon', 'schedule', 'totalLessons', 'initialLessons',
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
    if (typeof updateData.name !== 'string' || updateData.name.trim().length === 0) {
      throw new Error('Course name cannot be empty');
    }
    if (updateData.name.length > 50) {
      throw new Error('Course name too long');
    }
    updateData.name = updateData.name.trim();
  }

  if (updateData.type !== undefined && !COURSE_TYPES.has(updateData.type)) {
    throw new Error('Invalid course type');
  }

  if (updateData.totalLessons !== undefined) {
    updateData.totalLessons = normalizeTotalLessons(updateData.totalLessons);
  }
  if (updateData.initialLessons !== undefined) {
    updateData.initialLessons = normalizeTotalLessons(updateData.initialLessons);
  }

  if (updateData.reminder !== undefined) {
    updateData.reminder = normalizeReminder(updateData.reminder);
  }

  updateData.updatedAt = Date.now();

  const updatedCourse = await runTransaction(async transaction => {
    const ref = transaction.collection('courses').doc(courseId);
    const { data: course } = await ref.get();
    if (!course || course._openid !== openid) throw new Error('Course not found');
    // Schedule and ordinary fields are one operation. A replay must not write
    // either part again after another edit has changed the current course.
    if (updates.scheduleChange !== undefined && typeof event.operationId === 'string' && event.operationId && Array.isArray(course.scheduleVersions) && course.scheduleVersions.some(version => version.operationId === event.operationId)) return course;
    if (course.isDeleted === true) throw new Error('Course not found');
    if (updates.scheduleChange !== undefined) updateData.scheduleVersions = scheduleVersions(course, updates.scheduleChange, event.operationId);
    await ref.update({ data: updateData });
    return { ...course, ...updateData };
  });
  // 课程字段取自同一事务；进度仍由历史记录实时计算。
  return withStats(openid, updatedCourse);
}

function scheduleVersions(course, change, operationId) {
  if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 200) throw new Error('Invalid operationId');
  try { return applyScheduleChange(course, change, { today: formatLocalDate(), operationId }); }
  catch (error) {
    if (error.message.includes('已更新')) { error.code = 'SCHEDULE_CONFLICT'; throw error; }
    throw new Error(`Invalid schedule: ${error.message}`);
  }
}

// 归档保留课程和历史；恢复后可以继续记课。
async function setArchived(openid, event, isDeleted) {
  const { courseId, hardDelete = false, operationId } = event;
  if (!courseId) {
    throw new Error('Course ID is required');
  }

  if (hardDelete) {
    throw new Error('Invalid operation: permanent deletion is disabled');
  }
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 200)) throw new Error('Invalid operationId');
  await runTransaction(async transaction => {
    const ref = transaction.collection('courses').doc(courseId);
    const { data: course } = await ref.get();
    if (!course || course._openid !== openid) throw new Error('Course not found');
    // Keep receipts independently of replaceable schedule history. A lost reply
    // must not let an old archive/restore overwrite a newer user decision.
    const operations = Array.isArray(course.archiveOperations) ? course.archiveOperations : [];
    const applied = operationId && operations.find(operation => operation.operationId === operationId);
    if (applied) {
      if (applied.isDeleted !== isDeleted) throw new Error('Invalid operationId reuse');
      return;
    }
    const receipt = operationId ? { archiveOperations: [...operations, { operationId, isDeleted }] } : {};
    const legacyApplied = isDeleted && operationId && Array.isArray(course.scheduleVersions) && course.scheduleVersions.some(version => version.operationId === operationId && Array.isArray(version.slots) && version.slots.length === 0);
    if (course.isDeleted === isDeleted || legacyApplied) {
      if (operationId) await ref.update({ data: receipt });
      return;
    }
    const update = { isDeleted, deletedAt: isDeleted ? Date.now() : null, updatedAt: Date.now() };
    if (isDeleted && course.scheduleVersions && course.scheduleVersions.length) {
      const requestedOn = event.requestedOn === undefined ? formatLocalDate() : event.requestedOn;
      const parsed = new Date(`${requestedOn}T00:00:00Z`);
      if (typeof requestedOn !== 'string' || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== requestedOn || requestedOn < '1900-01-01' || requestedOn > formatLocalDate()) throw new Error('Invalid archive date');
      const effectiveFrom = new Date(parsed.getTime() + 86400000).toISOString().slice(0, 10);
      const latest = [...course.scheduleVersions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
      update.scheduleVersions = scheduleVersions(course, { requestedOn, effectiveFrom, slots: [], expectedVersion: latest.operationId || latest.effectiveFrom }, event.operationId || `archive:${requestedOn}`);
      update.deletedAt = requestedOn;
    }
    await ref.update({ data: { ...update, ...receipt } });
  });
  return getCourse(openid, { courseId });
}

// 主入口
exports.main = async (event = {}, context) => {
  try {
    const openid = await verifyAuth(event);
    const { action } = event;
    const payload = event.data || event;

    let result;
    switch (action) {
      case 'capabilities':
        result = { attendanceVersion: 1 };
        break;
      case 'list':
        result = await getCourses(openid, payload);
        break;
      case 'get':
        result = await getCourse(openid, payload);
        break;
      case 'add':
        // 旧客户端没有操作编号，只兼容新增；可靠重试由新协议的稳定编号保证。
        result = await addCourse(openid, !event.data && !payload.operationId
          ? { ...payload, operationId: crypto.randomBytes(16).toString('hex') } : payload);
        break;
      case 'update':
        result = await updateCourse(openid, payload);
        break;
      case 'delete':
      case 'archive':
        result = await setArchived(openid, payload, true);
        break;
      case 'restore':
        result = await setArchived(openid, payload, false);
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

    const errorCode = error.code === 'SCHEDULE_CONFLICT' ? 409 : error.message === 'Unauthorized' ? 401 :
                      error.message === 'Course not found' ? 404 :
                      error.message.includes('required') ||
                      error.message.includes('Invalid') ||
                      error.message.includes('Course name') ||
                      error.message.includes('must be') ? 400 : 500;

    return {
      success: false,
      code: errorCode,
      data: null,
      message: error.message
    };
  }
};
