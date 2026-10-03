const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloud, pauseOnce } = require('./helpers/cloud');
const { summarize } = require('../miniprogram/utils/records');

const course = (id = 'course', extra = {}) => ({ _id: id, _openid: 'owner', name: '游泳', type: 'swim', totalLessons: 20, initialLessons: 0, isDeleted: false, createdAt: 1, ...extra });
const record = (id, extra = {}) => ({ _id: id, _openid: 'owner', courseId: 'course', date: '2026-10-02', createdAt: 1, ...extra });
const ok = response => { assert.equal(response.success, true, response.message); assert.equal(response.code, 200); return response.data; };

test('cloud lesson creation normalizes notes and enforces the 60-character save limit', async () => {
  const app = createCloud({ courses: [course()] });
  const first = ok(await app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-01-01', notes: '  踢腿\n\t 练习  ' } }));
  assert.equal(first.notes, '踢腿 练习');
  assert.equal(ok(await app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-01-02', notes: '课'.repeat(60) } })).notes.length, 60);
  assert.equal((await app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-01-03', notes: '课'.repeat(61) } })).code, 400);
  assert.equal(app.rows('checkins').length, 2);
});

test('cloud note updates and clears preserve lesson identity and all count-bearing fields', async () => {
  const app = createCloud({ courses: [course('course', { initialLessons: 5, lessonRevision: 4 })], checkins: [record('lesson', { notes: '原备注', mood: '好', photos: ['photo'] })] });
  const before = ok(await app.call('stats', { action: 'overview' }));
  const updated = ok(await app.call('checkin', { action: 'updateNotes', data: { courseId: 'course', date: '2026-10-02', notes: '  换气\n练习  ' } }));
  assert.equal(updated.notes, '换气 练习');
  assert.deepEqual(updated.updatedIds, ['lesson']);
  const lesson = app.rows('checkins')[0];
  assert.equal(lesson._id, 'lesson');
  assert.equal(lesson.createdAt, 1);
  assert.equal(lesson.mood, '好');
  assert.deepEqual(lesson.photos, ['photo']);
  assert.equal(app.rows('courses')[0].lessonRevision, 4);
  assert.deepEqual(ok(await app.call('stats', { action: 'overview' })), before);
  ok(await app.call('checkin', { action: 'updateNotes', data: { courseId: 'course', date: '2026-10-02', notes: ' \n\t ' } }));
  assert.equal(app.rows('checkins')[0].notes, '');
  assert.equal(app.rows('checkins').length, 1);
});

test('cloud note edits validate length without changing legacy text on reads and can correct archived history', async () => {
  const original = '旧\n' + '课'.repeat(80);
  const app = createCloud({ courses: [course('course', { isDeleted: true })], checkins: [record('lesson', { notes: original })] });
  assert.equal(ok(await app.call('checkin', { action: 'list' })).checkins[0].notes, original);
  const request = notes => app.call('checkin', { action: 'updateNotes', data: { courseId: 'course', date: '2026-10-02', notes } });
  assert.equal((await request('课'.repeat(61))).code, 400);
  assert.equal(app.rows('checkins')[0].notes, original);
  ok(await request('课'.repeat(60)));
  assert.equal(app.rows('checkins')[0].notes.length, 60);
  assert.equal(app.rows('courses')[0].isDeleted, true);
  assert.equal(app.rows('checkins').length, 1);
});

test('cloud note edits use trusted owner and exact course/date, never create a missing lesson', async () => {
  const app = createCloud({ courses: [course(), course('second'), course('foreign', { _openid: 'other' })], checkins: [
    record('mine', { notes: 'mine' }), record('foreign', { courseId: 'foreign', _openid: 'other', notes: 'private' })
  ] });
  const before = app.rows('checkins');
  assert.equal((await app.call('checkin', { action: 'updateNotes', expectedOpenid: 'other', data: { courseId: 'course', date: '2026-10-02', notes: 'bad' } })).code, 401);
  for (const [courseId, date] of [['foreign', '2026-10-02'], ['second', '2026-10-02'], ['missing', '2026-10-02'], ['course', '2026-10-01']]) {
    assert.equal((await app.call('checkin', { action: 'updateNotes', data: { courseId, date, notes: 'bad', _openid: 'other' } })).code, 404);
  }
  for (const date of [undefined, null, {}, 12, '']) {
    assert.equal((await app.call('checkin', { action: 'updateNotes', data: { courseId: 'course', date, notes: 'bad' } })).code, 400);
  }
  assert.deepEqual(app.rows('checkins'), before);
  const anonymous = createCloud({ courses: [course()], checkins: [record('mine')] }, { openid: '' });
  assert.equal((await anonymous.call('checkin', { action: 'updateNotes', data: { courseId: 'course', date: '2026-10-02', notes: 'bad', _openid: 'owner' } })).code, 401);
});

test('all legacy duplicate records receive the same note without losing history or changing counts', async () => {
  const app = createCloud({ courses: [course()], checkins: [
    ...Array.from({ length: 125 }, (_, i) => record(`legacy-${i}`, { notes: `old-${i}` })),
    record('other-day', { date: '2026-10-01', notes: '保留' }), record('other-owner', { _openid: 'other', notes: 'private' })
  ] });
  const response = ok(await app.call('checkin', { action: 'updateNotes', data: { courseId: 'course', date: '2026-10-02', notes: '统一更正' } }));
  assert.equal(response.updatedIds.length, 125);
  assert.equal(app.rows('checkins').filter(item => item.notes === '统一更正').length, 125);
  assert.equal(app.rows('checkins').length, 127);
  assert.equal(app.rows('checkins').find(item => item._id === 'other-day').notes, '保留');
  assert.equal(app.rows('checkins').find(item => item._id === 'other-owner').notes, 'private');
  assert.equal(ok(await app.call('course', { action: 'get', courseId: 'course' })).completedCount, 2);
});

test('a superseded multi-batch note edit fails without overwriting the newer complete edit', { timeout: 2000 }, async () => {
  const gate = pauseOnce();
  let transactions = 0;
  const app = createCloud({ courses: [course()], checkins: Array.from({ length: 125 }, (_, i) => record(`legacy-${i}`, { notes: '原备注' })) }, {
    beforeTransaction: () => { if (++transactions === 2) return gate.hold(); }
  });
  const earlier = app.call('checkin', { action: 'updateNotes', data: { courseId: 'course', date: '2026-10-02', notes: '先前修改' } });
  await gate.reached;
  try {
    assert.equal(app.rows('checkins').filter(item => item.notes === '先前修改').length, 39);
    ok(await app.call('checkin', { action: 'updateNotes', data: { courseId: 'course', date: '2026-10-02', notes: '最新修改' } }));
    assert.equal(app.rows('checkins').every(item => item.notes === '最新修改'), true);
  } finally {
    gate.resume();
  }
  const interrupted = await earlier;
  assert.equal(interrupted.success, false);
  assert.equal(interrupted.code, 409);
  assert.match(interrupted.message, /concurrently/);
  assert.equal(app.rows('checkins').length, 125);
  assert.equal(app.rows('checkins').every(item => item.notes === '最新修改'), true);
  assert.equal(ok(await app.call('course', { action: 'get', courseId: 'course' })).completedCount, 1);
});

test('retrying lesson creation cannot overwrite a later note edit, and cancelled lessons stay absent', async () => {
  const app = createCloud({ courses: [course()] });
  const input = { courseId: 'course', date: '2026-10-02', notes: '初次记录' };
  ok(await app.call('checkin', { action: 'checkin', data: input }));
  ok(await app.call('checkin', { action: 'updateNotes', data: { ...input, notes: '后来更正' } }));
  assert.equal(ok(await app.call('checkin', { action: 'checkin', data: input })).notes, '后来更正');
  ok(await app.call('checkin', { action: 'cancel', data: input }));
  assert.equal((await app.call('checkin', { action: 'updateNotes', data: { ...input, notes: '不能复活' } })).code, 404);
  assert.equal(app.rows('checkins').length, 0);
  assert.equal(ok(await app.call('checkin', { action: 'checkin', data: { ...input, notes: '' } })).notes, '');
});

test('trend requests reject invalid or excessive ranges before reading the database', async () => {
  let reads = 0;
  const app = createCloud({}, { afterQuery: () => { reads++; } });
  for (const weeks of [0, -1, 1.5, 53, 2000, 'bad', null, true, []]) {
    assert.equal((await app.call('stats', { action: 'trends', weeks })).code, 400, `weeks=${weeks}`);
    assert.equal(reads, 0);
  }
  assert.equal(ok(await app.call('stats', { action: 'trends' })).trends.length, 12);
  assert.equal(ok(await app.call('stats', { action: 'trends', weeks: 52 })).trends.length, 52);
});

test('course snapshot requests skip redundant lesson aggregation while default lists retain it', async () => {
  let lessonReads = 0;
  const app = createCloud({ courses: [course()], checkins: [record('one')] }, {
    afterQuery: ({ collection }) => { if (collection === 'checkins') lessonReads++; }
  });
  const snapshot = ok(await app.call('course', { action: 'list', includeStats: false }));
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.courses[0]._id, 'course');
  assert.equal(lessonReads, 0);
  assert.equal(ok(await app.call('course', { action: 'list' })).courses[0].completedCount, 1);
  assert.equal(lessonReads, 1);
});

test('cancellation removes legacy impossible dates by exact owner/course/date and remains retryable', async () => {
  const app = createCloud({ courses: [course()], checkins: [
    record('bad1', { date: '2026-02-31' }), record('bad2', { date: '2026-02-31' }),
    record('foreign', { date: '2026-02-31', _openid: 'other' }), record('valid')
  ] });
  assert.equal((await app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-02-31' } })).code, 400);
  ok(await app.call('checkin', { action: 'cancel', checkinId: 'bad1' }));
  ok(await app.call('checkin', { action: 'cancel', courseId: 'course', date: '2026-02-31' }));
  assert.deepEqual(app.rows('checkins').map(row => row._id).sort(), ['foreign', 'valid']);
  for (const date of [{}, [], 123, null]) {
    assert.equal((await app.call('checkin', { action: 'cancel', courseId: 'course', date })).code, 400);
  }
});

test('expected identity is checked against trusted context before protected reads or writes', async () => {
  const app = createCloud({ courses: [course()] });
  for (const [name, event] of [
    ['course', { action: 'list' }], ['checkin', { action: 'list' }],
    ['stats', { action: 'overview' }],
    ['course', { action: 'add', data: { name: 'wrong owner', operationId: 'identity-test' } }]
  ]) {
    for (const expectedOpenid of ['someone-else', '', null, {}]) {
      assert.equal((await app.call(name, { ...event, expectedOpenid })).code, 401);
    }
    ok(await app.call(name, { ...event, expectedOpenid: 'owner' }));
  }
  assert.equal(app.rows('courses').filter(row => row.name === 'wrong owner').length, 1);
});

test('course creation retries keep the same owner-scoped course and unchanged input', async () => {
  const app = createCloud();
  const request = { action: 'add', data: { operationId: 'create-1', name: '游泳', initialLessons: 7, totalLessons: 20 } };
  const first = ok(await app.call('course', request)); // the client can lose this response
  const retry = ok(await app.call('course', { ...request, data: { ...request.data, name: '不应覆盖' } }));
  assert.equal(retry._id, first._id);
  assert.equal(retry.name, '游泳');
  assert.equal(retry.initialLessons, 7);
  assert.equal(retry.completedCount, 7);
  assert.equal(app.rows('courses').length, 1);
  const other = createCloud({}, { openid: 'other' });
  assert.notEqual(ok(await other.call('course', request))._id, first._id);
});

test('concurrent course creation with the same operation creates one record', async () => {
  const app = createCloud();
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.call('course', { action: 'add', data: { name: '钢琴', operationId: 'same' } })));
  assert.equal(new Set(responses.map(response => ok(response)._id)).size, 1);
  assert.equal(app.rows('courses').length, 1);
});

test('course list has full total, stable pages, archived filtering, and baseline progress', async () => {
  const app = createCloud({ courses: [...Array.from({ length: 65 }, (_, i) => course(`c${String(i).padStart(3, '0')}`, { initialLessons: 4 })), course('archived', { isDeleted: true }), course('foreign', { _openid: 'other' })], checkins: [record('c1', { courseId: 'c000' })] });
  const first = ok(await app.call('course', { action: 'list', page: 1, limit: 50 }));
  const second = ok(await app.call('course', { action: 'list', page: 2, limit: 50 }));
  assert.equal(first.total, 65);
  assert.equal(second.courses.length, 15);
  assert.equal(new Set([...first.courses, ...second.courses].map(c => c._id)).size, 65);
  const swim = [...first.courses, ...second.courses].find(c => c._id === 'c000');
  assert.equal(swim.completedCount, 5);
  assert.equal(swim.isCheckedIn, true);
  assert.equal(ok(await app.call('course', { action: 'list', includeArchived: true })).total, 66);
});

test('archiving preserves readable history, blocks new lessons, and can be restored', async () => {
  const app = createCloud({ courses: [course()], checkins: [record('old')] });
  ok(await app.call('course', { action: 'archive', courseId: 'course' }));
  assert.equal(ok(await app.call('course', { action: 'get', courseId: 'course' })).isDeleted, true);
  assert.equal((await app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-10-01' } })).success, false);
  assert.equal(ok(await app.call('checkin', { action: 'list', courseId: 'course' })).total, 1);
  ok(await app.call('course', { action: 'restore', courseId: 'course' }));
  ok(await app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-10-01' } }));
  assert.equal(app.rows('checkins').length, 2);
});

test('legacy delete archives, and permanent delete is rejected without data loss', async () => {
  const app = createCloud({ courses: [course()], checkins: [record('old')] });
  assert.equal((await app.call('course', { action: 'delete', courseId: 'course', hardDelete: true })).success, false);
  assert.equal(app.rows('checkins').length, 1);
  ok(await app.call('course', { action: 'delete', courseId: 'course' }));
  assert.equal(app.rows('courses')[0].isDeleted, true);
});

test('lesson counts must be nonnegative safe integers for create and update', async () => {
  const app = createCloud({ courses: [course()] });
  for (const field of ['totalLessons', 'initialLessons']) {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'invalid', [], [1], true]) {
      const updates = { [field]: value };
      assert.equal((await app.call('course', { action: 'update', courseId: 'course', updates })).code, 400, `${field}=${value}`);
      assert.equal((await app.call('course', { action: 'add', data: { operationId: `${field}-${value}`, name: '课程', ...updates } })).code, 400);
    }
  }
  const updated = ok(await app.call('course', { action: 'update', courseId: 'course', updates: { initialLessons: 9, totalLessons: 30 } }));
  assert.equal(updated.completedCount, 9);
});

test('course name and eight known types retain validation', async () => {
  const app = createCloud({ courses: [course()] });
  for (const updates of [{ name: '' }, { name: 'x'.repeat(51) }, { type: 'bad' }]) {
    assert.equal((await app.call('course', { action: 'update', courseId: 'course', updates })).code, 400);
  }
});

test('all entrypoints reject missing server identity', async () => {
  const app = createCloud({}, { openid: '' });
  for (const name of ['login', 'course', 'checkin', 'stats']) {
    assert.equal((await app.call(name, { action: 'list', _openid: 'owner' })).code, 401);
  }
});

test('server identity protects reads, edits, archive, and lessons from forged ownership', async () => {
  const app = createCloud({ courses: [course('foreign', { _openid: 'other' })], checkins: [record('foreign-lesson', { courseId: 'foreign', _openid: 'other' })] });
  for (const action of ['get', 'archive', 'restore', 'update']) {
    assert.equal((await app.call('course', { action, courseId: 'foreign', _openid: 'other', updates: { name: 'stolen' } })).success, false);
  }
  assert.equal((await app.call('checkin', { action: 'checkin', data: { courseId: 'foreign', date: '2026-10-02', _openid: 'other' } })).success, false);
  await app.call('checkin', { action: 'cancel', data: { courseId: 'foreign', date: '2026-10-02', _openid: 'other' } });
  assert.equal(app.rows('checkins').length, 1);
  assert.equal(ok(await app.call('checkin', { action: 'list' })).total, 0);
});

test('concurrent lesson submissions create one lesson and repeat success without user-counter writes', async () => {
  const app = createCloud({ courses: [course()], users: [{ _id: 'user', _openid: 'owner', totalCheckins: 77, streakDays: 77 }] });
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-10-02', notes: '上课' } })));
  assert.equal(new Set(responses.map(response => ok(response)._id)).size, 1);
  assert.equal(app.rows('checkins').length, 1);
  assert.equal(app.rows('users')[0].totalCheckins, 77);
  assert.equal(app.rows('users')[0].streakDays, 77);
});

test('legacy random-ID lessons are reused and cancellation removes all duplicates idempotently', async () => {
  const app = createCloud({ courses: [course()], checkins: [record('legacy-1'), record('legacy-2')] });
  const existing = ok(await app.call('checkin', { action: 'checkin', courseId: 'course', date: '2026-10-02' }));
  assert.match(existing._id, /^legacy-/);
  assert.equal(app.rows('checkins').length, 2);
  ok(await app.call('checkin', { action: 'cancel', data: { courseId: 'course', date: '2026-10-02' } }));
  ok(await app.call('checkin', { action: 'cancel', data: { courseId: 'course', date: '2026-10-02' } }));
  assert.equal(app.rows('checkins').length, 0);
});

test('real calendar validation accepts leap day, rejects invalid/future dates, and uses China today', async () => {
  const app = createCloud({ courses: [course()] });
  for (const date of ['2026-02-29', '2024-02-30', '2026-13-01', '2026-00-01', '2026-1-01', '2026-10-03', '0000-01-01']) {
    assert.equal((await app.call('checkin', { action: 'checkin', courseId: 'course', date })).code, 400, date);
  }
  ok(await app.call('checkin', { action: 'checkin', courseId: 'course', date: '2024-02-29' }));
  const today = ok(await app.call('checkin', { action: 'checkin', courseId: 'course' }));
  assert.equal(today.date, '2026-10-02');
});

test('checkin pagination includes every owner record with stable tie ordering and date filters', async () => {
  const app = createCloud({ courses: [course()], checkins: [...Array.from({ length: 125 }, (_, i) => record(`r${String(i).padStart(3, '0')}`)).reverse(), record('other', { _openid: 'other' })] });
  const ids = [];
  for (let page = 1; page <= 3; page++) {
    const data = ok(await app.call('checkin', { action: 'list', page, limit: 50, startDate: '2026-10-02', endDate: '2026-10-02' }));
    assert.equal(data.total, 125);
    ids.push(...data.checkins.map(c => c._id));
  }
  assert.equal(new Set(ids).size, 125);
  assert.deepEqual(ids, [...ids].sort());
});

test('stats fetch all pages, include archived history, and exclude baseline from dated counts', async () => {
  const courses = Array.from({ length: 125 }, (_, i) => course(`c${i}`, { initialLessons: 2, isDeleted: i === 0 }));
  const app = createCloud({ courses, checkins: courses.map((c, i) => record(`r${i}`, { courseId: c._id })), users: [{ _id: 'user', _openid: 'owner', streakDays: 99 }] });
  const overview = ok(await app.call('stats', { action: 'overview' }));
  assert.equal(overview.totalCheckins, 375);
  assert.equal(overview.totalCourses, 124);
  assert.equal(overview.monthCheckins, 125);
  assert.equal(overview.weekCheckins, 125);
  assert.equal(overview.streakDays, 1);
  assert.equal(ok(await app.call('stats', { action: 'weekly' })).total, 125);
  const monthly = ok(await app.call('stats', { action: 'monthly', year: 2026, month: 10 }));
  assert.equal(monthly.totalCheckins, 125);
  assert.equal(monthly.courseBreakdown.find(c => c._id === 'c0').name, '游泳');
  assert.equal(ok(await app.call('stats', { action: 'heatmap' })).totalCheckins, 125);
  const ranking = ok(await app.call('stats', { action: 'ranking' }));
  assert.equal(ranking.total, 125);
  assert.equal(ranking.ranking[0].checkinCount, 3);
  assert.equal(ok(await app.call('stats', { action: 'trends', weeks: 1 })).trends[0].count, 125);
});

test('current streak is derived from dates, not a stale user counter', async () => {
  const app = createCloud({ courses: [course()], checkins: [record('old', { date: '2026-09-29' })], users: [{ _id: 'user', _openid: 'owner', streakDays: 99 }] });
  assert.equal(ok(await app.call('stats', { action: 'overview' })).streakDays, 0);
});

test('concurrent login creates one user and preserves a legacy existing profile', async () => {
  const app = createCloud();
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.call('login', { nickName: '家长' })));
  assert.equal(new Set(responses.map(response => ok(response).userId)).size, 1);
  assert.equal(app.rows('users').length, 1);
  const legacy = createCloud({ users: [{ _id: 'random-legacy', _openid: 'owner', nickName: '原昵称', loginCount: 3 }] });
  assert.equal(ok(await legacy.call('login', {})).userId, 'random-legacy');
  assert.equal(legacy.rows('users')[0].nickName, '原昵称');
});

test('dated statistics never attribute malformed or future legacy records to actual lessons', async () => {
  const app = createCloud({ courses: [course()], checkins: [record('real'), record('future', { date: '2026-10-03' }), record('invalid', { date: '2026-10-01.5' })] });
  const overview = ok(await app.call('stats', { action: 'overview' }));
  assert.equal(overview.weekCheckins, 1);
  assert.equal(overview.monthCheckins, 1);
  assert.equal(ok(await app.call('stats', { action: 'weekly' })).total, 1);
  assert.equal(ok(await app.call('stats', { action: 'monthly' })).totalCheckins, 1);
  assert.equal(ok(await app.call('stats', { action: 'trends', weeks: 1 })).trends[0].count, 1);
  assert.equal(ok(await app.call('stats', { action: 'heatmap' })).totalCheckins, 1);
});

test('legacy flat creation stays compatible while new creation requires a retry key', async () => {
  const app = createCloud();
  ok(await app.call('course', { action: 'add', name: '旧客户端' }));
  assert.equal((await app.call('course', { action: 'add', data: { name: '新客户端' } })).code, 400);
});

test('cancelling more than one page of legacy duplicates leaves no lessons', async () => {
  const app = createCloud({ courses: [course()], checkins: Array.from({ length: 125 }, (_, i) => record(`legacy-${i}`)) });
  ok(await app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-10-02' } }));
  ok(await app.call('checkin', { action: 'cancel', data: { courseId: 'course', date: '2026-10-02' } }));
  assert.equal(app.rows('checkins').length, 0);
});

test('China month boundary and streak use dates instead of host timezone or lesson count', async () => {
  const app = createCloud({ courses: [course()], checkins: [record('today', { date: '2026-10-01' }), record('same-day', { date: '2026-10-01' }), record('yesterday', { date: '2026-09-30' }), record('before', { date: '2026-09-29' })] }, { now: '2026-09-30T16:01:00.000Z' });
  const overview = ok(await app.call('stats', { action: 'overview' }));
  assert.equal(overview.monthCheckins, 1);
  assert.equal(overview.todayCheckins, 1);
  assert.equal(overview.streakDays, 3);
  assert.equal(ok(await app.call('stats', { action: 'monthly' })).month, 10);
});

test('course progress counts duplicate legacy IDs as one lesson without removing history', async () => {
  const app = createCloud({ courses: [course('course', { initialLessons: 5 })], checkins: [record('legacy-1'), record('legacy-2')] });
  const detail = ok(await app.call('course', { action: 'get', courseId: 'course' }));
  assert.equal(detail.completedCount, 6);
  assert.equal(detail.isCheckedIn, true);
  assert.equal(ok(await app.call('course', { action: 'list' })).courses[0].completedCount, 6);
  const raw = ok(await app.call('checkin', { action: 'list', courseId: 'course' }));
  assert.equal(raw.total, 2);
  assert.equal(raw.checkins.length, 2);
  assert.equal(app.rows('checkins').length, 2);
});

test('every statistics action deduplicates across pages and agrees with client course/day counting', async () => {
  const courses = [course('course', { initialLessons: 5 }), course('archived', { initialLessons: 2, isDeleted: true })];
  const checkins = [
    ...Array.from({ length: 125 }, (_, i) => record(`duplicate-${i}`)),
    record('yesterday', { date: '2026-10-01' }),
    record('other-course', { courseId: 'archived' })
  ];
  const app = createCloud({ courses, checkins });
  const client = summarize(courses, checkins, '2026-10', '2026-10-02');
  const overview = ok(await app.call('stats', { action: 'overview' }));
  assert.equal(overview.totalCheckins, 10);
  assert.equal(overview.totalCheckins, client.totalLessons);
  assert.equal(overview.monthCheckins, client.monthLessons);
  assert.equal(overview.todayCheckins, client.todayLessons);
  assert.equal(overview.weekCheckins, 3);
  assert.equal(ok(await app.call('stats', { action: 'weekly' })).total, 3);
  const monthly = ok(await app.call('stats', { action: 'monthly' }));
  assert.equal(monthly.totalCheckins, 3);
  assert.equal(monthly.courseBreakdown.find(c => c._id === 'course').monthCheckins, 2);
  const heatmap = ok(await app.call('stats', { action: 'heatmap' }));
  assert.equal(heatmap.totalCheckins, 3);
  assert.equal(heatmap.heatmapData.find(day => day.date === '2026-10-02').count, 2);
  assert.equal(ok(await app.call('stats', { action: 'trends', weeks: 1 })).trends[0].count, 3);
  const ranking = ok(await app.call('stats', { action: 'ranking' })).ranking;
  for (const expected of client.courses) {
    const ranked = ranking.find(item => item._id === expected._id);
    assert.equal(ranked.checkinCount, expected.completedCount);
    assert.equal(ranked.progress, expected.progress);
    assert.equal(ranked.remaining, expected.remainingCount);
    assert.equal(ok(await app.call('course', { action: 'get', courseId: expected._id })).completedCount, expected.completedCount);
  }
  assert.equal(ok(await app.call('checkin', { action: 'list' })).total, 127);
  assert.equal(app.rows('checkins').length, 127);
});

test('recording resumes safely after all 125 discovered legacy duplicates are cancelled', { timeout: 2000 }, async () => {
  const gate = pauseOnce();
  const app = createCloud({ courses: [course()], checkins: [
    ...Array.from({ length: 125 }, (_, i) => record(`legacy-${i}`)),
    record('previous-day', { date: '2026-10-01' })
  ] }, { beforeTransaction: gate.hold });
  const recording = app.call('checkin', { action: 'checkin', data: { courseId: 'course', date: '2026-10-02' } });
  await gate.reached;
  try {
    ok(await app.call('checkin', { action: 'cancel', data: { courseId: 'course', date: '2026-10-02' } }));
    assert.equal(app.rows('checkins').length, 1);
  } finally {
    gate.resume();
  }
  const result = ok(await recording);
  assert.equal(result.date, '2026-10-02');
  assert.equal(app.rows('checkins').filter(row => row.date === '2026-10-02').length, 1);
  assert.equal(app.rows('checkins').find(row => row._id === 'previous-day').date, '2026-10-01');
});

test('an edit paused before its authorization cannot modify a course archived meanwhile', { timeout: 2000 }, async () => {
  const gate = pauseOnce();
  const app = createCloud({ courses: [course()] }, {
    afterQuery: query => query.collection === 'courses' && query.condition._id === 'course' && query.condition.isDeleted ? gate.hold() : undefined,
    beforeTransaction: gate.hold
  });
  const editing = app.call('course', { action: 'update', courseId: 'course', updates: { name: '归档后不能改' } });
  await gate.reached;
  try {
    assert.equal(ok(await app.call('course', { action: 'archive', courseId: 'course' })).isDeleted, true);
  } finally {
    gate.resume();
  }
  assert.equal((await editing).success, false);
  assert.equal(app.rows('courses')[0].name, '游泳');
  assert.equal(app.rows('courses')[0].isDeleted, true);
});

test('recording rechecks a removed legacy candidate while other cancellation batches remain', { timeout: 2000 }, async () => {
  const recordGate = pauseOnce();
  const cancelGate = pauseOnce();
  let transactions = 0;
  const app = createCloud({ courses: [course()], checkins: Array.from({ length: 125 }, (_, i) => record(`legacy-${i}`)) }, {
    beforeTransaction: () => {
      transactions++;
      if (transactions === 1) return recordGate.hold();
      if (transactions === 3) return cancelGate.hold();
    }
  });
  const recording = app.call('checkin', { action: 'checkin', courseId: 'course', date: '2026-10-02' });
  await recordGate.reached;
  const cancelling = app.call('checkin', { action: 'cancel', courseId: 'course', date: '2026-10-02' });
  await cancelGate.reached;
  try {
    assert.equal(app.rows('checkins').length, 85);
    recordGate.resume();
    assert.match(ok(await recording)._id, /^legacy-/);
    assert.equal(app.rows('checkins').length, 85);
  } finally {
    recordGate.resume();
    cancelGate.resume();
  }
  ok(await cancelling);
  assert.equal(app.rows('checkins').length, 0);
});

test('creation operationId is persisted for refresh reconciliation and cannot be edited or replaced by retry', async () => {
  const app = createCloud();
  const request = { action: 'add', data: { operationId: 'lost-response-key', name: '游泳' } };
  const created = ok(await app.call('course', request));
  assert.equal(created.operationId, 'lost-response-key');
  assert.equal(app.rows('courses')[0].operationId, 'lost-response-key');
  assert.equal(ok(await app.call('course', { action: 'list' })).courses[0].operationId, 'lost-response-key');
  const updated = ok(await app.call('course', { action: 'update', courseId: created._id, updates: { operationId: 'must-not-change' } }));
  assert.equal(updated.operationId, 'lost-response-key');
  const retried = ok(await app.call('course', { ...request, data: { ...request.data, name: '不能覆盖' } }));
  assert.equal(retried._id, created._id);
  assert.equal(retried.operationId, 'lost-response-key');
  assert.equal(retried.name, '游泳');
  assert.equal(app.rows('courses').length, 1);
});

const transactionCases = [
  { label: 'course.add', name: 'course', event: { action: 'add', data: { operationId: 'conflict-key', name: '游泳' } }, seed: {}, verify: app => assert.equal(app.rows('courses').length, 1) },
  { label: 'course.update', name: 'course', event: { action: 'update', courseId: 'course', updates: { name: '新名字' } }, seed: { courses: [course()] }, verify: app => assert.equal(app.rows('courses')[0].name, '新名字') },
  { label: 'course.archive', name: 'course', event: { action: 'archive', courseId: 'course' }, seed: { courses: [course()] }, verify: app => assert.equal(app.rows('courses')[0].isDeleted, true) },
  { label: 'course.restore', name: 'course', event: { action: 'restore', courseId: 'course' }, seed: { courses: [course('course', { isDeleted: true })] }, verify: app => assert.equal(app.rows('courses')[0].isDeleted, false) },
  { label: 'checkin.checkin', name: 'checkin', event: { action: 'checkin', courseId: 'course', date: '2026-10-02' }, seed: { courses: [course()] }, verify: app => assert.equal(app.rows('checkins').length, 1) },
  { label: 'checkin.cancel', name: 'checkin', event: { action: 'cancel', courseId: 'course', date: '2026-10-02' }, seed: { courses: [course()], checkins: [record('old')] }, verify: app => assert.equal(app.rows('checkins').length, 0) },
  { label: 'login new', name: 'login', event: {}, seed: {}, verify: app => assert.equal(app.rows('users').length, 1) },
  { label: 'login existing', name: 'login', event: {}, seed: { users: [{ _id: 'old-user', _openid: 'owner', loginCount: 5 }] }, verify: app => assert.equal(app.rows('users')[0].loginCount, 6) }
];

function wrappedTransactionConflict() {
  const message = 'document.set:fail -501001 resource system error. database transaction conflict';
  return Object.assign(new Error(message), { errCode: -501001, errMsg: message });
}

for (const scenario of transactionCases) {
  test(`${scenario.label} retries the officially wrapped conflict and commits only once`, async () => {
    const retryOptions = [];
    const app = createCloud(scenario.seed, { beforeTransactionCommit: ({ retryTimes }) => {
      retryOptions.push(retryTimes);
      if (retryOptions.length === 1) throw wrappedTransactionConflict();
    } });
    ok(await app.call(scenario.name, scenario.event));
    assert.deepEqual(retryOptions, [0, 0]);
    scenario.verify(app);
  });
}

test('raw transaction conflict codes are retried with a total limit of three attempts', async () => {
  for (const scenario of transactionCases) {
    let attempts = 0;
    const app = createCloud(scenario.seed, { beforeTransactionCommit: () => {
      attempts++;
      throw Object.assign(new Error('database transaction conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' });
    } });
    const result = await app.call(scenario.name, scenario.event);
    assert.equal(result.success, false, scenario.label);
    assert.equal(attempts, 3, scenario.label);
    for (const collection of ['courses', 'checkins', 'users']) assert.deepEqual(app.rows(collection), scenario.seed[collection] || []);
  }
});

test('generic SDK, permission, timeout, and unknown errors are not retried or swallowed', async () => {
  for (const scenario of transactionCases) {
    for (const failure of [
      Object.assign(new Error('resource system error. permission denied'), { errCode: -501001 }),
      Object.assign(new Error('permission denied'), { code: 'PERMISSION_DENIED' }),
      new Error('request timeout'),
      new Error('unknown conflict')
    ]) {
      let attempts = 0;
      const app = createCloud(scenario.seed, { beforeTransactionCommit: () => { attempts++; throw failure; } });
      const result = await app.call(scenario.name, scenario.event);
      assert.equal(result.success, false, scenario.label);
      assert.equal(result.message, failure.message);
      assert.equal(attempts, 1, scenario.label);
      for (const collection of ['courses', 'checkins', 'users']) assert.deepEqual(app.rows(collection), scenario.seed[collection] || []);
    }
  }
});

test('business validation and ownership errors do not trigger transaction retries', async () => {
  let attempts = 0;
  const app = createCloud({ courses: [course('foreign', { _openid: 'other' })] }, { beforeTransaction: () => { attempts++; } });
  assert.equal((await app.call('course', { action: 'add', data: { operationId: 'bad', name: '' } })).code, 400);
  assert.equal(attempts, 1);
  assert.equal((await app.call('checkin', { action: 'checkin', courseId: 'foreign', date: '2026-10-02' })).code, 404);
  assert.equal(attempts, 2);
});
