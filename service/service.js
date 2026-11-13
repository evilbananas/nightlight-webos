'use strict';
var childProcess = require('child_process');
var Service = require('webos-service');
var Controller = require('./lib/controller');
var Store = require('./lib/store');
var tzlocation = require('./lib/tzlocation');
var autostart = require('./lib/autostart');
var pkg = require('./package.json');

var SERVICE_ID = pkg.name;
var TICK_MS = 30000;

var service = new Service(SERVICE_ID);

function log(msg) {
  console.log('[nightlight] ' + msg);
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function lunaSend(uri, params, cb) {
  childProcess.execFile('luna-send', ['-n', '1', uri, JSON.stringify(params)], { timeout: 10000 }, function (err, stdout) {
    if (err) return cb(err);
    var payload;
    try {
      payload = JSON.parse(String(stdout).trim());
    } catch (e) {
      return cb(new Error('Unexpected luna-send output: ' + stdout));
    }
    if (payload.returnValue === false) return cb(new Error(payload.errorText || 'luna-send failed'), payload);
    cb(null, payload);
  });
}

// Calls the bus as this service; when that is denied and we are root, retries
// through luna-send, which runs with full privileges on rooted TVs.
var luna = {
  call: function (uri, params, cb) {
    service.call(uri, params, function (msg) {
      var p = msg.payload || {};
      if (p.returnValue) return cb(null, p);
      var err = new Error(p.errorText || 'Call to ' + uri + ' failed');
      if (!isRoot()) return cb(err, p);
      lunaSend(uri, params, function (err2, p2) {
        if (err2) return cb(new Error(err.message + '; luna-send: ' + err2.message), p2);
        cb(null, p2);
      });
    });
  }
};

var controller = new Controller({
  luna: luna,
  store: new Store(),
  resolveTimezone: function (tz) { return tzlocation.resolve(tz); },
  log: log
});

function syncAutostart() {
  if (!isRoot()) return null;
  try {
    if (controller.config.autostart) autostart.install(SERVICE_ID);
    else autostart.uninstall(SERVICE_ID);
    return null;
  } catch (e) {
    log('Autostart: ' + e.message);
    return e.message;
  }
}

function fullStatus() {
  var s = controller.status();
  s.returnValue = true;
  s.version = pkg.version;
  s.elevated = isRoot();
  s.autostartInstalled = autostart.isInstalled(SERVICE_ID);
  return s;
}

function fail(message, text) {
  message.respond({ returnValue: false, errorText: text });
}

// Keep the service process alive; webOS otherwise stops idle JS services.
var keepAlive = null;
service.activityManager.create('keepAlive', function (activity) {
  keepAlive = activity;
});

var clockSub = service.subscribe('luna://com.palm.systemservice/time/getSystemTime', { subscribe: true });
clockSub.on('response', function (msg) {
  var p = msg.payload || {};
  if (p.returnValue !== false) controller.setClock(p.offset, p.timezone);
});

service.register('start', function (message) {
  message.respond({ returnValue: true, running: true, elevated: isRoot() });
});

service.register('getStatus', function (message) {
  controller.refreshTvState(function () {
    message.respond(fullStatus());
  });
});

service.register('setConfig', function (message) {
  var patch = (message.payload && message.payload.config) || {};
  var err = controller.updateConfig(patch);
  if (err) return fail(message, err);
  var autostartErr = syncAutostart();
  var s = fullStatus();
  if (autostartErr) s.warning = autostartErr;
  message.respond(s);
});

service.register('setEyeComfort', function (message) {
  var enabled = !!(message.payload && message.payload.enabled);
  controller.apply(enabled, 'manual', function (err) {
    if (err) return fail(message, err.message);
    message.respond(fullStatus());
  });
});

// Exits so the next call relaunches the service, e.g. with root after elevation.
service.register('restart', function (message) {
  message.respond({ returnValue: true });
  setTimeout(function () { process.exit(0); }, 250);
});

log('Starting v' + pkg.version + (isRoot() ? ' (root)' : ' (not elevated)'));
syncAutostart();
controller.start();
setInterval(function () { controller.tick(); }, TICK_MS);
