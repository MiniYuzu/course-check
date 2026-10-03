// 云函数：记课、取消记课和历史查询。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const _ = db.command;

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

function todayInChina() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeDate(value, allowFuture = false) {
  const date = value === undefined ? todayInChina() : value;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) throw new Error('Invalid date');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
  if (!allowFuture && date > todayInChina()) throw new Error('Invalid future date');
  return date;
}

function checkinId(openid, courseId, date) {
  return `checkin_${crypto.createHash('sha256').update(JSON.stringify([openid, courseId, date])).digest('hex')}`;
}

function normalizeNotes(value) {
  const notes = String(value || '').replace(/\s+/g, ' ').trim();
  if (notes.length > 60) throw new Error('Invalid notes: maximum 60 characters');
  return notes;
}

async function getCheckins(openid, event) {
  const { courseId, page = 1, limit = 50, startDate, endDate } = event;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid pagination');
  const condition = { _openid: openid };
  if (courseId) condition.courseId = courseId;
  if (startDate !== undefined) condition.date = _.gte(normalizeDate(startDate, true));
  if (endDate !== undefined) {
    const end = _.lte(normalizeDate(endDate, true));
    condition.date = condition.date ? condition.date.and(end) : end;
  }
  if (startDate && endDate && startDate > endDate) throw new Error('Invalid date range');
  const { data: checkins } = await db.collection('checkins').where(condition)
    .orderBy('date', 'desc').orderBy('_id', 'asc').skip((page - 1) * limit).limit(limit).get();
  const { total } = await db.collection('checkins').where(condition).count();
  const courseMap = {};
  for (const id of new Set(checkins.map(checkin => checkin.courseId))) {
    const { data: courses } = await db.collection('courses').where({ _id: id, _openid: openid }).limit(1).get();
    if (courses[0]) courseMap[id] = courses[0];
  }
  return {
    checkins: checkins.map(checkin => ({
      ...checkin,
      courseName: courseMap[checkin.courseId]?.name || '未知课程',
      courseIcon: courseMap[checkin.courseId]?.icon || '📖'
    })),
    total,
    page,
    limit
  };
}

async function hasCheckedIn(openid, event) {
  const date = normalizeDate(event.date);
  const condition = { _openid: openid, date };
  if (event.courseId) condition.courseId = event.courseId;
  const { total } = await db.collection('checkins').where(condition).count();
  return { hasCheckedIn: total > 0, date, courseId: event.courseId || null, count: total };
}

// 事务不支持 where。先定位旧随机 ID，再在事务里逐一读取复验。
// 新记录始终使用确定 ID；全部云函数需一起升级，旧版并发写入不受此协议保护。
async function findExistingIds(openid, courseId, date) {
  const ids = [];
  while (true) {
    const { data } = await db.collection('checkins').where({ _openid: openid, courseId, date })
      .orderBy('_id', 'asc').skip(ids.length).limit(100).get();
    ids.push(...data.map(row => row._id));
    if (data.length < 100) return [...new Set([checkinId(openid, courseId, date), ...ids])];
  }
}

async function readExisting(transaction, ids, openid, courseId, date, firstOnly = false) {
  const records = [];
  for (const id of ids) {
    const { data } = await transaction.collection('checkins').doc(id).get();
    if (data && data._openid === openid && data.courseId === courseId && data.date === date) {
      records.push(data);
      if (firstOnly) break;
    }
  }
  return records;
}

async function checkin(openid, event) {
  const { courseId, mood = '', photos = [] } = event;
  if (typeof courseId !== 'string' || !courseId) throw new Error('Course ID is required');
  const date = normalizeDate(event.date);
  const notes = normalizeNotes(event.notes);
  const id = checkinId(openid, courseId, date);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: candidates } = await db.collection('checkins').where({ _openid: openid, courseId, date })
      .orderBy('_id', 'asc').limit(1).get();
    const ids = [...new Set([id, ...candidates.map(record => record._id)])];
    const result = await runTransaction(async transaction => {
      const courseRef = transaction.collection('courses').doc(courseId);
      const { data: course } = await courseRef.get();
      if (!course || course._openid !== openid) throw new Error('Course not found');
      if (course.isDeleted === true) throw new Error('Invalid operation: course is archived');
      // 最多复验确定 ID 和一个旧 ID，事务最坏也不超过 5 次操作。
      const existing = await readExisting(transaction, ids, openid, courseId, date, true);
      if (existing.length) return { ...existing[0], courseName: course.name };
      // 旧候选被并发取消：重新查询，不能假设其余旧记录也已消失。
      if (candidates.length) return null;
      const now = Date.now();
      const data = {
        _openid: openid,
        courseId,
        date,
        notes,
        mood: typeof mood === 'string' ? mood : '',
        photos: Array.isArray(photos) ? photos : [],
        createdAt: now,
        updatedAt: now
      };
      await transaction.collection('checkins').doc(id).set({ data });
      // 与归档竞争时写同一课程文档，让事务冲突重试后重新检查归档状态。
      await courseRef.update({ data: { lessonRevision: (course.lessonRevision || 0) + 1 } });
      return { _id: id, ...data, courseName: course.name };
    });
    if (result) return result;
  }
  throw new Error('Checkin changed concurrently, please retry');
}

