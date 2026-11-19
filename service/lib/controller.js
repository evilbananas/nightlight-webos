'use strict';
var schedule = require('./schedule');
var picture = require('./picture');

var SET_URI = 'luna://com.webos.settingsservice/setSystemSettings';
var GET_URI = 'luna://com.webos.settingsservice/getSystemSettings';
var SETTING_KEY = 'eyeComfortMode';
var MODE_KEY = 'pictureMode';

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
 *  - stateStore: like store, holds the saved day picture values (optional)
 *  - resolveTimezone(tzId) -> {latitude, longitude, label} | null
 *  - nameLocation(latitude, longitude) -> label | null
 *  - notify(message): shows a notification on the TV (optional)
 *
 * The schedule is edge-triggered: the TV setting is only written when the desired
 * state changes (or on startup / config change), so a manual change made in the
 * TV's own menu is respected until the next scheduled transition. Picture values are
 * only written while they change (during a fade or after a config change).
 */
function Controller(opts) {
  this.luna = opts.luna;
  this.store = opts.store;
  this.stateStore = opts.stateStore || null;
  this.resolveTimezone = opts.resolveTimezone;
  this.nameLocation = opts.nameLocation || function () { return null; };
  this.now = opts.now || Date.now;
  this.log = opts.log || function () {};
  this.notify = opts.notify || function () {};
  var state = this.stateStore && this.stateStore.load();
  // Day picture values per settings key (see picture.settingsKey), saved before night values
  // are first written so they can be restored in the morning, even after a restart.
  this.snapshots = (state && state.snapshots) || {};
  // Picture mode to go back to in the morning, per input and dynamic range ("default/sdr/"),
  // for inputs switched to config.nightPictureMode.
  this.modeSwitches = (state && state.modeSwitches) || {};
  this.pictureMode = null; // settings key of the active input, dynamic range and picture mode
  this.supported = null; // { color, backlight } once the picture settings have been read
  // Value types as last read from the TV. The slider is a number on webOS 4.4, which also
  // covers writes made before the first read, e.g. a restore right after a restart.
  this.numericKeys = { colorTemperature: true };
  this.level = 0; // night level last asked for: 0 = day, 1 = full night
  this.lastPicture = null; // picture values last written
  this.pictureBusy = false;
  this.pictureError = null;
  this.manual = null; // { on }: set by "turn on/off now", kept until the schedule turns the other way
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
  if (!this.configAvailable) {
    this.lastEval = null;
    this.lastDesired = null;
    return;
  }
  if (!this.config.enabled) {
    this.lastEval = null;
    this.lastDesired = null;
    // Puts the day picture back if night values are still showing.
    this.updatePicture(this.manual && this.manual.on ? 1 : 0);
    return;
  }
  var loc = this.effectiveLocation();
  var ev = schedule.evaluate(this.config, loc, this.now(), this.getOffset());
  if (!ev.ok && this.config.mode === 'sun' && !loc) ev.error = this.locationError();
  this.lastEval = ev;
  if (!ev.ok) return;
  if (ev.desired !== this.lastDesired) {
    var startup = this.lastDesired === null;
    this.lastDesired = ev.desired;
    if (this.manual && this.manual.on !== ev.desired) this.manual = null;
    this.apply(ev.desired && this.config.eyeComfort, 'schedule');
    if (!startup && this.config.notify) {
      var fade = this.config.fadeMinutes && (this.config.colorEnabled || this.config.dimEnabled);
      this.notify('NightLight: night mode ' + (fade
        ? 'turning ' + (ev.desired ? 'on' : 'off') + ' over ' + this.config.fadeMinutes + ' min'
        : 'is ' + (ev.desired ? 'on' : 'off')));
    }
  }
  this.updatePicture(this.manual ? (this.manual.on ? 1 : 0) : ev.level);
};

/** "Turn on/off now": applies full night or day right away and holds it until the schedule turns the other way. */
Controller.prototype.setManual = function (on, cb) {
  this.manual = { on: on };
  this.updatePicture(on ? 1 : 0);
  this.apply(on && this.config.eyeComfort, 'manual', cb);
};

