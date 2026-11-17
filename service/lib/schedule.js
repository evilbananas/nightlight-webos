'use strict';
var sun = require('./sun');

var MIN_MS = 60000;
var DAY_MS = 86400000;
// Matches data-min/data-max on the offset steppers in app/index.html.
var MAX_OFFSET = 240;

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
  if (!isNum(c.sunsetOffset) || Math.abs(c.sunsetOffset) > MAX_OFFSET) return 'sunsetOffset must be within ±' + MAX_OFFSET + ' minutes';
  if (!isNum(c.sunriseOffset) || Math.abs(c.sunriseOffset) > MAX_OFFSET) return 'sunriseOffset must be within ±' + MAX_OFFSET + ' minutes';
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
 * On/off events (UTC ms) for the local day starting at `dayStart`. In sun mode, `t`
 * holds that day's sun times from sun.getSunTimes.
 * Each event: { at, on: boolean, kind }.
 */
function eventsForDay(config, dayStart, t) {
  if (config.mode === 'manual') {
    return [
      { at: dayStart + parseHHMM(config.manualStart) * MIN_MS, on: true, kind: 'start' },
      { at: dayStart + parseHHMM(config.manualEnd) * MIN_MS, on: false, kind: 'end' }
    ];
  }
  if (t.polar === 'night') return [{ at: dayStart, on: true, kind: 'polar-night' }];
  if (t.polar === 'day') return [{ at: dayStart, on: false, kind: 'polar-day' }];
  return [
    { at: t.sunrise + config.sunriseOffset * MIN_MS, on: false, kind: 'sunrise' },
    { at: t.sunset + config.sunsetOffset * MIN_MS, on: true, kind: 'sunset' }
  ];
}

/**
 * Sun-mode events in day order, minus empty intervals. Large offsets can move an "on"
 * past the next "off" (short nights) or an "off" past the next "on" (short days). The
 * interval between them is then empty, so both are dropped and the earlier state
 * continues. Events that don't change the state are dropped too.
 */
function dropEmptyIntervals(events) {
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var last = out[out.length - 1];
    if (last && e.at <= last.at && last.on !== e.on) {
      out.pop();
      last = out[out.length - 1];
    }
    if (!last || (last.on !== e.on && e.at > last.at)) out.push(e);
  }
  return out;
}

/**
 * Evaluates the schedule at `now`. `location` is the {latitude, longitude} used in sun mode.
 * @returns {{ok: boolean, error?: string, desired?: boolean, next?: object, today?: object}}
 */
function evaluate(config, location, now, offsetMin) {
  if (config.mode === 'sun' && !location) {
    return { ok: false, error: 'No location available.' };
  }
  var err = validateConfig(config);
  if (err) return { ok: false, error: err };

  var today = localDayStart(now, offsetMin);
  var events = [];
  var todaySun = null;
  // Day 2 is only there to cancel day 1's last event if their interval is empty.
  for (var i = -1; i <= 2; i++) {
    var dayStart = today + i * DAY_MS;
    var t = config.mode === 'sun'
      ? sun.getSunTimes(dayStart + DAY_MS / 2, location.latitude, location.longitude)
      : null;
    if (i === 0) todaySun = t;
    var dayEvents = eventsForDay(config, dayStart, t);
    for (var k = 0; k < dayEvents.length; k++) dayEvents[k].lookahead = i === 2;
    events = events.concat(dayEvents);
  }
  if (config.mode === 'sun') events = dropEmptyIntervals(events);
  else events.sort(function (a, b) { return a.at - b.at; });
  events = events.filter(function (e) { return !e.lookahead; });

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

  if (todaySun) {
    result.today.polar = todaySun.polar;
    result.today.sunrise = todaySun.sunrise === null ? null : localTime(todaySun.sunrise, offsetMin);
    result.today.sunset = todaySun.sunset === null ? null : localTime(todaySun.sunset, offsetMin);
    result.today.onAt = todaySun.sunset === null ? null : localTime(todaySun.sunset + config.sunsetOffset * MIN_MS, offsetMin);
    result.today.offAt = todaySun.sunrise === null ? null : localTime(todaySun.sunrise + config.sunriseOffset * MIN_MS, offsetMin);
  } else {
    result.today.onAt = formatHHMM(parseHHMM(config.manualStart));
    result.today.offAt = formatHHMM(parseHHMM(config.manualEnd));
  }
  return result;
}

module.exports = {
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  localTime: localTime,
  validateConfig: validateConfig,
  evaluate: evaluate
};
