'use strict';
var sun = require('./sun');

var MIN_MS = 60000;
var DAY_MS = 86400000;

var DEFAULT_CONFIG = {
  enabled: true,
  mode: 'sun', // 'sun' | 'manual'
  sunsetOffset: 0, // minutes, applied to sunset (turn on)
  sunriseOffset: 0, // minutes, applied to sunrise (turn off)
  manualStart: '21:00',
  manualEnd: '07:00',
  locationSource: 'tv', // 'tv' (coordinates of the TV's timezone) | 'manual'
  location: null, // manual coordinates: { latitude, longitude, label }
  autostart: true
};

function parseHHMM(value) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(value));
  if (!m) return NaN;
  var h = +m[1];
  var min = +m[2];
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

function formatHHMM(minutes) {
  var m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
}

/** Local wall-clock "HH:MM" for a UTC timestamp, given the UTC offset in minutes. */
function localTime(utcMs, offsetMin) {
  return formatHHMM(Math.floor((utcMs + offsetMin * MIN_MS) / MIN_MS));
}

/** UTC timestamp of local midnight for the local day containing `utcMs`. */
function localDayStart(utcMs, offsetMin) {
  var localMs = utcMs + offsetMin * MIN_MS;
  return localMs - (((localMs % DAY_MS) + DAY_MS) % DAY_MS) - offsetMin * MIN_MS;
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

/** Returns an error string, or null if the config is valid. */
function validateConfig(c) {
  if (c.mode !== 'sun' && c.mode !== 'manual') return 'mode must be "sun" or "manual"';
  if (!isNum(c.sunsetOffset) || Math.abs(c.sunsetOffset) > 720) return 'sunsetOffset must be within ±720 minutes';
  if (!isNum(c.sunriseOffset) || Math.abs(c.sunriseOffset) > 720) return 'sunriseOffset must be within ±720 minutes';
  if (isNaN(parseHHMM(c.manualStart))) return 'manualStart must be HH:MM';
  if (isNaN(parseHHMM(c.manualEnd))) return 'manualEnd must be HH:MM';
  if (parseHHMM(c.manualStart) === parseHHMM(c.manualEnd)) return 'manualStart and manualEnd must differ';
  if (c.locationSource !== 'tv' && c.locationSource !== 'manual') return 'locationSource must be "tv" or "manual"';
  if (c.locationSource === 'manual' && !c.location) return 'Enter coordinates to use a manual location';
  if (c.location) {
    var loc = c.location;
    if (!isNum(loc.latitude) || loc.latitude < -90 || loc.latitude > 90) return 'latitude must be between -90 and 90';
    if (!isNum(loc.longitude) || loc.longitude < -180 || loc.longitude > 180) return 'longitude must be between -180 and 180';
  }
  return null;
}

/**
 * On/off events (UTC ms) for the local day starting at `dayStart`.
 * Each event: { at, on: boolean, kind }.
 */
function eventsForDay(config, dayStart) {
  if (config.mode === 'manual') {
    return [
      { at: dayStart + parseHHMM(config.manualStart) * MIN_MS, on: true, kind: 'start' },
      { at: dayStart + parseHHMM(config.manualEnd) * MIN_MS, on: false, kind: 'end' }
    ];
  }
  var loc = config.location;
  var t = sun.getSunTimes(dayStart + DAY_MS / 2, loc.latitude, loc.longitude);
  if (t.polar === 'night') return [{ at: dayStart, on: true, kind: 'polar-night' }];
  if (t.polar === 'day') return [{ at: dayStart, on: false, kind: 'polar-day' }];
  return [
    { at: t.sunrise + config.sunriseOffset * MIN_MS, on: false, kind: 'sunrise' },
    { at: t.sunset + config.sunsetOffset * MIN_MS, on: true, kind: 'sunset' }
  ];
}

/**
 * Evaluates the schedule at `now`. In sun mode, `config.location` must hold the
 * effective coordinates (the controller resolves TV timezone vs. manual).
 * @returns {{ok: boolean, error?: string, desired?: boolean, next?: object, today?: object}}
 */
function evaluate(config, now, offsetMin) {
  if (config.mode === 'sun' && !config.location) {
    return { ok: false, error: 'No location available.' };
  }
  var err = validateConfig(config);
  if (err) return { ok: false, error: err };

  var today = localDayStart(now, offsetMin);
  var events = [];
  for (var i = -1; i <= 1; i++) {
    events = events.concat(eventsForDay(config, today + i * DAY_MS));
  }
  events.sort(function (a, b) { return a.at - b.at; });

  var current = null;
  var j;
  for (j = 0; j < events.length; j++) {
    if (events[j].at <= now) current = events[j];
  }
  var desired = current ? current.on : false;

  // First future event that actually changes state (none during multi-day polar periods).
  var next = null;
  for (j = 0; j < events.length; j++) {
    if (events[j].at > now && events[j].on !== desired) { next = events[j]; break; }
  }

  var result = { ok: true, desired: desired, today: { offset: offsetMin } };
  if (next) {
    result.next = {
      on: next.on,
      at: next.at,
      local: localTime(next.at, offsetMin),
      inMinutes: Math.round((next.at - now) / MIN_MS)
    };
  }

  if (config.mode === 'sun') {
    var t = sun.getSunTimes(today + DAY_MS / 2, config.location.latitude, config.location.longitude);
    result.today.polar = t.polar;
    result.today.sunrise = t.sunrise === null ? null : localTime(t.sunrise, offsetMin);
    result.today.sunset = t.sunset === null ? null : localTime(t.sunset, offsetMin);
    result.today.onAt = t.sunset === null ? null : localTime(t.sunset + config.sunsetOffset * MIN_MS, offsetMin);
    result.today.offAt = t.sunrise === null ? null : localTime(t.sunrise + config.sunriseOffset * MIN_MS, offsetMin);
  } else {
    result.today.onAt = formatHHMM(parseHHMM(config.manualStart));
    result.today.offAt = formatHHMM(parseHHMM(config.manualEnd));
  }
  return result;
}

module.exports = {
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  parseHHMM: parseHHMM,
  formatHHMM: formatHHMM,
  localTime: localTime,
  localDayStart: localDayStart,
  validateConfig: validateConfig,
  evaluate: evaluate
};