/**
 * Reads the picture settings NightLight uses. Calls back with the numeric values the TV
 * has (keys it lacks are left out) and the settings key they belong to.
 */
Controller.prototype.readPicture = function (cb) {
  var self = this;
  this.luna.call(GET_URI, { category: 'picture', keys: [MODE_KEY].concat(picture.KEYS) }, function (err, payload) {
    // getSystemSettings reports an error for keys a TV doesn't have but still returns the others.
    var s = payload && payload.settings;
    if (!s) return cb(err || new Error('No picture settings returned'));
    var values = {};
    picture.KEYS.forEach(function (k) {
      if (s[k] === undefined || s[k] === null || s[k] === '' || !isFinite(Number(s[k]))) return;
      values[k] = Number(s[k]);
      // Written back in the type the TV uses: the slider is a number, the others strings.
      self.numericKeys[k] = typeof s[k] === 'number';
    });
    self.supported = {
      color: picture.SLIDER_KEY in values || picture.GAIN_KEYS.every(function (k) { return k in values; }),
      backlight: picture.BACKLIGHT_KEY in values
    };
    cb(null, values, picture.settingsKey(payload));
  });
};

/** Called with the settings key the TV reports, e.g. after switching input, picture mode or to HDR. */
Controller.prototype.setPictureMode = function (mode) {
  if (!mode || mode === this.pictureMode) return;
  this.pictureMode = mode;
  // Each mode has its own settings, so write the current values to the new one.
  this.lastPicture = null;
  this.updatePicture(this.level);
};

Controller.prototype.saveState = function () {
  if (!this.stateStore) return;
  try {
    this.stateStore.save({ snapshots: this.snapshots, modeSwitches: this.modeSwitches });
  } catch (e) {
    this.log('Failed to save picture state: ' + e.message);
  }
};

Controller.prototype.setPictureError = function (text) {
  if (text && text !== this.pictureError) this.log(text);
  this.pictureError = text;
};

/** Splits a settings key into its input/dynamic range part ("default/sdr/") and picture mode. */
function splitKey(key) {
  var i = key.lastIndexOf('/');
  return { prefix: key.slice(0, i + 1), mode: key.slice(i + 1) };
}

/** True if night mode should first switch the input of settings key `key` to the night picture mode. */
Controller.prototype.wantsNightMode = function (key) {
  var night = this.config.nightPictureMode;
  var k = splitKey(key);
  // HDR has its own picture modes, so only SDR is switched.
  var sdr = k.prefix === '' || /(^|\/)sdr\/$/.test(k.prefix);
  return night !== 'off' && sdr && k.mode !== night && !(k.prefix in this.modeSwitches);
};

/**
 * Switches the picture mode of `key`'s input to `to`. With `night`, the current mode is
 * remembered so restorePictureMode can switch back in the morning.
 */
Controller.prototype.switchPictureMode = function (key, to, night) {
  var self = this;
  var k = splitKey(key);
  if (night) this.modeSwitches[k.prefix] = k.mode;
  else delete this.modeSwitches[k.prefix];
  this.saveState();
  this.log('Switching picture mode to ' + to + ' (' + key + ')');
  this.pictureBusy = true;
  this.luna.call(SET_URI, { category: 'picture', settings: { pictureMode: to } }, function (err) {
    self.pictureBusy = false;
    if (err) {
      // Put the record back as it was, so the next tick tries again.
      if (night) delete self.modeSwitches[k.prefix];
      else self.modeSwitches[k.prefix] = to;
      self.saveState();
      return self.setPictureError('Could not switch picture mode: ' + err.message);
    }
    // The subscription reports the new mode too; this carries on in it right away.
    self.setPictureMode(k.prefix + to);
  });
};