async function updateNotes(openid, event) {
  const { courseId, date } = event;
  if (typeof courseId !== 'string' || !courseId || typeof date !== 'string' || !date) throw new Error('Course ID and date are required');
  const notes = normalizeNotes(event.notes);
  // 按原始日期更正已有记录，也允许修正旧版异常日期的备注；绝不创建记录。
  const ids = await findExistingIds(openid, courseId, date);
  const updatedIds = [];
  const updatedAt = Date.now();
  const notesWriteToken = crypto.randomBytes(16).toString('hex');
  // 兼容同一天旧随机 ID 的重复记录。每批读+写最多 82 次，保留全部原始记录。
  for (let offset = 0; offset < ids.length; offset += 40) {
    const updated = await runTransaction(async transaction => {
      const courseRef = transaction.collection('courses').doc(courseId);
      const { data: course } = await courseRef.get();
      if (!course || course._openid !== openid) throw new Error('Course not found');
      if (offset > 0 && course.notesWriteToken !== notesWriteToken) {
        const error = new Error('Checkin notes changed concurrently, please retry');
        error.code = 'CHECKIN_NOTES_CONFLICT';
        throw error;
      }
      const records = await readExisting(transaction, ids.slice(offset, offset + 40), openid, courseId, date);
      for (const record of records) await transaction.collection('checkins').doc(record._id).update({ data: { notes, updatedAt } });
      // 每批都写同一课程文档：新请求取得标记后，旧请求不能继续覆盖后续批次。
      await courseRef.update({ data: { notesWriteToken } });
      return records.map(record => record._id);
    });
    updatedIds.push(...updated);
  }
  if (!updatedIds.length) throw new Error('Checkin not found');
  return { courseId, date, notes, updatedAt, updatedIds };
}

async function cancelCheckin(openid, event) {
  let { courseId, date } = event;
  if (event.checkinId && !courseId) {
    const { data: checkin } = await db.collection('checkins').doc(event.checkinId).get();
    if (!checkin || checkin._openid !== openid) return { success: true, deletedIds: [] };
    courseId = checkin.courseId;
    date = checkin.date;
  }
  if (typeof courseId !== 'string' || !courseId || !date) throw new Error('Course ID and date are required');
  // 删除只匹配当前身份、课程和原始日期；新增的日历校验不能阻止纠正旧误记。
  if (typeof date !== 'string') throw new Error('Invalid date');
  const ids = await findExistingIds(openid, courseId, date);
  const canonicalId = checkinId(openid, courseId, date);
  const orderedIds = [...ids.filter(id => id !== canonicalId), canonicalId];
  const deletedIds = [];
  // 每批 40 条：读+删+课程读写最多 82 次，低于事务 100 次上限。
  // 最后一批才删除确定 ID；中途失败可安全重试，清除剩余旧记录。
  for (let offset = 0; offset < orderedIds.length; offset += 40) {
    const removed = await runTransaction(async transaction => {
      const courseRef = transaction.collection('courses').doc(courseId);
      const { data: course } = await courseRef.get();
      if (course && course._openid !== openid) throw new Error('Course not found');
      const records = await readExisting(transaction, orderedIds.slice(offset, offset + 40), openid, courseId, date);
      for (const record of records) await transaction.collection('checkins').doc(record._id).remove();
      if (course && records.length) await courseRef.update({ data: { lessonRevision: (course.lessonRevision || 0) + 1 } });
      return records.map(record => record._id);
    });
    deletedIds.push(...removed);
  }
  return { success: true, deletedId: deletedIds[0] || null, deletedIds };
}

async function batchCheckin(openid, event) {
  if (!Array.isArray(event.courseIds) || !event.courseIds.length) throw new Error('Course IDs array is required');
  const checkedIn = [];
  const errors = [];
  for (const courseId of event.courseIds) {
    try {
      checkedIn.push(await checkin(openid, { ...event, courseId }));
    } catch (error) {
      errors.push({ courseId, error: error.message });
    }
  }
  return { success: !errors.length, checkedIn, errors, total: event.courseIds.length, successCount: checkedIn.length, failedCount: errors.length };
}

exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID || (event.expectedOpenid !== undefined && event.expectedOpenid !== OPENID)) throw new Error('Unauthorized');
    const handlers = { list: getCheckins, hasCheckedIn, checkin, updateNotes, cancel: cancelCheckin, batch: batchCheckin };
    const handler = handlers[event.action];
    if (!handler) throw new Error(`Invalid action: ${event.action}`);
    const data = await handler(OPENID, event.data || event);
    return { success: true, code: 200, data, message: 'Success' };
  } catch (error) {
    console.error('Checkin function error:', error);
    const code = error.message === 'Unauthorized' ? 401 : error.code === 'CHECKIN_NOTES_CONFLICT' ? 409 :
      ['Course not found', 'Checkin not found'].includes(error.message) ? 404 :
      error.message.includes('required') || error.message.includes('Invalid') ? 400 : 500;
    return { success: false, code, data: null, message: error.message };
  }
};
