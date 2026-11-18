'use strict';
// Builds service/data/places.tsv.gz from GeoNames' cities500.txt (every place with 500+ people).
// Usage: node tools/make-places.js <cities500.txt>
// Get the input from https://download.geonames.org/export/dump/cities500.zip (CC BY 4.0).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node tools/make-places.js <cities500.txt>');
  process.exit(1);
}

// PPLX rows are districts of a bigger place (e.g. "Paris 01 Louvre"), so they're left out.
// 3 decimals is ~100 m, plenty for picking the nearest town.
const lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)
  .map((line) => line.split('\t'))
  .filter((c) => c[7] !== 'PPLX')
  .map((c) => [c[1], c[8], (+c[4]).toFixed(3), (+c[5]).toFixed(3), +c[14] || 0].join('\t'));

const out = path.join(__dirname, '..', 'service', 'data', 'places.tsv.gz');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zlib.gzipSync(lines.join('\n') + '\n', { level: 9 }));
console.log(`${out}: ${lines.length} places`);
