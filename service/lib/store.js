'use strict';
var fs = require('fs');
var path = require('path');

// Outside the app directory so settings survive app updates.
var CONFIG_DIR = '/home/root/.config/nightlight-webos';

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

function pickFile(dir) {
  try {
    mkdirp(dir);
    fs.accessSync(dir, fs.W_OK);
    return path.join(dir, 'config.json');
  } catch (e) {
    return null;
  }
}

function Store(dir) {
  this.file = dir ? pickFile(dir) : null;
}

Store.CONFIG_DIR = CONFIG_DIR;

/** False when no config directory can be used, e.g. before the service has root. */
Store.prototype.available = function () {
  return this.file !== null;
};

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
