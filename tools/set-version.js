'use strict';
// Sets the version in app/appinfo.json, package.json, package-lock.json and service/package.json.
// Usage: node tools/set-version.js 0.2.0
// Without a version, copies the version from package.json into app/appinfo.json and
// service/package.json. `npm version` runs it this way from the "version" script.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const arg = process.argv[2];
const version = arg || require(path.join(root, 'package.json')).version;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Usage: node tools/set-version.js [major.minor.patch]');
  process.exit(1);
}

const files = arg
  ? ['app/appinfo.json', 'package.json', 'package-lock.json', 'service/package.json']
  : ['app/appinfo.json', 'service/package.json'];

for (const file of files) {
  const full = path.join(root, file);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));
  json.version = version;
  if (file === 'package-lock.json' && json.packages && json.packages['']) json.packages[''].version = version;
  fs.writeFileSync(full, JSON.stringify(json, null, 2) + '\n');
  console.log(`${file}: ${version}`);
}
