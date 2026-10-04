const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'miniprogram/utils/attendance.js'));
for (const name of ['course', 'checkin', 'stats']) fs.writeFileSync(path.join(root, 'cloudfunctions', name, 'attendance.js'), source);
console.log('Attendance rules copied to standalone cloud functions.');
