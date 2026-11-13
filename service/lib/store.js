'use strict';
var fs = require('fs');
var path = require('path');

// Prefer a location outside the app directory so settings survive app updates.
var CANDIDATE_DIRS = ['/home/root/.config/nightlight-os', path.join(__dirname, '..', 'data')];

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

function pickFile(dirs) {
  for (var i = 0; i < dirs.length; i++) {
    try {
      mkdirp(dirs[i]);
      fs.accessSync(dirs[i], fs.W_OK);
      return path.join(dirs[i], 'config.json');
    } catch (e) {
      // try next candidate
    }
  }
  return null;
}

function Store(dirs) {
  this.file = pickFile(dirs || CANDIDATE_DIRS);
}

Store.prototype.load = function () {
  if (!this.file) return null;
  try {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  } catch (e) {
    return null;
  }
};

Store.prototype.save = function (data) {
  if (!this.file) return;
  var tmp = this.file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, this.file);
};

module.exports = Store;
