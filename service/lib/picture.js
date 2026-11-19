'use strict';

// LG "picture" settings NightLight changes at night. The color temperature slider and the
// white balance range from -50 to 50, the backlight from 0 to 100. On a webOS 4.4 LCD, the
// slider works in every picture mode tested, while the white balance only takes effect in
// the Expert modes (Vivid and Standard ignore it).
var BACKLIGHT_KEY = 'backlight';
var SLIDER_KEY = 'colorTemperature';
var CHANNELS = ['Red', 'Green', 'Blue'];
var GAIN_KEYS = CHANNELS.map(function (c) { return 'whiteBalance' + c + 'Gain'; });
var OFFSET_KEYS = CHANNELS.map(function (c) { return 'whiteBalance' + c + 'Offset'; });
var KEYS = [BACKLIGHT_KEY, SLIDER_KEY].concat(GAIN_KEYS, OFFSET_KEYS);
var MIN_KELVIN = 1000;
var NEUTRAL_KELVIN = 6500;

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/** Color of a black body at `kelvin` as [r, g, b] in 0..1 (Tanner Helland's curve fit). */
function kelvinToRgb(kelvin) {
  var t = kelvin / 100;
  var r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  var g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  var b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map(function (v) { return clamp(v, 0, 255) / 255; });
}

// TVs are set up for a 6500 K white point, so that's where no change is needed.
var REFERENCE = kelvinToRgb(NEUTRAL_KELVIN);

/** Per-channel factors (the largest is 1) that move a 6500 K white to `kelvin`. */
function channelFactors(kelvin) {
  var c = kelvinToRgb(kelvin);
  var f = c.map(function (v, i) { return v / REFERENCE[i]; });
  var max = Math.max.apply(null, f);
  return f.map(function (v) { return v / max; });
}

// How much of each channel is left at the warmest setting. Cuts are scaled so this much
// turns the channel fully off: on the TV, green at gain and offset -50 with blue off gave
// the deep red expected at 1000 K, while green at gain -40 looked yellow-green.
var FLOOR = channelFactors(MIN_KELVIN);

/**
 * 2-point white balance for `kelvin`. A channel is cut with its gain first and, once the
 * gain is at -50, with its offset too, so lower Kelvin values keep getting warmer instead
 * of stopping where the gain runs out.
 * shortcut: calibrated by eye on one webOS 4.4 TV (Expert mode); measure with a
 * colorimeter if the Kelvin values need to be exact.
 */
function whiteBalance(kelvin) {
  var f = channelFactors(kelvin);
  var out = {};
  for (var i = 0; i < 3; i++) {
    var cut = (f[i] - 1) / ((1 - FLOOR[i]) || 1) * 100; // 0 (unchanged) .. -100 (channel off)
    out[GAIN_KEYS[i]] = Math.round(clamp(cut, -50, 0)) || 0;
    out[OFFSET_KEYS[i]] = Math.round(clamp(cut + 50, -50, 0)) || 0;
  }
  return out;
}

function mired(kelvin) {
  return 1e6 / kelvin;
}

/**
 * Color temperature slider for `kelvin`: 0 at 6500 K, W50 (-50) at 4000 K and below,
 * C50 (50) at 10000 K, linear in mired in between.
 * shortcut: LG doesn't say which Kelvin W50 and C50 stand for; these are rough guesses.
 */
function slider(kelvin) {
  var d = mired(NEUTRAL_KELVIN) - mired(kelvin);
  var v = d < 0 ? d / (mired(4000) - mired(NEUTRAL_KELVIN)) * 50 : d / (mired(NEUTRAL_KELVIN) - mired(10000)) * 50;
  return Math.round(clamp(v, -50, 50)) || 0;
}

/** Night values for the features turned on in `config`. */
function nightValues(config) {
  var out = config.colorEnabled ? whiteBalance(config.nightKelvin) : {};
  if (config.colorEnabled) out[SLIDER_KEY] = slider(config.nightKelvin);
  if (config.dimEnabled) out[BACKLIGHT_KEY] = config.nightBacklight;
  return out;
}

/** `day` values moved toward `night` by `level` (0..1). Keys without a night value keep their day value. */
function mix(day, night, level) {
  var out = {};
  for (var k in day) {
    out[k] = Object.prototype.hasOwnProperty.call(night, k) ? Math.round(day[k] + (night[k] - day[k]) * level) : day[k];
  }
  return out;
}

/**
 * Which set of picture settings a getSystemSettings reply is about, e.g. "default/sdr/vivid".
 * The TV keeps separate settings per input, dynamic range and picture mode. Null if unknown.
 */
function settingsKey(payload) {
  var s = (payload && payload.settings) || {};
  var d = (payload && payload.dimension) || {};
  var mode = s.pictureMode || d.pictureMode;
  if (!mode) return null;
  return [d.input, d.dynamicRange, mode].filter(Boolean).join('/');
}

module.exports = {
  KEYS: KEYS,
  settingsKey: settingsKey,
  GAIN_KEYS: GAIN_KEYS,
  BACKLIGHT_KEY: BACKLIGHT_KEY,
  SLIDER_KEY: SLIDER_KEY,
  kelvinToRgb: kelvinToRgb,
  whiteBalance: whiteBalance,
  slider: slider,
  nightValues: nightValues,
  mix: mix
};
