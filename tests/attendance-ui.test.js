const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { client } = require('./helpers/client');
function instance(definition, props = {}) {
  const value = { ...definition, ...(definition.methods || {}), data: JSON.parse(JSON.stringify(definition.data || {})), properties: props };
  value.setData = changes => { for (const [key, data] of Object.entries(changes)) { const parts = key.split('.'); let target = value.data; while (parts.length > 1) target = target[parts.shift()]; target[parts[0]] = data; } };
  value.triggerEvent = (name, detail) => { value.event = { name, detail }; };
  return value;
}
function setup() {
  const c = client({ app: { ensureReady: async () => true } });
  const storage = c.load('miniprogram/utils/storage.js'); storage.activate('env', 'owner');
  const db = c.load('miniprogram/utils/db.js').db;
  return { c, storage, db };
}
const seed = (storage, courses, checkins = []) => storage.update(state => { state.courses = courses; state.checkins = checkins; });
test('course form saves structured adoption and a single course note', async () => {
  const { c, storage } = setup(); c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition());
  await page.onLoad({}); page.onNameInput({ detail: { value: '游泳' } }); page.onNotesInput({ detail: { value: '临时上课前联系老师' } });
  assert.equal(typeof page.onScheduleToggle, 'function');
  page.onScheduleToggle({ detail: { value: true } }); page.onWeekdayTap({ currentTarget: { dataset: { weekday: 6 } } });
  page.onEffectiveDateChange({ detail: { value: '2026-01-01' } }); await page.onSave();
  const payload = storage.read().queue[0].payload;
  assert.equal(payload.schedule, ''); assert.equal(payload.notes, '临时上课前联系老师'); assert.equal(payload.scheduleChange.effectiveFrom, '2026-01-01');
  assert.equal(payload.scheduleChange.slots.length, 1); assert.equal(payload.scheduleChange.expectedVersion, '');
});
test('ordinary edit adds no schedule version; disable uses captured date and version', async () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '旧课程', type: 'swim', scheduleVersions: [{ effectiveFrom: '2026-01-01', operationId: 'v1', slots: [{ weekday: 6, start: '10:00', end: '11:00' }] }] }]);
  c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({ id: 'c' });
  page.onNameInput({ detail: { value: '改名' } }); await page.onSave(); assert.equal(storage.read().queue[0].payload.updates.scheduleChange, undefined);
  const second = instance(c.definition()); await second.onLoad({ id: 'c' }); const requestedOn = second.data.scheduleRequestedOn;
  assert.ok(second.data.scheduleMinDate > requestedOn); second.onScheduleToggle({ detail: { value: false } });
  storage.deactivate(); storage.activate('env', 'owner'); await second.loadCourse(); await second.onSave();
  const change = storage.read().queue[1].payload.updates.scheduleChange;
  assert.equal(change.expectedVersion, 'v1'); assert.equal(change.requestedOn, requestedOn); assert.deepEqual(Array.from(change.slots), []);
});
test('enabled schedule without weekdays rejects before durable save', async () => {
  const { c, storage } = setup(); c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({});
  page.onNameInput({ detail: { value: '数学' } }); assert.equal(typeof page.onScheduleToggle, 'function'); page.onScheduleToggle({ detail: { value: true } }); await page.onSave();
  assert.equal(storage.read().queue.length, 0); assert.ok(c.calls.some(call => /上课日/.test(call.toast || '')));
});
test('home exposes global reminders and absence action cannot silently attend', async () => {
  const { c, storage, db } = setup(); const date = c.load('miniprogram/utils/records.js').today();
  seed(storage, [{ _id: 'c', name: '游泳', type: 'swim', scheduleVersions: [{ effectiveFrom: '2026-01-01', slots: [{ weekday: 6, start: '10:00', end: '11:00' }] }] }, { _id: 'd', name: '钢琴', type: 'piano', scheduleVersions: [{ effectiveFrom: '2030-01-01', slots: [{ weekday: 0, start: '10:00', end: '11:00' }] }] }], [{ _id: 'r', courseId: 'c', date, status: 'absent', debit: 1, attendanceRevision: 1 }]);
  c.load('miniprogram/pages/index/index.js'); const page = instance(c.definition()); page.data.ready = true; page.render();
  assert.equal(page.data.pendingCount, db.snapshot().pendingCount); assert.equal(page.data.nextSession.courseId, db.snapshot().nextSession.courseId); assert.ok(page.data.nextSession.relativeDay);
  page.onPendingTap(); assert.match(c.calls.at(-1).navigate, /attendance.*filter=pending/);
  await page.onCheckin({ detail: { courseId: 'c' } }); assert.equal(storage.read().queue.length, 0); assert.match(c.calls.at(-1).navigate, /course-detail/);
});
test('course card uses consumed balance and neutral correction action', () => {
  const { c } = setup(); c.load('miniprogram/components/course-card/course-card.js'); const card = instance(c.definition(), { courseId: 'c', completedCount: 2, consumedCount: 4, totalCount: 10, todayStatus: 'absent' });
  card.calculateProgress(); assert.equal(card.data.remaining, 6); assert.equal(card.data.progressPercent, 40); card.onCheckinTap(); assert.equal(card.event.name, 'cardtap');
});
test('detail derives planned timeline with filters and opens captured revision', () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '游泳', type: 'swim', scheduleVersions: [{ effectiveFrom: '2026-01-01', slots: [{ weekday: 6, start: '10:00', end: '11:00' }] }] }], [{ _id: 'r', courseId: 'c', date: '2026-01-03', status: 'absent', debit: 1, attendanceRevision: 3, reason: '请假', notes: '考试' }]);
  c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition()); page.setData({ courseId: 'c', selectedDate: '2026-01-03', ready: true }); page.render();
  assert.ok(page.data.records.some(row => row.status === 'pending')); page.onFilterTap({ currentTarget: { dataset: { filter: 'absent' } } }); assert.equal(page.data.records.length, 1);
  page.onOpenAttendance({ currentTarget: { dataset: { key: page.data.records[0].key } } }); assert.equal(page.data.attendanceRow.attendanceRevision, 3);
  page.onMonthChange({ detail: { value: '2026-01' } }); assert.ok(page.data.records.every(row => row.date.startsWith('2026-01')));
});
test('shared editor saves absence free, charged, corrected without inflating attendance', async () => {
  const { c, storage, db } = setup(); const date = c.load('miniprogram/utils/records.js').today(); seed(storage, [{ _id: 'c', name: '游泳', totalLessons: 10 }]);
  c.load('miniprogram/components/attendance-editor/attendance-editor.js');
  const open = row => { const editor = instance(c.definition(), { row, open: true }); editor.lifetimes.attached.call(editor); editor.loadDraft(); return editor; };
  let editor = open({ courseId: 'c', courseName: '游泳', date, status: 'pending', attendanceRevision: 0 }); editor.onStatusTap({ currentTarget: { dataset: { status: 'absent' } } }); await editor.onSave();
  assert.equal(db.snapshot().courses[0].consumedCount, 0); assert.equal(db.snapshot().totalLessons, 0);
  editor = open(db.snapshot().rawCheckins[0]); editor.onDebitChange({ detail: { value: true } }); await Promise.all([editor.onSave(), editor.onSave()]); assert.equal(storage.read().queue.length, 2); assert.equal(db.snapshot().courses[0].remainingCount, 9);
  editor = open(db.snapshot().rawCheckins[0]); editor.onStatusTap({ currentTarget: { dataset: { status: 'attended' } } }); await editor.onSave(); assert.equal(db.snapshot().totalLessons, 1); assert.equal(db.snapshot().courses[0].remainingCount, 9);
});
test('editor account switch during confirmation closes without submitting old draft', async () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '游泳' }]); const date = c.load('miniprogram/utils/records.js').today(); c.load('miniprogram/components/attendance-editor/attendance-editor.js'); const editor = instance(c.definition(), { open: true, row: { courseId: 'c', date, status: 'pending', attendanceRevision: 0 } });
  editor.lifetimes.attached.call(editor); editor.loadDraft(); editor.onNotesInput({ detail: { value: '旧账号备注' } }); storage.activate('env', 'other'); await editor.onSave();
  assert.equal(storage.read().queue.length, 0); assert.equal(editor.data.notes, ''); assert.equal(editor.event.name, 'close'); editor.lifetimes.detached.call(editor);
});
test('global timeline defaults pending and excludes archived pending but keeps outcomes', () => {
  const { c, storage } = setup(); const scheduleVersions = [{ effectiveFrom: '2026-01-01', slots: [{ weekday: 6, start: '10:00', end: '11:00' }] }]; seed(storage, [{ _id: 'c', name: '游泳', scheduleVersions }, { _id: 'a', name: '归档课', isDeleted: true, deletedAt: '2026-02-01', scheduleVersions }], [{ _id: 'r', courseId: 'a', date: '2026-01-03', status: 'absent', debit: 0 }]);
  assert.ok(fs.existsSync('miniprogram/pages/attendance/attendance.js')); c.load('miniprogram/pages/attendance/attendance.js'); const page = instance(c.definition()); page.onLoad({ filter: 'pending' }); page.render(); assert.ok(page.data.records.length); assert.ok(page.data.records.every(row => row.status === 'pending' && row.courseId === 'c'));
  page.onFilterTap({ currentTarget: { dataset: { filter: 'absent' } } }); assert.equal(page.data.records[0].courseId, 'a'); page.onUnload();
});
test('stats month excludes absence from attended records but displays consumed and pending', () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '游泳', totalLessons: 10 }], [{ _id: 'a', courseId: 'c', date: '2026-01-01', status: 'attended', debit: 1 }, { _id: 'b', courseId: 'c', date: '2026-01-02', status: 'absent', debit: 1 }, { _id: 'd', courseId: 'c', date: '2026-01-03', status: 'cancelled', debit: 0 }]);
  c.load('miniprogram/pages/stats/stats.js'); const page = instance(c.definition()); page.data.month = '2026-01'; page.render(); assert.equal(page.data.monthRecords.length, 1); assert.equal(page.data.summary.monthConsumedLessons, 2); assert.equal(page.data.monthAbsentCount, 1); page.onAttendanceTap({ currentTarget: { dataset: { filter: 'absent' } } }); assert.match(c.calls.at(-1).navigate, /filter=absent&month=2026-01/);
});
test('editor pending attended and charged absence to cancelled derive valid debit', async () => {
  const { c, storage, db } = setup(); const date = c.load('miniprogram/utils/records.js').today(); seed(storage, [{ _id: 'c', name: '游泳' }]); c.load('miniprogram/components/attendance-editor/attendance-editor.js');
  const editor = instance(c.definition(), { open: true, row: { courseId: 'c', date, status: 'pending', attendanceRevision: 0 } }); editor.loadDraft(); await editor.onSave(); assert.equal(db.snapshot().checkins.length, 1); assert.equal(db.snapshot().checkins[0].debit, 1);
  await db.setAttendance('c', { date, status: 'absent', debit: 1 }); const second = instance(c.definition(), { open: true, row: db.snapshot().rawCheckins[0] }); second.loadDraft(); second.onStatusTap({ currentTarget: { dataset: { status: 'cancelled' } } }); await second.onSave(); assert.equal(db.snapshot().checkins[0].status, 'cancelled'); assert.equal(db.snapshot().courses[0].consumedCount, 0);
});
test('valid future plan dates display correctly but cannot be confirmed', () => {
  const { c } = setup(); const view = c.load('miniprogram/utils/attendance-view.js'); const row = view.displayRow({ date: '2099-01-01', status: 'upcoming', scheduled: true });
  assert.equal(row.day, '01'); assert.equal(row.dateLabel, '2099.01.01'); assert.equal(row.canConfirm, false); assert.equal(view.displayRow({ date: '2026-02-31', status: 'attended' }).day, '—');
});
test('reverted schedule controls do not create a new arrangement version', async () => {
  const { c, storage } = setup(); c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({}); page.onNameInput({ detail: { value: '数学' } }); page.onScheduleToggle({ detail: { value: true } }); page.onScheduleToggle({ detail: { value: false } }); await page.onSave(); assert.equal(storage.read().queue[0].payload.scheduleChange, undefined);
});
test('profile offers cloud adoption only for eligible failed conflict queue head and needs confirmation', async () => {
  const { c, storage, db } = setup(); seed(storage, [{ _id: 'c', name: '游泳' }]); await db.setAttendance('c', { date: '2026-01-01', status: 'absent' }); storage.update(state => { state.queue[0].status = 'failed'; state.queue[0].lastErrorCode = 409; });
  c.load('miniprogram/pages/profile/profile.js'); const page = instance(c.definition()); page.render(); assert.equal(page.data.pending[0].label, '确认或更正上课结果'); assert.equal(page.data.conflictOperationId, storage.read().queue[0]._id);
  let confirmation = ''; c.wx.showModal = options => { confirmation = options.content; options.success({ confirm: false }); }; await page.onAdoptCloudResult(); assert.match(confirmation, /备份/); assert.equal(storage.read().queue.length, 1);
  storage.update(state => { state.queue[0].lastErrorCode = 500; }); page.render(); assert.equal(page.data.conflictOperationId, '');
});
test('profile cloud adoption backs dependent edits and retains unrelated manual retries', async () => {
  const success = data => ({ result: { success: true, code: 200, data } });
  const c = client({ cloud: async ({ name }) => success(name === 'course' ? { courses: [{ _id: 'c', name: '游泳', totalLessons: 10 }], total: 1 } : { checkins: [{ _id: 'r', courseId: 'c', date: '2026-01-01', status: 'attended', attendanceRevision: 7 }], total: 1 }) }); const storage = c.load('miniprogram/utils/storage.js'); storage.activate('env', 'owner'); const db = c.load('miniprogram/utils/db.js').db; seed(storage, [{ _id: 'c', name: '游泳' }]);
  await db.setAttendance('c', { date: '2026-01-01', status: 'absent' }); await db.setAttendance('c', { date: '2026-01-01', status: 'absent', debit: 1 }); await db.setAttendance('c', { date: '2026-01-02', status: 'absent' }); storage.update(state => { state.queue[0].status = 'failed'; state.queue[0].lastErrorCode = 409; });
  c.load('miniprogram/pages/profile/profile.js'); const page = instance(c.definition()); page.render(); assert.equal(typeof page.onAdoptCloudResult, 'function'); await page.onAdoptCloudResult(); assert.equal(storage.read().discardedOperations.length, 2); assert.equal(storage.read().queue.length, 1); assert.ok(c.calls.some(call => /2.*备份/.test(call.toast || '')));
});
test('ordinary edit of queued structured course never resubmits inherited scheduleChange', async () => {
  const { c, storage, db } = setup(); const date = c.load('miniprogram/utils/records.js').today(); const added = await db.addCourse({ name: '游泳', type: 'swim', scheduleChange: { effectiveFrom: date, slots: [{ weekday: 6, start: '10:00', end: '11:00' }], requestedOn: date, expectedVersion: '' } });
  c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({ id: added._id }); page.onNameInput({ detail: { value: '改名不改安排' } }); await page.onSave(); assert.equal(storage.read().queue.length, 2); assert.equal(storage.read().queue[1].payload.updates.scheduleChange, undefined);
});
test('editor rejects stale revision without rebasing or losing typed notes', async () => {
  const { c, storage, db } = setup(); seed(storage, [{ _id: 'c', name: '游泳' }]); const date = '2026-01-01'; await db.setAttendance('c', { date, status: 'absent', debit: 0, reason: '请假', notes: '原备注' }); c.load('miniprogram/components/attendance-editor/attendance-editor.js'); const editor = instance(c.definition(), { open: true, row: db.snapshot().rawCheckins[0] }); editor.loadDraft(); assert.equal(editor.data.reason, '请假'); editor.onNotesInput({ detail: { value: '我的更正草稿' } }); await db.setAttendance('c', { date, status: 'attended' }); editor.properties.row = db.snapshot().rawCheckins[0]; editor.loadDraft(); await editor.onSave(); assert.match(editor.data.error, /更新|刷新/); assert.equal(editor.data.notes, '我的更正草稿'); assert.equal(storage.read().queue.length, 2);
});
test('future and archived new outcomes are blocked; archived existing correction remains allowed', async () => {
  const { c, storage, db } = setup(); seed(storage, [{ _id: 'c', name: '游泳', isDeleted: true }], [{ _id: 'r', courseId: 'c', date: '2026-01-01', status: 'absent', debit: 0, attendanceRevision: 1 }]); c.load('miniprogram/components/attendance-editor/attendance-editor.js');
  const open = row => { const editor = instance(c.definition(), { open: true, row }); editor.loadDraft(); return editor; };
  let editor = open({ courseId: 'c', date: '2099-01-01', status: 'upcoming' }); await editor.onSave(); assert.equal(storage.read().queue.length, 0); assert.match(editor.data.error, /未来/);
  editor = open({ courseId: 'c', date: '2026-01-02', status: 'pending' }); await editor.onSave(); assert.equal(storage.read().queue.length, 0); assert.match(editor.data.error, /归档/);
  editor = open(db.snapshot().rawCheckins[0]); editor.onStatusTap({ currentTarget: { dataset: { status: 'attended' } } }); await editor.onSave(); assert.equal(db.snapshot().checkins[0].status, 'attended');
});
test('shared editor cancel has no writes and long legacy notes remain intact on error', async () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '游泳' }]); c.load('miniprogram/components/attendance-editor/attendance-editor.js'); const row = { courseId: 'c', date: '2026-01-01', status: 'attended', notes: '课'.repeat(70), attendanceRevision: 0 }; const editor = instance(c.definition(), { open: true, row }); editor.loadDraft(); await editor.onSave(); assert.equal(editor.data.notes.length, 70); assert.match(editor.data.error, /60/); editor.onClose(); assert.equal(storage.read().queue.length, 0);
});
test('detail absence undo returns consumed balance and restores pending with revision', async () => {
  const { c, storage, db } = setup(); seed(storage, [{ _id: 'c', name: '游泳', totalLessons: 10, scheduleVersions: [{ effectiveFrom: '2026-01-01', slots: [{ weekday: 6, start: '10:00', end: '11:00' }] }] }], [{ _id: 'r', courseId: 'c', date: '2026-01-03', status: 'absent', debit: 1, attendanceRevision: 2 }]); c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition()); page.setData({ courseId: 'c', ready: true, selectedDate: '2026-01-03' }); page.render(); let confirmation; c.wx.showModal = options => { confirmation = options.content; options.success({ confirm: true }); }; await page.onCheckin(); assert.equal(page.data.attendanceOpen, true); assert.equal(storage.read().queue.length, 0); await page.onCancelCheckin({ currentTarget: { dataset: { date: '2026-01-03' } } }); assert.match(confirmation, /已上课时不变/); assert.match(confirmation, /返还 1/); assert.equal(db.snapshot().courses[0].remainingCount, 10); const row = page.data.records.find(item => item.date === '2026-01-03'); assert.equal(row.status, 'pending'); assert.equal(row.attendanceRevision, 3);
});
test('manual backfill identity switch while native confirmation waits cannot leak old notes', async () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '游泳' }]); c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition()); page.onLoad({ id: 'c' }); page.setData({ ready: true, selectedDate: '2026-01-01' }); page.render(); page.onNotesInput({ detail: { value: '旧账号私密备注' } }); let confirm; c.wx.showModal = options => { confirm = () => options.success({ confirm: true }); }; const saving = page.onCheckin(); storage.activate('env', 'other'); seed(storage, [{ _id: 'c', name: '另一个账号的课' }]); confirm(); await saving; assert.equal(storage.read().queue.length, 0); assert.equal(page.data.noteDraft, ''); page.onUnload();
});
test('schedule time edits and stale draft token validate before enqueue while preserving draft', async () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '游泳', type: 'swim', scheduleVersions: [{ effectiveFrom: '2026-01-01', operationId: 'original', slots: [{ weekday: 6, start: '10:00', end: '11:00' }] }] }]); c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({ id: 'c' }); page.onTimeChange({ currentTarget: { dataset: { weekday: 6, field: 'end' } }, detail: { value: '09:00' } }); await page.onSave(); assert.equal(storage.read().queue.length, 0); assert.equal(page.data.scheduleSlots[0].end, '09:00'); assert.ok(c.calls.some(call => /结束时间/.test(call.toast || ''))); page.onTimeChange({ currentTarget: { dataset: { weekday: 6, field: 'end' } }, detail: { value: '12:00' } }); storage.update(state => { state.courses[0].scheduleVersions.push({ effectiveFrom: '2026-10-05', operationId: 'newer', slots: [] }); }); await page.loadCourse(); assert.equal(page.data.scheduleExpectedVersion, 'original'); await page.onSave(); assert.equal(storage.read().queue.length, 0); assert.equal(page.data.scheduleSlots[0].end, '12:00'); assert.ok(c.calls.some(call => /安排已更新/.test(call.toast || '')));
});
test('native templates bind compact reminders, shared outcome editor and unchanged three tabs', () => {
  const home = fs.readFileSync('miniprogram/pages/index/index.wxml', 'utf8'); assert.equal((home.match(/class="compact-reminder"/g) || []).length, 2); assert.ok(home.indexOf('onNextTap') < home.indexOf('<course-card')); assert.match(home, /consumed-count="\{\{item.consumedCount\}\}"/); assert.match(home, /today-status="\{\{item.todayStatus\}\}"/);
  const detail = fs.readFileSync('miniprogram/pages/course-detail/course-detail.wxml', 'utf8'); assert.match(detail, /records.length\}\} 条/); assert.match(detail, /attendance-editor[^>]*bind:close="onCloseAttendance"[^>]*bind:saved="onAttendanceSaved"/); assert.match(detail, /item.reason/); assert.match(detail, /item.time/);
  const editor = fs.readFileSync('miniprogram/components/attendance-editor/attendance-editor.wxml', 'utf8'); assert.match(editor, /bindchange="onDebitChange"/); assert.match(editor, /bindchange="onReasonChange"/); assert.match(editor, /notes.length > 60 \? -1 : 60/);
  const app = JSON.parse(fs.readFileSync('miniprogram/app.json', 'utf8')); assert.equal(app.tabBar.list.length, 3); assert.ok(app.pages.includes('pages/attendance/attendance'));
});
test('schedule display selects the current version, labels future adoption and stops without reviving old memo', () => {
  const { c } = setup(); const view = c.load('miniprogram/utils/attendance-view.js'); assert.equal(typeof view.scheduleLabel, 'function');
  const original = { effectiveFrom: '2026-10-04', slots: [{ weekday: 0, start: '10:00', end: '11:00' }] };
  const future = { effectiveFrom: '2026-10-11', slots: [{ weekday: 6, start: '12:00', end: '13:00' }] };
  assert.equal(view.scheduleLabel({ schedule: '手写备忘', scheduleVersions: [original, future] }, '2026-10-04'), '每周日 10:00—11:00');
  assert.equal(view.scheduleLabel({ scheduleVersions: [future] }, '2026-10-04'), '2026-10-11 开始 · 每周六 12:00—13:00');
  const stopped = { schedule: '旧备忘：周日10点', scheduleVersions: [original, { effectiveFrom: '2026-10-05', slots: [] }] };
  assert.equal(view.scheduleLabel(stopped, '2026-10-06'), '上课安排已停止');
  assert.equal(view.scheduleLabel({ ...stopped, isDeleted: true }, '2026-10-04'), '已归档 · 上课安排已停止');
  assert.equal(view.scheduleLabel({ schedule: '每周六上午' }, '2026-10-04'), ''); assert.equal(view.scheduleLabel({}, '2026-10-04'), '');
});
test('homepage structured schedule label reaches cards without changing stored handwritten memo', () => {
  const { c, storage } = setup(); const date = c.load('miniprogram/utils/records.js').today(); seed(storage, [{ _id: 'c', name: '排课验收', schedule: '保留旧备忘', scheduleVersions: [{ effectiveFrom: date, slots: [{ weekday: 0, start: '10:00', end: '11:00' }] }] }]); c.load('miniprogram/pages/index/index.js'); const page = instance(c.definition()); page.render(); assert.equal(page.data.courses[0].scheduleLabel, '每周日 10:00—11:00'); assert.equal(storage.read().courses[0].schedule, '保留旧备忘'); assert.match(fs.readFileSync('miniprogram/pages/index/index.wxml', 'utf8'), /schedule="\{\{item.scheduleLabel\}\}"/);
});
test('detail hero presents structured arrangement while legacy memo joins the single notes area', () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '排课验收', schedule: '教室在二楼', notes: '云宝班', scheduleVersions: [{ effectiveFrom: '2026-01-01', slots: [{ weekday: 0, start: '10:00', end: '11:00' }] }] }]); c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition()); page.setData({ courseId: 'c' }); page.render(); assert.equal(page.data.scheduleLabel, '每周日 10:00—11:00'); assert.equal(page.data.courseNotes, '云宝班\n教室在二楼'); assert.equal(storage.read().courses[0].schedule, '教室在二楼'); const template = fs.readFileSync('miniprogram/pages/course-detail/course-detail.wxml', 'utf8'); assert.match(template, /scheduleLabel \|\| '未设置固定上课时间'/); assert.doesNotMatch(template, /备忘：|course\.schedule\}\}/); assert.match(template, /courseNotes \|\| '课程备注可在编辑中添加'/);
});
test('course form removes the standalone handwritten memo field and handler', () => {
  const { c } = setup(); c.load('miniprogram/pages/course-edit/course-edit.js');
  const template = fs.readFileSync('miniprogram/pages/course-edit/course-edit.wxml', 'utf8');
  assert.doesNotMatch(template, /course-schedule|onScheduleInput|手写上课备忘/);
  assert.match(template, /id="course-notes"/);
  assert.equal(c.definition().onScheduleInput, undefined);
});
test('editing merges legacy memo into notes in the draft without writing data', async () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '英孚', type: 'english', schedule: '周二、周六', notes: '云宝班' }]);
  c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({ id: 'c' });
  assert.equal(page.data.course.notes, '云宝班\n周二、周六');
  assert.equal(page.data.course.schedule, '');
  assert.equal(storage.read().courses[0].notes, '云宝班');
  assert.equal(storage.read().courses[0].schedule, '周二、周六');
  assert.equal(storage.read().queue.length, 0);
  page.onUnload();
});
test('saving consolidated notes clears legacy field atomically and reopening does not duplicate it', async () => {
  const { c, storage, db } = setup(); seed(storage, [{ _id: 'c', name: '英孚', type: 'english', schedule: '周二、周六', notes: '云宝班' }]);
  c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({ id: 'c' }); await page.onSave();
  const updates = storage.read().queue[0].payload.updates;
  assert.equal(updates.notes, '云宝班\n周二、周六'); assert.equal(updates.schedule, ''); assert.equal(updates.scheduleChange, undefined);
  assert.equal(db.snapshot().courses[0].notes, updates.notes); assert.equal(db.snapshot().courses[0].schedule, '');
  const reopened = instance(c.definition()); await reopened.onLoad({ id: 'c' }); assert.equal(reopened.data.course.notes, updates.notes);
  page.onUnload(); reopened.onUnload();
});
test('intentionally clearing the unified notes never resurrects the old memo on reopening', async () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '英孚', type: 'english', schedule: '周二、周六', notes: '云宝班' }]);
  c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({ id: 'c' }); page.onNotesInput({ detail: { value: '' } }); await page.onSave();
  const reopened = instance(c.definition()); await reopened.onLoad({ id: 'c' }); assert.equal(reopened.data.course.notes, ''); assert.equal(reopened.data.course.schedule, '');
  page.onUnload(); reopened.onUnload();
});
test('legacy memo already present as a note line is shown only once', async () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '英孚', type: 'english', schedule: '周二、周六', notes: '云宝班\n周二、周六' }]);
  c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({ id: 'c' }); await page.onSave();
  assert.equal(storage.read().queue[0].payload.updates.notes, '云宝班\n周二、周六'); assert.equal(storage.read().queue[0].payload.updates.schedule, '');
  page.onUnload();
});
test('oversize combined legacy notes stay intact until the user explicitly shortens them', async () => {
  const { c, storage } = setup(); const original = '课'.repeat(500); const memo = '备'.repeat(100);
  seed(storage, [{ _id: 'c', name: '英孚', type: 'english', schedule: memo, notes: original }]);
  c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition()); await page.onLoad({ id: 'c' });
  assert.equal(page.data.course.notes, original + '\n' + memo); await page.onSave();
  assert.equal(storage.read().queue.length, 0); assert.equal(page.data.course.notes.length, 601); assert.equal(storage.read().courses[0].schedule, memo);
  assert.ok(c.calls.some(call => /精简/.test(call.toast || '')));
  assert.match(fs.readFileSync('miniprogram/pages/course-edit/course-edit.wxml', 'utf8'), /course.notes.length > 500 \? -1 : 500/);
  page.onNotesInput({ detail: { value: '用户整理后的备注' } }); await page.onSave();
  assert.equal(storage.read().queue[0].payload.updates.notes, '用户整理后的备注'); assert.equal(storage.read().queue[0].payload.updates.schedule, ''); page.onUnload();
});
test('archived legacy memo remains readable in the single detail notes area without mutating history', () => {
  const { c, storage } = setup(); seed(storage, [{ _id: 'c', name: '旧课', isDeleted: true, schedule: '以前每周六上午' }]);
  c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition()); page.setData({ courseId: 'c' }); page.render();
  assert.equal(page.data.courseNotes, '以前每周六上午'); assert.equal(page.data.scheduleLabel, ''); assert.equal(storage.read().queue.length, 0);
});

