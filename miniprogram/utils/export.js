function cell(value) {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function buildExport(snapshot, queue = [], sourceSnapshot = null) {
  const courses = snapshot.courses || [];
  const checkins = snapshot.checkins || [];
  const rows = [['课程', '状态', '总课时', '初始已上', '累计已上', '累计扣课', '剩余课时', '超出课时', '同步状态']];
  courses.forEach(course => rows.push([course.name, course.isDeleted ? '已归档' : '使用中', course.totalLessons || '未设置', course.initialLessons || 0, course.completedCount, course.consumedCount === undefined ? course.completedCount : course.consumedCount, course.remainingCount, course.overdrawnCount || 0, course._syncStatus || '已同步']));
  rows.push([], ['课程', '上课日期', '结果', '缺席原因', '扣课时', '备注', '同步状态']);
  const labels = { attended: '出席', absent: '缺席', cancelled: '停课' };
  checkins.forEach(record => rows.push([(courses.find(course => course._id === record.courseId) || {}).name || '历史课程', record.date, labels[record.status] || '出席', record.reason || '', record.status === 'absent' ? Number(record.debit) === 1 ? 1 : 0 : record.status === 'cancelled' ? 0 : 1, record.notes || '', record._syncStatus || '已同步']));
  const backup = { version: 3, exportedAt: new Date().toISOString(), hasSnapshot: !!snapshot.hasSnapshot, lastRefresh: snapshot.lastRefresh || null, courses, checkins, rawCheckins: snapshot.rawCheckins || checkins, pendingOperations: queue, sourceSnapshot };
  return { csv: '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n'), json: JSON.stringify(backup, null, 2) };
}
async function shareExport(content, extension) {
  const filePath = `${wx.env.USER_DATA_PATH}/course-check-export.${extension}`;
  await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: content, encoding: 'utf8', success: resolve, fail: reject }));
  if (!wx.shareFileMessage) throw new Error('当前微信版本不支持文件分享，请升级微信后导出；数据仍保留在本机');
  await new Promise((resolve, reject) => wx.shareFileMessage({ filePath, fileName: `课时记录-${new Date().toISOString().slice(0, 10)}.${extension}`, success: resolve, fail: reject }));
}
module.exports = { buildExport, shareExport };
