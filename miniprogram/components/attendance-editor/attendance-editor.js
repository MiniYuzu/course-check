const { db } = require('../../utils/db');
const storage = require('../../utils/storage');
const { today, isDatedRecord } = require('../../utils/records');
const { normalizeAttendance } = require('../../utils/attendance');
Component({
  properties: { open: { type: Boolean, value: false }, row: { type: Object, value: null } },
  data: { status: 'attended', debit: 0, reason: '', notes: '', noteOpen: false, busy: false, error: '', courseName: '', date: '', reasons: ['', '请假', '身体不适', '临时有事', '其他'], reasonIndex: 0 },
  observers: { 'open,row': function () { if (this.properties.open) this.loadDraft(); } },
  lifetimes: {
    attached() {
      this._onSession = () => { if (this._draft && storage.getSession()?.key !== this._draft.accountKey) this.discardDraft(); };
      storage.onChange(this._onSession);
      if (this.properties.open) this.loadDraft();
    },
    detached() { this._detached = true; storage.offChange(this._onSession); }
  },
  methods: {
    loadDraft() {
      if (this.data.busy) return;
      const row = this.properties.row;
      if (!row || !this.properties.open) return;
      const accountKey = storage.getSession()?.key || '';
      // Do not rebase an open draft on refresh: its captured revision detects conflicts.
      if (this._draft && this._draft.accountKey === accountKey && this._draft.courseId === row.courseId && this._draft.date === row.date) return;
      this._draft = { accountKey, courseId: row.courseId, date: row.date, expectedRevision: row.attendanceRevision || 0 };
      const status = ['attended', 'absent', 'cancelled'].includes(row.status) ? row.status : 'attended';
      this.setData({ status, debit: row.status === 'absent' && row.debit === 1 ? 1 : 0, reason: row.reason || '', reasonIndex: Math.max(0, this.data.reasons.indexOf(row.reason || '')), notes: String(row.notes || ''), noteOpen: !!row.notes, error: '', courseName: row.courseName || '', date: row.date });
    },
    discardDraft() { this._draft = null; this.setData({ notes: '', reason: '', error: '', noteOpen: false }); this.triggerEvent('close'); },
    onClose() { if (!this.data.busy) this.discardDraft(); },
    onTouchMove() {},
    onStatusTap(event) { if (!this.data.busy && ['attended', 'absent', 'cancelled'].includes(event.currentTarget.dataset.status)) this.setData({ status: event.currentTarget.dataset.status }); },
    onDebitChange(event) { if (!this.data.busy) this.setData({ debit: event.detail.value ? 1 : 0 }); },
    onReasonChange(event) { if (!this.data.busy) this.setData({ reasonIndex: Number(event.detail.value), reason: this.data.reasons[Number(event.detail.value)] || '' }); },
    onToggleNotes() { if (!this.data.busy) this.setData({ noteOpen: !this.data.noteOpen }); },
    onNotesInput(event) { if (!this.data.busy) this.setData({ notes: event.detail.value }); },
    async onSave() {
      if (this.data.busy || !this._draft) return;
      const draft = { ...this._draft };
      const input = { date: draft.date, status: this.data.status, debit: this.data.debit, reason: this.data.reason, notes: this.data.notes, expectedRevision: draft.expectedRevision };
      this.setData({ busy: true, error: '' });
      try {
        if (!draft.accountKey || storage.requireSession().key !== draft.accountKey) throw new Error('账号已变化，请重新打开记录');
        if (!isDatedRecord({ date: draft.date }) || draft.date > today()) throw new Error('未来上课不能提前确认；日期待核对的旧记录请使用备注或撤销');
        const normalized = normalizeAttendance(input);
        await db.setAttendance(draft.courseId, { ...input, ...normalized });
        if (this._detached || storage.getSession()?.key !== draft.accountKey) return;
        this._draft = null;
        this.triggerEvent('saved', { courseId: draft.courseId, date: draft.date }); this.triggerEvent('close');
        wx.showToast({ title: '已保存，等待同步', icon: 'none' });
      } catch (error) { if (!this._detached && storage.getSession()?.key === draft.accountKey) this.setData({ error: error.message || '保存失败，请重试' }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    }
  }
});