test('archive confirmation explains balances, statistics, reminders and recovery without changing data on cancel', async () => {
  const { c, storage } = setup();
  seed(storage, [{ _id: 'c', name: '游泳', totalLessons: 30, initialLessons: 10 }], [{ _id: 'r', courseId: 'c', date: '2026-01-03' }]);
  c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition());
  page.setData({ courseId: 'c', ready: true }); page.render();
  const before = JSON.stringify(storage.read());
  let modal; c.wx.showModal = options => { modal = options; options.success({ confirm: false }); };
  await page.onArchive();
  assert.equal(modal.title, '归档课程');
  assert.match(modal.content, /归档不是删除/);
  assert.match(modal.content, /首页隐藏/);
  assert.match(modal.content, /停止后续排课和待确认提醒/);
  assert.match(modal.content, /不再计入正在上的课程/);
  assert.match(modal.content, /总课时、已上和剩余课时不变/);
  assert.match(modal.content, /历史记录仍计入统计/);
  assert.match(modal.content, /“我的”恢复/);
  assert.match(modal.content, /恢复后需重新设置上课安排/);
  assert.doesNotMatch(modal.content, /还有 \d+ 节课待确认/);
  assert.equal(modal.confirmText, '确认归档'); assert.equal(modal.cancelText, '暂不归档');
  assert.equal(JSON.stringify(storage.read()), before); assert.equal(page.data.busy, false);
});