/** In the day: switches `key`'s input back to the picture mode it had before night mode. */
Controller.prototype.restorePictureMode = function (key) {
  var k = splitKey(key);
  var original = this.modeSwitches[k.prefix];
  if (original === undefined) return;
  if (original !== k.mode) return this.switchPictureMode(key, original, false);
  delete this.modeSwitches[k.prefix];
  this.saveState();
};

/**
 * Moves the picture settings to `level` (0 = day, 1 = full night). Day values are saved
 * per settings key before the first night value is written, and dropped once they've
 * been written back. With a night picture mode, the input is switched to it first and
 * back once its day values are restored.
 */
Controller.prototype.updatePicture = function (level) {
  var self = this;
  var cfg = this.config;
  this.level = level;
  if (this.pictureBusy) return; // picked up when the running call finishes
  var mode = this.pictureMode || 'default';
  var day = this.snapshots[mode];
  var active = level > 0 && (cfg.colorEnabled || cfg.dimEnabled || cfg.nightPictureMode !== 'off');

  // Picture modes are only switched once the TV has said which one is active.
  var known = this.pictureMode !== null;
  if (!day) {
    if (!active) {
      if (known) this.restorePictureMode(mode);
      return;
    }
    if (known && this.wantsNightMode(mode)) return this.switchPictureMode(mode, cfg.nightPictureMode, true);
    this.pictureBusy = true;
    this.readPicture(function (err, values, tvMode) {
      self.pictureBusy = false;
      if (err) return self.setPictureError('Could not read picture settings: ' + err.message);
      var key = tvMode || mode;
      if (tvMode) self.pictureMode = tvMode;
      if (!Object.keys(values).length) return self.setPictureError('This TV doesn\'t report backlight or white balance settings');
      // Switch first, so the day values are saved for the night picture mode.
      if (self.wantsNightMode(key)) return self.updatePicture(self.level);
      if (!self.snapshots[key]) {
        self.snapshots[key] = values;
        self.saveState();
      }
      self.updatePicture(self.level);
    });
    return;
  }

  var target = picture.mix(day, picture.nightValues(cfg), active ? level : 0);
  var changes = null;
  for (var k in target) {
    if (this.lastPicture && this.lastPicture[k] === target[k]) continue;
    changes = changes || {};
    changes[k] = this.numericKeys[k] ? target[k] : String(target[k]);
  }
  if (!changes) {
    if (!active) {
      this.dropSnapshot(mode);
      this.updatePicture(level); // switches the picture mode back if needed
    }
    return;
  }
  // Logging every step of a fade would flood the log.
  if (level === 0 || level === 1) this.log('Setting picture ' + JSON.stringify(changes) + ' (' + mode + ')');
  this.pictureBusy = true;
  this.luna.call(SET_URI, { category: 'picture', settings: changes }, function (err) {
    self.pictureBusy = false;
    // Left unchanged on failure, so the next tick tries again.
    if (err) return self.setPictureError('Could not change picture settings: ' + err.message);
    self.setPictureError(null);
    self.lastPicture = target;
    if (!active) self.dropSnapshot(mode);
    // Catches changes made while the call ran; a no-op when nothing changed.
    self.updatePicture(self.level);
  });
};

Controller.prototype.dropSnapshot = function (mode) {
  delete this.snapshots[mode];
  this.lastPicture = null;
  this.saveState();
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
  ['eyeComfort', 'colorEnabled', 'dimEnabled', 'notify'].forEach(function (k) { next[k] = !!next[k]; });
  ['nightKelvin', 'nightBacklight', 'fadeMinutes'].forEach(function (k) { next[k] = Number(next[k]); });
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
  var self = this;
  this.tick();
  // Learns the picture mode, so day values saved last night are put back if the TV
  // was off when night mode ended.
  this.readPicture(function (err, values, mode) {
    if (!err) self.setPictureMode(mode);
  });
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
    night: {
      level: this.level,
      manual: !!this.manual,
      pictureMode: this.pictureMode,
      supported: this.supported ? clone(this.supported) : null,
      error: this.pictureError
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
