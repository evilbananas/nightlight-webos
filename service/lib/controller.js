'use strict';
var schedule = require('./schedule');

var SET_URI = 'luna://com.webos.settingsservice/setSystemSettings';
var GET_URI = 'luna://com.webos.settingsservice/getSystemSettings';
var SETTING_KEY = 'eyeComfortMode';

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function assign(target) {
  for (var i = 1; i < arguments.length; i++) {
    var src = arguments[i];
    if (!src) continue;
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
  }
  return target;
}

/** Copies only keys that exist in the default config, so stale or unknown keys aren't kept. */
function pickKnown(src) {
  var out = {};
  if (!src) return out;
  for (var k in schedule.DEFAULT_CONFIG) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

/**
 * Scheduler state machine. Platform specifics are injected:
 *  - luna.call(uri, params, cb(err, payload))
 *  - store.load() -> object|null, store.save(object)
 *  - resolveTimezone(tzId) -> {latitude, longitude, label} | null
 *  - nameLocation(latitude, longitude) -> label | null
 *
 * The schedule is edge-triggered: the TV setting is only written when the desired
 * state changes (or on startup / config change), so a manual change made in the
 * TV's own menu is respected until the next scheduled transition.
 */
function Controller(opts) {
  this.luna = opts.luna;
  this.store = opts.store;
  this.resolveTimezone = opts.resolveTimezone;
  this.nameLocation = opts.nameLocation || function () { return null; };
  this.now = opts.now || Date.now;
  this.log = opts.log || function () {};
  // Without the saved config we'd schedule with defaults, so stay idle until restarted with access.
  this.configAvailable = !(this.store && this.store.available && !this.store.available());
  this.config = assign(clone(schedule.DEFAULT_CONFIG), pickKnown(this.store && this.store.load()));
  // Coordinates saved before places were named. With no nearby place this runs again on each start.
  var loc = this.config.location;
  if (loc && !loc.label) {
    loc.label = this.nameLocation(loc.latitude, loc.longitude);
    if (loc.label && this.configAvailable && this.store) {
      try {
        this.store.save(this.config);
      } catch (e) {
        this.log('Failed to save location name: ' + e.message);
      }
    }
  }
  this.offset = null; // UTC offset in minutes reported by the TV; null = use process timezone
  this.timezone = null;
  this.tzLocation = null; // coordinates of the TV's timezone reference city
  this.lastDesired = null;
  this.lastEval = null;
  this.lastApply = null;
  this.tvState = null;
}

Controller.prototype.getOffset = function () {
  if (this.offset !== null) return this.offset;
  return -new Date(this.now()).getTimezoneOffset();
};

Controller.prototype.setClock = function (offsetMin, timezone) {
  if (typeof offsetMin !== 'number' || !isFinite(offsetMin)) return;
  var changed = offsetMin !== this.offset;
  this.offset = offsetMin;
  if (timezone && timezone !== this.timezone) {
    this.timezone = timezone;
    this.tzLocation = this.resolveTimezone ? this.resolveTimezone(timezone) : null;
    if (!this.tzLocation) this.log('No coordinates found for timezone ' + timezone);
    changed = true;
  }
  if (changed) this.tick();
};

Controller.prototype.effectiveLocation = function () {
  if (this.config.locationSource === 'manual') return this.config.location;
  return this.tzLocation;
};

Controller.prototype.locationError = function () {
  if (this.effectiveLocation()) return null;
  if (this.config.locationSource === 'manual') return 'No manual coordinates set.';
  if (!this.timezone) return 'Waiting for the TV timezone…';
  return 'Unknown location for TV timezone "' + this.timezone + '". Enter coordinates manually.';
};

Controller.prototype.tick = function () {
  if (!this.configAvailable || !this.config.enabled) {
    this.lastEval = null;
    this.lastDesired = null;
    return;
  }
  var loc = this.effectiveLocation();
  var ev = schedule.evaluate(this.config, loc, this.now(), this.getOffset());
  if (!ev.ok && this.config.mode === 'sun' && !loc) ev.error = this.locationError();
  this.lastEval = ev;
  if (!ev.ok) return;
  if (ev.desired !== this.lastDesired) {
    this.lastDesired = ev.desired;
    this.apply(ev.desired, 'schedule');
  }
};

Controller.prototype.apply = function (on, reason, cb) {
  var self = this;
  var settings = {};
  settings[SETTING_KEY] = on ? 'on' : 'off';
  this.log('Setting ' + SETTING_KEY + '=' + settings[SETTING_KEY] + ' (' + reason + ')');
  this.luna.call(SET_URI, { category: 'picture', settings: settings }, function (err) {
    self.lastApply = { on: on, reason: reason, at: self.now(), ok: !err, error: err ? err.message : null };
    if (err) {
      self.log('Failed to set ' + SETTING_KEY + ': ' + err.message);
      // Retry on the next tick.
      if (reason === 'schedule') self.lastDesired = null;
    } else {
      self.tvState = on;
    }
    if (cb) cb(err || null);
  });
};

Controller.prototype.refreshTvState = function (cb) {
  var self = this;
  this.luna.call(GET_URI, { category: 'picture', keys: [SETTING_KEY] }, function (err, payload) {
    if (!err && payload && payload.settings && payload.settings[SETTING_KEY] !== undefined) {
      self.tvState = payload.settings[SETTING_KEY] === 'on';
    }
    if (cb) cb(err || null, self.tvState);
  });
};

/** Returns an error string or null. */
Controller.prototype.updateConfig = function (patch) {
  if (!this.configAvailable) return 'Settings can\'t be read or saved until the service has root access';
  var next = assign(clone(this.config), pickKnown(patch));
  next.enabled = !!next.enabled;
  next.autostart = !!next.autostart;
  next.sunsetOffset = Number(next.sunsetOffset);
  next.sunriseOffset = Number(next.sunriseOffset);
  if (next.location) {
    next.location = {
      latitude: Number(next.location.latitude),
      longitude: Number(next.location.longitude),
      label: next.location.label ? String(next.location.label) : null
    };
  }
  var err = schedule.validateConfig(next);
  if (err) return err;
  if (patch && patch.location) next.location.label = this.nameLocation(next.location.latitude, next.location.longitude);
  if (this.store) {
    try {
      this.store.save(next);
    } catch (e) {
      this.log('Failed to save settings: ' + e.message);
      return 'Could not save settings: ' + e.message;
    }
  }
  this.config = next;
  // Force re-applying the schedule with the new settings.
  this.lastDesired = null;
  this.tick();
  return null;
};

Controller.prototype.start = function () {
  this.tick();
};

Controller.prototype.status = function () {
  var ev = this.lastEval;
  var loc = this.effectiveLocation();
  return {
    configAvailable: this.configAvailable,
    config: clone(this.config),
    clock: {
      offset: this.getOffset(),
      timezone: this.timezone,
      local: schedule.localTime(this.now(), this.getOffset())
    },
    eyeComfort: {
      tv: this.tvState,
      desired: this.lastDesired,
      lastApply: this.lastApply
    },
    schedule: ev ? clone(ev) : { ok: false, error: this.config.enabled ? null : 'Scheduler is disabled' },
    location: {
      source: this.config.locationSource,
      latitude: loc ? loc.latitude : null,
      longitude: loc ? loc.longitude : null,
      label: loc ? loc.label || null : null,
      timezoneLocation: this.tzLocation ? clone(this.tzLocation) : null,
      error: this.locationError()
    }
  };
};

module.exports = Controller;