test('archive warning counts only this course across all months and reads current pending results', async () => {
  const { c, storage, db } = setup();
  const scheduleVersions = [
    { effectiveFrom: '2026-01-01', slots: [{ weekday: 6, start: '10:00', end: '11:00' }] },
    { effectiveFrom: '2026-01-18', slots: [] }
  ];
  seed(storage, [
    { _id: 'c', name: '游泳', scheduleVersions },
    { _id: 'other', name: '其他课程', scheduleVersions },
    { _id: 'archived', name: '已归档课程', isDeleted: true, deletedAt: '2026-01-18', scheduleVersions }
  ], [{ _id: 'r', courseId: 'c', date: '2026-01-10', status: 'attended', debit: 1 }]);
  c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition());
  page.setData({ courseId: 'c', ready: true, month: '2026-02', filter: 'attended' }); page.render();
  assert.equal(page.data.records.length, 0);
  let modal; c.wx.showModal = options => { modal = options; options.success({ confirm: false }); };
  await page.onArchive();
  assert.match(modal.content, /^还有 2 节课待确认，建议先处理；归档后将不再提醒。/);
  assert.equal(storage.read().queue.length, 0);
  await db.setAttendance('c', { date: '2026-01-03', status: 'absent' });
  await page.onArchive();
  assert.match(modal.content, /^还有 1 节课待确认，建议先处理；归档后将不再提醒。/);
  assert.equal(storage.read().queue.length, 1); assert.equal(storage.read().queue[0].type, 'set_attendance');
});

