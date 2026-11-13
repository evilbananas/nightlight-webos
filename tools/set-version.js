'use strict';
// Sets the version in app/appinfo.json, package.json, package-lock.json and service/package.json.
// Usage: npm run set-version -- 0.2.0
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Usage: npm run set-version -- <major.minor.patch>');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const files = ['app/appinfo.json', 'package.json', 'package-lock.json', 'service/package.json'];

for (const file of files) {
  const full = path.join(root, file);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));
  json.version = version;
  if (file === 'package-lock.json' && json.packages && json.packages['']) json.packages[''].version = version;
  fs.writeFileSync(full, JSON.stringify(json, null, 2) + '\n');
  console.log(`${file}: ${version}`);
}
