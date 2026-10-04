const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { client } = require('./helpers/client');
const { CONFIG } = require('../miniprogram/utils/config');

function instance(definition, props = {}) {
  const value = { ...definition, ...(definition.methods || {}), data: JSON.parse(JSON.stringify(definition.data || {})), properties: props };
  value.setData = changes => {
    for (const [key, data] of Object.entries(changes)) {
      const parts = key.split('.'); let target = value.data;
      while (parts.length > 1) target = target[parts.shift()];
      target[parts[0]] = data;
    }
  };
  return value;
}

test('course card handles real native event without stopPropagation', () => {
  const c = client(); c.load('miniprogram/components/course-card/course-card.js');
  const card = instance(c.definition(), { courseId: 'a', isCheckedIn: false });
  let event;
  card.triggerEvent = (name, data) => { event = { name, id: data.courseId }; };
  card.onCheckinTap({ type: 'tap', currentTarget: {}, detail: {} });
  assert.deepEqual(event, { name: 'checkin', id: 'a' });
});
test('variant B homepage preserves real data and a guarded record action', () => {
  const home = fs.readFileSync('miniprogram/pages/index/index.wxml', 'utf8');
  const card = fs.readFileSync('miniprogram/components/course-card/course-card.wxml', 'utf8');
  const homeStyles = fs.readFileSync('miniprogram/pages/index/index.wxss', 'utf8');
  assert.match(home, /class="hero"/);
  assert.match(home, /\{\{todayLessons\}\}/);
  assert.doesNotMatch(home, /连续打卡\s*12|成就/);
  assert.match(homeStyles, /linear-gradient\(135deg, #2563EB 0%, #7C3AED 100%\)/);
  assert.match(card, /style="background: \{\{courseGradient\}\};"/);
  assert.equal(CONFIG.COURSE_TYPES.SWIM.gradient, 'linear-gradient(135deg, #2563EB 0%, #06B6D4 100%)');
  assert.equal(CONFIG.COURSE_TYPES.PIANO.gradient, 'linear-gradient(135deg, #F59E0B 0%, #EF4444 100%)');
  assert.match(card, /catchtap="onCheckinTap"/);
  assert.match(card, /disabled="\{\{isCheckedIn \|\| busy \|\| disabled\}\}"/);
  for (const field of ['completedCount', 'totalCount', 'remaining', 'overdrawn', 'syncStatus']) assert.ok(card.includes(field));
  const app = JSON.parse(fs.readFileSync('miniprogram/app.json', 'utf8'));
  assert.equal(app.tabBar.list.length, 3);
  assert.equal(app.tabBar.selectedColor, '#2563EB');
});
test('course cards use the configured palette for every type and fall back for legacy types', () => {
  const c = client(); c.load('miniprogram/components/course-card/course-card.js');
  const types = [...Object.values(CONFIG.COURSE_TYPES), { type: 'legacy', gradient: CONFIG.COURSE_TYPES.OTHER.gradient }, { gradient: CONFIG.COURSE_TYPES.OTHER.gradient }];
  for (const { type, gradient } of types) {
    const card = instance(c.definition(), { type, completedCount: 0, totalCount: 10 });
    card.lifetimes.attached.call(card);
    assert.equal(card.data.courseGradient, gradient, String(type));
  }
});
test('course card colors follow a changed course type without recreating the card', () => {
  const c = client(); c.load('miniprogram/components/course-card/course-card.js');
  const card = instance(c.definition(), { type: 'swim', completedCount: 0, totalCount: 10 });
  card.lifetimes.attached.call(card);
  assert.equal(typeof card.observers.type, 'function');
  for (const type of ['english', 'piano', 'swim']) {
    card.properties.type = type;
    card.observers.type.call(card);
    assert.equal(card.data.courseGradient, CONFIG.COURSE_TYPES[type.toUpperCase()].gradient);
  }
});
test('course detail uses the same palette after refresh including legacy and archived courses', () => {
  const c = client(); const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('env', 'a');
  c.load('miniprogram/pages/course-detail/course-detail.js');
  const page = instance(c.definition());
  page.setData({ courseId: 'c', selectedDate: '2026-10-03' });
  const types = [...Object.values(CONFIG.COURSE_TYPES), { type: 'legacy', gradient: CONFIG.COURSE_TYPES.OTHER.gradient }, { gradient: CONFIG.COURSE_TYPES.OTHER.gradient }];
  for (const { type, gradient } of types) {
    for (const isDeleted of [false, true]) {
      storage.update(state => { state.courses = [{ _id: 'c', name: '测试课程', type, isDeleted }]; });
      page.render();
      assert.equal(page.data.courseGradient, gradient, String(type));
    }
  }
  storage.update(state => { state.courses = []; });
  page.render();
  assert.equal(page.data.course, null);
});
test('course detail binds its palette without changing the green completed state', () => {
  const template = fs.readFileSync('miniprogram/pages/course-detail/course-detail.wxml', 'utf8');
  assert.match(template, /class="detail-hero[^"\n]*" style="background: \{\{courseGradient\}\};"/);
  for (const path of ['miniprogram/components/course-card/course-card.wxss', 'miniprogram/pages/course-detail/course-detail.wxss']) {
    const styles = fs.readFileSync(path, 'utf8');
    assert.match(styles, /\.completed[^{}]*\{[^}]*background:\s*#10B981;/);
  }
});
test('restyled course card never records while completed, busy or disabled', () => {
  const c = client(); c.load('miniprogram/components/course-card/course-card.js');
  for (const guard of ['isCheckedIn', 'busy', 'disabled']) {
    const card = instance(c.definition(), { courseId: 'a', [guard]: true });
    card.triggerEvent = () => assert.fail(`record event escaped ${guard} guard`);
    card.onCheckinTap();
  }
});
test('restyled course card supports unset totals, exhausted balance and excess lessons', () => {
  const c = client(); c.load('miniprogram/components/course-card/course-card.js');
  for (const [completedCount, totalCount, progressPercent, remaining, overdrawn] of [[8, 0, 0, 0, 0], [8, 24, 33, 16, 0], [30, 30, 100, 0, 0], [32, 30, 100, 0, 2]]) {
    const card = instance(c.definition(), { completedCount, totalCount });
    card.calculateProgress();
    assert.deepEqual({ progressPercent: card.data.progressPercent, remaining: card.data.remaining, overdrawn: card.data.overdrawn }, { progressPercent, remaining, overdrawn });
  }
});
test('sync component does not toast success on a failed result', async () => {
  const c = client(); const { SyncQueue } = c.load('miniprogram/utils/sync-queue.js');
  SyncQueue.sync = async () => ({ success: false, failed: 1, message: '网络断开' });
  c.load('miniprogram/components/sync-status/sync-status.js');
  const item = instance(c.definition()); item.data.status = 'failed';
  await item.onTap();
  assert.equal(c.calls.some(x => x.toast === '同步完成'), false);
});
test('save guard prevents a double-tap creating two courses', async () => {
  const c = client({ app: { ensureReady: async () => true } });
  c.wx.showLoading = () => {}; c.wx.hideLoading = () => {};
  c.load('miniprogram/utils/storage.js').activate('env', 'a');
  c.load('miniprogram/pages/course-edit/course-edit.js');
  const page = instance(c.definition());
  await page.onLoad({});
  page.setData({ ready: true, canSave: true, 'course.name': '数学', selectedType: 'other' });
  await Promise.all([page.onSave(), page.onSave()]);
  assert.equal((await c.load('miniprogram/utils/db.js').db.getCourses()).length, 1);
});
test('course drafts cannot be saved by a different account after identity expiration or direct switching', async () => {
  for (const expireFirst of [true, false]) {
    const c = client({ app: { ensureReady: async () => true } });
    const storage = c.load('miniprogram/utils/storage.js');
    storage.activate('env', 'owner-a');
    const oldKey = storage.getSession().key;
    c.load('miniprogram/pages/course-edit/course-edit.js');
    const page = instance(c.definition());
    await page.onLoad({});
    page.onNameInput({ detail: { value: 'A 私人课程草稿' } });
    if (expireFirst) storage.deactivate();
    storage.activate('env', 'owner-b');
    await page.onSave();
    assert.equal(storage.read().queue.length, 0, 'old draft must never enter the new account queue');
    assert.equal(storage.read(oldKey).queue.length, 0);
    assert.equal(page.data.ready, false);
    await page.loadCourse();
    assert.equal(page.data.ready, false, 'reconnecting another account cannot rebind the old draft');
    assert.match(page.data.error, /账号|账户|身份/);
    assert.equal(c.calls.some(item => item.toast === '已保存，等待同步'), false);
    page.onUnload();
  }
});
test('reconnecting the original account preserves both new and edited course drafts', async () => {
  for (const editing of [false, true]) {
    const c = client({ app: { ensureReady: async () => true } });
    const storage = c.load('miniprogram/utils/storage.js');
    storage.activate('env', 'owner-a');
    storage.update(state => { state.courses = [{ _id: 'c', name: '原课程', type: 'swim' }]; });
    c.load('miniprogram/pages/course-edit/course-edit.js');
    const page = instance(c.definition());
    await page.onLoad(editing ? { id: 'c' } : {});
    page.onNameInput({ detail: { value: '未保存的课程名' } });
    page.onNotesInput({ detail: { value: '未保存的备忘' } });
    storage.deactivate();
    assert.equal(page.data.ready, false);
    await page.onSave();
    storage.activate('env', 'owner-a');
    await page.loadCourse();
    assert.equal(page.data.ready, true);
    assert.equal(page.data.course.name, '未保存的课程名');
    assert.equal(page.data.course.notes, '未保存的备忘');
    await page.onSave();
    assert.equal(storage.read().queue.length, 1);
    assert.equal(storage.read().queue[0].type, editing ? 'update_course' : 'add_course');
    page.onUnload();
  }
});
test('a delayed course read cannot enable an old account form after identity changes', async () => {
  const c = client({ app: { ensureReady: async () => true } });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('env', 'owner-a');
  storage.update(state => { state.courses = [{ _id: 'c', name: 'A 的课程', type: 'swim' }]; });
  const db = c.load('miniprogram/utils/db.js').db;
  const originalRead = db.getCourse.bind(db);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  db.getCourse = async id => {
    const course = await originalRead(id);
    entered();
    await new Promise(resolve => { release = resolve; });
    return course;
  };
  c.load('miniprogram/pages/course-edit/course-edit.js');
  const page = instance(c.definition());
  const loading = page.onLoad({ id: 'c' });
  await started;
  storage.activate('env', 'owner-b');
  release();
  await loading;
  assert.equal(page.data.ready, false);
  assert.equal(page.data.course.name, '');
  assert.match(page.data.error, /账号|账户|身份/);
  page.onUnload();
});
test('closing a course form stops late initialization and unsubscribes identity updates', async () => {
  let finish;
  const c = client({ app: { ensureReady: () => new Promise(resolve => { finish = resolve; }) } });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('env', 'owner-a');
  c.load('miniprogram/pages/course-edit/course-edit.js');
  const page = instance(c.definition());
  const loading = page.onLoad({});
  if (page.onUnload) page.onUnload();
  let updates = 0;
  page.setData = () => { updates++; };
  finish();
  await loading;
  storage.deactivate();
  assert.equal(updates, 0);
});
test('history supports date selection, undo and month filtering', () => {
  const c = client(); c.load('miniprogram/pages/course-detail/course-detail.js');
  const page = c.definition();
  for (const name of ['onDateChange', 'onCancelCheckin', 'onMonthChange', 'onArchive']) assert.equal(typeof page[name], 'function', name);
});
test('profile only exposes implemented controls and a working export', () => {
  const template = fs.readFileSync('miniprogram/pages/profile/profile.wxml', 'utf8');
  for (const placeholder of ['onFamilyShare', 'onReminder', 'onToggleAdvanced', 'userOpenId']) assert.equal(template.includes(placeholder), false);
  assert.match(template, /onDataExport/);
  assert.match(template, /onRestore/);
});
test('export includes archived courses and pending data, neutralizes spreadsheet formulas', () => {
  const { buildExport } = require('../miniprogram/utils/export');
  const data = buildExport({ courses: [{ _id: 'a', name: '=CMD()', isDeleted: true, completedCount: 3 }], checkins: [{ courseId: 'a', date: '2026-01-01', notes: '+formula' }], hasSnapshot: true }, [{ type: 'checkin', status: 'pending' }]);
  assert.match(data.csv, /'=CMD\(\)/);
  assert.match(data.csv, /'\+formula/);
  const backup = JSON.parse(data.json);
  assert.equal(backup.courses[0].isDeleted, true);
  assert.equal(backup.pendingOperations.length, 1);
});
test('full backup preserves raw legacy duplicates and records hidden by pending cancellation', () => {
  const { buildExport } = require('../miniprogram/utils/export');
  const state = { courses: [{ _id: 'a' }], checkins: [{ _id: 'old1', courseId: 'a', date: '2026-01-01', notes: 'keep1' }, { _id: 'old2', courseId: 'a', date: '2026-01-01', notes: 'keep2' }], queue: [{ type: 'cancel_checkin' }], aliases: {}, hasSnapshot: true };
  const backup = JSON.parse(buildExport({ courses: state.courses, checkins: [] }, state.queue, state).json);
  assert.equal(backup.sourceSnapshot.checkins.length, 2);
  assert.equal(backup.sourceSnapshot.checkins[1].notes, 'keep2');
});
test('identity expiration updates visible pages instead of displaying an empty ready ledger', () => {
  const c = client(); const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('env', 'owner-a');
  c.load('miniprogram/pages/index/index.js');
  const page = instance(c.definition()); page.onLoad();
  page.setData({ ready: true, error: '', isLoading: false });
  storage.deactivate();
  assert.equal(page.data.ready, false);
  assert.match(page.data.error, /登录|身份/);
  page.onUnload();
});
test('detail month filtering tolerates malformed legacy dates without crashing', () => {
  const c = client(); const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('env', 'a');
  storage.update(state => { state.courses = [{ _id: 'c' }]; state.checkins = [{ _id: 'bad', courseId: 'c', date: null }, { _id: 'ok', courseId: 'c', date: '2026-01-01' }]; });
  c.load('miniprogram/pages/course-detail/course-detail.js');
  const page = instance(c.definition()); page.setData({ courseId: 'c' });
  page.onMonthChange({ detail: { value: '2026-01' } });
  assert.equal(page.data.records.length, 1);
});
test('profile refresh failure with an empty queue never claims cloud sync completed', async () => {
  const c = client({ app: { ensureReady: async () => true } });
  c.load('miniprogram/utils/storage.js').activate('env', 'a');
  c.load('miniprogram/pages/profile/profile.js');
  const page = instance(c.definition()); page.setData({ ready: true });
  await page.onSyncTap();
  assert.equal(c.calls.some(item => item.toast === '同步完成'), false);
  assert.match(page.data.error, /network/);
});
test('native confirmation failure releases the busy state and reports an error', async () => {
  const c = client();
  c.wx.showModal = options => { if (options.fail) options.fail({ errMsg: 'showModal:fail' }); };
  c.load('miniprogram/pages/course-detail/course-detail.js');
  const page = instance(c.definition()); page.setData({ ready: true, selectedDate: '2026-01-01' });
  let finished = false;
  page.onCheckin().then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finished, true);
  assert.equal(page.data.busy, false);
  assert.equal(c.calls.some(item => item.icon === 'none'), true);
});
test('a delayed login never updates a page after it has unloaded', async () => {
  let finish;
  const c = client({ app: { ensureReady: () => new Promise(resolve => { finish = resolve; }) } });
  c.load('miniprogram/pages/index/index.js');
  const page = instance(c.definition()); page.onLoad();
  const loading = page.onShow();
  page.onUnload();
  let updates = 0;
  page.setData = () => { updates++; };
  finish(); await loading;
  assert.equal(updates, 0);
});
module.exports = { instance };

function detailFixture({ records = [], courses, id = 'c' } = {}) {
  const c = client({ app: { ensureReady: async () => true } });
  const storage = c.load('miniprogram/utils/storage.js');
  storage.activate('env', 'ui-owner');
  storage.update(state => {
    state.hasSnapshot = true;
    state.courses = courses || [{ _id: 'c', name: '游泳课', type: 'swim', totalLessons: 20, initialLessons: 4 }];
    state.checkins = records;
  });
  const db = c.load('miniprogram/utils/db.js').db;
  c.load('miniprogram/pages/course-detail/course-detail.js');
  const page = instance(c.definition());
  page.onLoad({ id }); page.setData({ ready: true, isLoading: false }); page.render();
  return { c, page, db, storage, today: c.load('miniprogram/utils/records.js').today() };
}
const input = value => ({ detail: { value } });
const recordEvent = date => ({ currentTarget: { dataset: { date } } });

test('selected past record is detected outside the history month and cannot add another lesson', async () => {
  const { page, db } = detailFixture({ records: [{ _id: 'r', courseId: 'c', date: '2026-01-02', notes: '先前备注' }] });
  page.onMonthChange(input('2026-02')); page.onDateChange(input('2026-01-02'));
  assert.equal(page.data.records.length, 0);
  assert.equal(page.data.hasSelectedRecord, true);
  assert.equal(page.data.noteDraft, '先前备注');
  await page.onCheckin();
  assert.equal(db.snapshot().courses[0].completedCount, 5);
});
test('new and backfilled lesson notes save with their exact record', async () => {
  const { page, db, today } = detailFixture();
  assert.equal(typeof page.onNotesInput, 'function');
  page.onNotesInput(input('  第一次  独立游完  ')); await page.onCheckin();
  page.onDateChange(input('2026-01-03')); page.onNotesInput(input('过去的一节')); await page.onCheckin();
  assert.equal(db.snapshot().checkins.find(x => x.date === today).notes, '第一次 独立游完');
  assert.equal(db.snapshot().checkins.find(x => x.date === '2026-01-03').notes, '过去的一节');
  assert.equal(db.snapshot().courses[0].completedCount, 6);
});
test('inline existing note save changes no counts and can clear the note', async () => {
  const { page, db } = detailFixture({ records: [{ _id: 'r', courseId: 'c', date: '2026-01-02', notes: '旧备注' }] });
  assert.equal(typeof page.onSaveNotes, 'function');
  page.onDateChange(input('2026-01-02')); page.onNotesInput(input('换气更稳了')); await page.onSaveNotes();
  assert.equal(db.snapshot().checkins[0].notes, '换气更稳了');
  assert.equal(db.snapshot().courses[0].completedCount, 5);
  page.onNotesInput(input('   ')); await page.onSaveNotes();
  assert.equal(db.snapshot().checkins[0].notes, '');
});
test('note modal cancellation is non-mutating and blank save clears only notes', async () => {
  const { page, db, storage } = detailFixture({ records: [{ _id: 'r', courseId: 'c', date: '2026-01-02', notes: '原来的备注' }] });
  assert.equal(typeof page.onOpenRecordNote, 'function');
  page.onOpenRecordNote(recordEvent('2026-01-02')); page.onModalNotesInput(input('未保存')); page.onCloseNoteModal();
  assert.equal(storage.read().queue.length, 0); assert.equal(page.data.noteModalOpen, false);
  page.onOpenRecordNote(recordEvent('2026-01-02')); assert.equal(page.data.modalNotes, '原来的备注');
  page.onModalNotesInput(input('')); await page.onSaveModalNotes();
  assert.equal(db.snapshot().checkins[0].notes, '');
  assert.equal(db.snapshot().courses[0].completedCount, 5);
});
test('legacy long notes are shown intact but cannot save until shortened', async () => {
  const long = '课'.repeat(70);
  const { page, c, storage } = detailFixture({ records: [{ _id: 'r', courseId: 'c', date: '2026-01-02', notes: long }] });
  assert.equal(typeof page.onOpenRecordNote, 'function');
  page.onDateChange(input('2026-01-02')); assert.equal(page.data.noteDraft, long);
  page.onOpenRecordNote(recordEvent('2026-01-02')); assert.equal(page.data.modalNotes, long);
  await page.onSaveModalNotes();
  assert.equal(storage.read().queue.length, 0); assert.equal(page.data.busy, false);
  assert.ok(c.calls.some(x => x.toast && x.toast.includes('60')));
  page.onModalNotesInput(input('课'.repeat(60))); await page.onSaveModalNotes();
  assert.equal(storage.read().queue.length, 1);
});
test('note drafts stay isolated by date and course and survive data refresh and ID reconciliation', () => {
  const { page, storage } = detailFixture({ id: 'local_c', courses: [{ _id: 'local_c', name: '游泳' }, { _id: 'b', name: '钢琴' }] });
  assert.equal(typeof page.onNotesInput, 'function');
  page.onDateChange(input('2026-01-02')); page.onNotesInput(input('草稿甲')); page.onToggleNotes();
  page.onDateChange(input('2026-01-03')); assert.equal(page.data.noteDraft, ''); page.onNotesInput(input('草稿乙'));
  page.setData({ courseId: 'b' }); page.render(); assert.equal(page.data.noteDraft, '');
  page.setData({ courseId: 'local_c' }); page.onDateChange(input('2026-01-02')); assert.equal(page.data.noteDraft, '草稿甲');
  storage.update(state => { state.aliases.local_c = 'cloud_c'; state.courses[0]._id = 'cloud_c'; state.checkins = [{ _id: 'remote', courseId: 'cloud_c', date: '2026-01-02', notes: '云端旧值' }]; });
  assert.equal(page.data.courseId, 'cloud_c'); assert.equal(page.data.noteDraft, '草稿甲');
  page.onDateChange(input('2026-01-03')); assert.equal(page.data.noteDraft, '草稿乙');
});
test('undo removes the note draft so re-adding a lesson cannot resurrect old notes', async () => {
  const { page, db, c } = detailFixture({ records: [{ _id: 'r', courseId: 'c', date: '2026-01-02', notes: '旧备注' }] });
  assert.equal(typeof page.onNotesInput, 'function');
  let confirmation = ''; c.wx.showModal = options => { confirmation = options.content; options.success({ confirm: true }); };
  page.onDateChange(input('2026-01-02')); page.onNotesInput(input('未保存的新备注'));
  await page.onCancelCheckin(recordEvent('2026-01-02'));
  assert.match(confirmation, /记录.*备注|备注.*记录/); assert.equal(page.data.noteDraft, '');
  await page.onCheckin(); assert.equal(db.snapshot().checkins[0].notes, '');
});
test('backfill captures its course, date and note before awaiting confirmation and blocks edits while busy', async () => {
  const { page, db, c } = detailFixture();
  assert.equal(typeof page.onNotesInput, 'function');
  let confirm; c.wx.showModal = options => { confirm = () => options.success({ confirm: true }); };
  page.onDateChange(input('2026-01-02')); page.onNotesInput(input('确认前内容'));
  const saving = page.onCheckin();
  page.onDateChange(input('2026-01-03')); page.onNotesInput(input('等待时误输入'));
  assert.equal(page.data.selectedDate, '2026-01-02'); assert.equal(page.data.noteDraft, '确认前内容');
  confirm(); await saving;
  assert.equal(db.snapshot().checkins[0].date, '2026-01-02'); assert.equal(db.snapshot().checkins[0].notes, '确认前内容');
});
test('failed note persistence releases busy state and preserves the draft', async () => {
  const { page, c } = detailFixture({ records: [{ _id: 'r', courseId: 'c', date: '2026-01-02', notes: '原值' }] });
  assert.equal(typeof page.onSaveNotes, 'function');
  page.onDateChange(input('2026-01-02')); page.onNotesInput(input('要保留的草稿'));
  c.wx.setStorageSync = () => { throw new Error('storage quota full'); };
  await page.onSaveNotes();
  assert.equal(page.data.busy, false); assert.equal(page.data.noteDraft, '要保留的草稿');
  assert.ok(c.calls.some(x => x.toast === 'storage quota full'));
});
test('archived course blocks new lessons and ordinary editing but permits historical notes', async () => {
  const { page, c, db } = detailFixture({ courses: [{ _id: 'c', name: '游泳', isDeleted: true }], records: [{ _id: 'r', courseId: 'c', date: '2026-01-02', notes: '' }] });
  assert.equal(typeof page.onOpenRecordNote, 'function');
  page.onEdit(); await page.onCheckin(); assert.equal(c.calls.some(x => x.navigate), false);
  page.onOpenRecordNote(recordEvent('2026-01-02')); page.onModalNotesInput(input('归档后可补充')); await page.onSaveModalNotes();
  assert.equal(db.snapshot().checkins[0].notes, '归档后可补充'); assert.equal(db.snapshot().checkins.length, 1);
});
test('legacy invalid dates remain readable in the timeline without date parsing errors', () => {
  const { page } = detailFixture({ records: [{ _id: 'bad', courseId: 'c', date: null, notes: '旧版数据' }, { _id: 'impossible', courseId: 'c', date: '2026-02-31', notes: '' }] });
  assert.equal(page.data.visibleRecords.length, 2);
  assert.ok(page.data.visibleRecords.every(x => x.dateLabel && x.weekday && x.day));
});
test('all native page bars are blue with white titles and three tabs have local outline icons', () => {
  const app = JSON.parse(fs.readFileSync('miniprogram/app.json', 'utf8'));
  assert.equal(app.tabBar.custom, undefined); assert.equal(app.tabBar.list.length, 3);
  assert.deepEqual(app.tabBar.list.map(x => x.text), ['课程', '统计', '我的']);
  for (const tab of app.tabBar.list) for (const field of ['iconPath', 'selectedIconPath']) {
    assert.equal(typeof tab[field], 'string'); assert.ok(fs.existsSync(`miniprogram/${tab[field]}`));
    assert.ok(fs.statSync(`miniprogram/${tab[field]}`).size < 4096);
  }
  for (const path of app.pages) {
    const config = { ...app.window, ...JSON.parse(fs.readFileSync(`miniprogram/${path}.json`, 'utf8')) };
    assert.equal(config.navigationBarBackgroundColor, '#2563EB'); assert.equal(config.navigationBarTextStyle, 'white');
    assert.equal(config.backgroundColor, '#F0F4FF');
  }
});
test('approved B styles keep independent panels, bright completion and safe-area form action', () => {
  const base = fs.readFileSync('miniprogram/app.wxss', 'utf8');
  const detail = fs.readFileSync('miniprogram/pages/course-detail/course-detail.wxss', 'utf8');
  const form = fs.readFileSync('miniprogram/pages/course-edit/course-edit.wxss', 'utf8');
  const card = fs.readFileSync('miniprogram/components/course-card/course-card.wxss', 'utf8');
  assert.match(base, /#F0F4FF/); assert.match(base, /border-radius: 44rpx/);
  for (const css of [base, detail, form, card]) assert.doesNotMatch(css, /margin(?:-top)?:\s*-/);
  assert.match(detail, /\.record-button\.completed\[disabled\][\s\S]*?#10B981/);
  assert.match(detail, /\.timeline-record:last-child[\s\S]*?display:\s*none/);
  assert.match(card, /\.checkin-btn\.completed\[disabled\][\s\S]*?#10B981/);
  assert.match(form, /position: fixed/); assert.match(form, /safe-area-inset-bottom/);
});
test('note template binds all editors, separates undo button and preserves long legacy inputs', () => {
  const template = fs.readFileSync('miniprogram/pages/course-detail/course-detail.wxml', 'utf8');
  for (const handler of ['onToggleNotes', 'onNotesInput', 'onSaveNotes', 'onOpenRecordNote', 'onModalNotesInput', 'onCloseNoteModal', 'onSaveModalNotes']) assert.ok(template.includes(`="${handler}"`), handler);
  assert.match(template, /hasSelectedRecord/); assert.match(template, /maxlength="\{\{[^}]*> 60 \? -1 : 60\}\}"/);
  assert.match(template, /adjust-position="\{\{true\}\}"/); assert.match(template, /catchtouchmove="onModalTouchMove"/);
  assert.doesNotMatch(template, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
});
test('form has exactly three numbered sections and guarded native fields', () => {
  const template = fs.readFileSync('miniprogram/pages/course-edit/course-edit.wxml', 'utf8');
  for (const title of ['01 / 课程信息', '02 / 课时账本', '03 / 上课安排', '添加新课程']) assert.ok(template.includes(title));
  assert.equal((template.match(/class="panel form-section"/g) || []).length, 3);
  for (const size of [50, 6]) assert.ok(template.includes(`maxlength="${size}"`));
  assert.match(template, /id="course-notes"[^>]*maxlength="\{\{course\.notes\.length > 500 \? -1 : 500\}\}"/);
  assert.doesNotMatch(template, /id="course-schedule"/);
  assert.match(template, /class="number-grid"/); assert.match(template, /class="number-unit"/);
  const c = client(); c.load('miniprogram/pages/course-edit/course-edit.js'); const page = instance(c.definition());
  page.setData({ ready: true, saving: true, 'course.name': '保存中' }); page.onNameInput(input('误输入'));
  assert.equal(page.data.course.name, '保存中'); assert.equal(page.data.courseTypes.length, 8);
});
test('recent seven days remain independent of month and mark today with actual totals', () => {
  const { c, today } = detailFixture();
  c.load('miniprogram/pages/stats/stats.js'); const page = instance(c.definition()); page.render();
  assert.equal(page.data.summary.week.length, 7); assert.equal(page.data.summary.week[6].isToday, true);
  assert.equal(page.data.summary.week[6].label, '今天'); assert.equal(page.data.weekTotal, 0);
  const before = JSON.stringify(page.data.summary.week); page.onMonthChange(input('2026-01'));
  assert.equal(JSON.stringify(page.data.summary.week), before); assert.equal(page.data.summary.week[6].date, today);
  const styles = fs.readFileSync('miniprogram/pages/stats/stats.wxss', 'utf8'); assert.match(styles, /\.bar\.today[\s\S]*?#10B981/);
});
test('profile labels note updates and keeps retry inside the single status panel', async () => {
  const { c, db } = detailFixture({ records: [{ _id: 'r', courseId: 'c', date: '2026-01-02', notes: '' }] });
  await db.updateCheckinNotes('c', '2026-01-02', '备注'); c.load('miniprogram/pages/profile/profile.js');
  const page = instance(c.definition()); page.render();
  assert.equal(page.data.pending[0].label, '修改课后备注');
  const template = fs.readFileSync('miniprogram/pages/profile/profile.wxml', 'utf8');
  assert.doesNotMatch(template, /<sync-status/); assert.match(template, /class="sync-top"[\s\S]*?bindtap="onSyncTap"/);
  assert.match(template, /error \|\| offline/);
});
