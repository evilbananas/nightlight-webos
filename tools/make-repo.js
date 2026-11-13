'use strict';
// Builds the Homebrew Channel repository manifest (repo.json) for a released .ipk.
// Usage: node tools/make-repo.js <ipk> <tag> <out-file>
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function buildRepo({ appInfo, description, ghRepo, tag, ipkName, ipkData, iconUri }) {
  const ipkUrl = `https://github.com/${ghRepo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(ipkName)}`;
  const pkg = {
    id: appInfo.id,
    title: appInfo.title,
    description,
    shortDescription: description,
    iconUri,
    manifest: {
      id: appInfo.id,
      version: appInfo.version,
      type: appInfo.type,
      title: appInfo.title,
      appDescription: description,
      iconUri,
      sourceUrl: `https://github.com/${ghRepo}`,
      rootRequired: true,
      ipkUrl,
      ipkHash: { sha256: crypto.createHash('sha256').update(ipkData).digest('hex') },
    },
  };
  return { paging: { page: 1, count: 1, maxPage: 1, itemsTotal: 1 }, packages: [pkg] };
}

if (require.main === module) {
  const [ipkPath, tag, outFile] = process.argv.slice(2);
  if (!ipkPath || !tag || !outFile) {
    console.error('Usage: node tools/make-repo.js <ipk> <tag> <out-file>');
    process.exit(1);
  }
  const ghRepo = process.env.GITHUB_REPOSITORY || 'evilbananas/nightlight-webos';
  const repo = buildRepo({
    appInfo: require(path.join(root, 'app/appinfo.json')),
    description: require(path.join(root, 'package.json')).description,
    ghRepo,
    tag,
    ipkName: path.basename(ipkPath),
    ipkData: fs.readFileSync(ipkPath),
    iconUri: `https://raw.githubusercontent.com/${ghRepo}/gh-pages/icon.png`,
  });
  fs.writeFileSync(outFile, JSON.stringify(repo, null, 2) + '\n');
  console.log(`${outFile}: ${repo.packages[0].manifest.ipkUrl}`);
}

module.exports = { buildRepo };
