const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const failures = [];
let checked = 0;
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function checkTemplate(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const tags = source.match(/<\/?[\w-]+(?:"[^"]*"|'[^']*'|[^'">])*>/g) || [];
  const stack = [];
  for (const tag of tags) {
    const name = /^<\/?([\w-]+)/.exec(tag)[1];
    if (tag.startsWith('</')) {
      if (stack.pop() !== name) failures.push(`${file}: mismatched closing ${name}`);
    } else if (!tag.endsWith('/>')) stack.push(name);
  }
  if (stack.length) failures.push(`${file}: unclosed tags ${stack.join(', ')}`);
  const script = fs.readFileSync(file.replace(/\.wxml$/, '.js'), 'utf8');
  for (const match of source.matchAll(/(?:bind|catch):?[\w-]+="([\w]+)"/g)) {
    if (!new RegExp(`\\b${match[1]}\\s*\\(`).test(script)) failures.push(`${file}: missing handler ${match[1]}`);
  }
  if (/\b003e\b/.test(source)) failures.push(`${file}: malformed template delimiter`);
}
for (const directory of ['miniprogram', 'cloudfunctions', 'scripts', 'tests']) {
  for (const file of files(path.join(root, directory))) {
    if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) failures.push(result.stderr);
      checked++;
    } else if (file.endsWith('.json')) {
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { failures.push(`${file}: ${error.message}`); }
      checked++;
    } else if (file.endsWith('.wxml')) { checkTemplate(file); checked++; }
  }
}
const mini = path.join(root, 'miniprogram');
const app = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'));
for (const page of app.pages) {
  for (const extension of ['js', 'json', 'wxml', 'wxss']) if (!fs.existsSync(path.join(mini, `${page}.${extension}`))) failures.push(`Missing page file ${page}.${extension}`);
}
for (const file of files(mini).filter(file => file.endsWith('.json'))) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const component of Object.values(config.usingComponents || {})) {
    const base = component.startsWith('/') ? path.join(mini, component) : path.resolve(path.dirname(file), component);
    for (const extension of ['js', 'json', 'wxml', 'wxss']) if (!fs.existsSync(`${base}.${extension}`)) failures.push(`Missing component ${base}.${extension}`);
  }
}
if (app.tabBar.custom && !fs.existsSync(path.join(mini, 'custom-tab-bar/index.js'))) failures.push('Custom tabBar requires custom-tab-bar/index.js');
if (app.permission?.['scope.userLocation']) failures.push('Unused location permission must not be requested');
for (const name of ['login', 'course', 'checkin', 'stats']) {
  const manifest = require(path.join(root, 'cloudfunctions', name, 'package.json'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.dependencies['wx-server-sdk'])) failures.push(`${name}: SDK must be pinned to an exact version`);
}
const attendance = fs.readFileSync(path.join(mini, 'utils/attendance.js'), 'utf8');
for (const name of ['course', 'checkin', 'stats']) {
  const file = path.join(root, 'cloudfunctions', name, 'attendance.js');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== attendance) failures.push(`${name}: attendance rules drifted; run npm run sync:attendance`);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Static checks passed (${checked} source/config/template files). This is not a WeChat compiler or device test.`);