test('archive waits for explicit confirmation and repeated taps enqueue once while preserving lesson totals', async () => {
  const { c, storage, db } = setup();
  seed(storage, [{ _id: 'c', name: '游泳', totalLessons: 30, initialLessons: 10 }], [{ _id: 'r', courseId: 'c', date: '2026-01-03' }]);
  c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition());
  page.setData({ courseId: 'c', ready: true }); page.render();
  const before = db.snapshot();
  let confirm, modalCount = 0;
  c.wx.showModal = options => { modalCount++; confirm = () => options.success({ confirm: true }); };
  const saving = page.onArchive(); await page.onArchive();
  assert.equal(modalCount, 1); assert.equal(storage.read().queue.length, 0); assert.equal(page.data.busy, true);
  confirm(); await saving;
  const after = db.snapshot();
  assert.equal(storage.read().queue.length, 1); assert.equal(storage.read().queue[0].type, 'archive_course');
  assert.equal(after.courses.length, 1); assert.equal(after.courses[0]._id, 'c'); assert.equal(after.courses[0].isDeleted, true);
  for (const field of ['totalLessons', 'completedCount', 'remainingCount']) assert.equal(after.courses[0][field], before.courses[0][field]);
  assert.equal(after.totalLessons, before.totalLessons); assert.equal(after.checkins.length, before.checkins.length);
  assert.equal(page.data.busy, false);
});

test('archive prompt changes leave the existing restore explanation and action intact', async () => {
  const { c, storage, db } = setup();
  seed(storage, [{ _id: 'c', name: '旧课', isDeleted: true, totalLessons: 30, initialLessons: 12, scheduleVersions: [{ effectiveFrom: '2026-01-01', slots: [] }] }]);
  c.load('miniprogram/pages/course-detail/course-detail.js'); const page = instance(c.definition());
  page.setData({ courseId: 'c', ready: true }); page.render();
  let modal; c.wx.showModal = options => { modal = options; options.success({ confirm: true }); };
  await page.onArchive();
  assert.equal(modal.title, '恢复课程'); assert.match(modal.content, /原安排不会自动恢复/);
  assert.doesNotMatch(modal.content, /归档不是删除|还有 \d+ 节课待确认/);
  assert.equal(storage.read().queue.length, 1); assert.equal(storage.read().queue[0].type, 'restore_course');
  assert.equal(db.snapshot().courses[0].isDeleted, false); assert.equal(db.snapshot().courses[0].completedCount, 12);
});
