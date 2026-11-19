'use strict';
var Service = require('webos-service');
var Controller = require('./lib/controller');
var Store = require('./lib/store');
var picture = require('./lib/picture');
var tzlocation = require('./lib/tzlocation');
var places = require('./lib/places');
var autostart = require('./lib/autostart');
var pkg = require('./package.json');

var SERVICE_ID = pkg.name;
var APP_ID = SERVICE_ID.replace(/\.service$/, '');
// Short enough for smooth fades; nothing is written while the values stay the same.
var TICK_MS = 10000;

var service = new Service(SERVICE_ID);

function log(msg) {
  console.log('[nightlight] ' + msg);
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

var luna = {
  call: function (uri, params, cb) {
    service.call(uri, params, function (msg) {
      var p = msg.payload || {};
      if (p.returnValue) return cb(null, p);
      cb(new Error(p.errorText || 'Call to ' + uri + ' failed'), p);
    });
  }
};

function notify(message) {
  luna.call('luna://com.webos.notification/createToast', { sourceId: APP_ID, message: message }, function (err) {
    if (err) log('Notification failed: ' + err.message);
  });
}

// Without root the service runs in a jail with its own empty /home/root, which would
// pass the store's checks but hide the real config.
var configDir = isRoot() ? Store.CONFIG_DIR : null;

var controller = new Controller({
  luna: luna,
  store: new Store(configDir),
  stateStore: new Store(configDir, 'state.json'),
  resolveTimezone: function (tz) { return tzlocation.resolve(tz); },
  nameLocation: function (lat, lon) { return places.nearest(lat, lon); },
  notify: notify,
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
service.activityManager.create('keepAlive');

var clockSub = service.subscribe('luna://com.palm.systemservice/time/getSystemTime', { subscribe: true });
clockSub.on('response', function (msg) {
  var p = msg.payload || {};
  if (p.returnValue !== false) controller.setClock(p.offset, p.timezone);
});

// Each input, dynamic range and picture mode has its own settings, so night values are
// re-applied when they change.
var pictureSub = service.subscribe('luna://com.webos.settingsservice/getSystemSettings', {
  category: 'picture', keys: ['pictureMode'], subscribe: true
});
pictureSub.on('response', function (msg) {
  controller.setPictureMode(picture.settingsKey(msg.payload));
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
  controller.setManual(enabled, function (err) {
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

// Ticks every TICK_MS, and right at the next scheduled change so it isn't up to a tick late.
function loop() {
  controller.tick();
  var next = controller.lastEval && controller.lastEval.next;
  var untilNext = next ? next.at - Date.now() + 50 : Infinity;
  setTimeout(loop, Math.max(Math.min(TICK_MS, untilNext), 50));
}
setTimeout(loop, TICK_MS);
