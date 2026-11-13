'use strict';
// Sunrise/sunset calculation based on the standard NOAA / Meeus approximations.
// Written in ES5 so it runs on the old Node.js versions shipped with webOS.

var RAD = Math.PI / 180;
var DAY_MS = 86400000;
var J1970 = 2440588;
var J2000 = 2451545;
var J0 = 0.0009;
var OBLIQUITY = RAD * 23.4397;
// Apparent sunrise/sunset: upper limb touches horizon, including refraction.
var SUN_ALTITUDE = -0.833 * RAD;

function toDays(ms) {
  return ms / DAY_MS - 0.5 + J1970 - J2000;
}

function fromJulian(j) {
  return (j + 0.5 - J1970) * DAY_MS;
}

function solarMeanAnomaly(d) {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M) {
  var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  var perihelion = RAD * 102.9372;
  return M + C + perihelion + Math.PI;
}

function declination(L) {
  return Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
}

/**
 * Computes sunrise and sunset for the solar day closest to `ms`.
 * Pass a timestamp near local noon of the wanted day.
 *
 * @returns {{sunrise: number|null, sunset: number|null, polar: null|'day'|'night'}}
 *   Timestamps in UTC ms. `polar` is 'night' if the sun never rises, 'day' if it never sets.
 */
function getSunTimes(ms, latitude, longitude) {
  var lw = RAD * -longitude;
  var phi = RAD * latitude;
  var d = toDays(ms);

  var n = Math.round(d - J0 - lw / (2 * Math.PI));
  var ds = J0 + lw / (2 * Math.PI) + n;
  var M = solarMeanAnomaly(ds);
  var L = eclipticLongitude(M);
  var dec = declination(L);
  var jNoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

  var cosH = (Math.sin(SUN_ALTITUDE) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH > 1) return { sunrise: null, sunset: null, polar: 'night' };
  if (cosH < -1) return { sunrise: null, sunset: null, polar: 'day' };

  var w = Math.acos(cosH);
  var a = J0 + (w + lw) / (2 * Math.PI) + n;
  var jSet = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  var jRise = jNoon - (jSet - jNoon);

  return { sunrise: fromJulian(jRise), sunset: fromJulian(jSet), polar: null };
}

module.exports = { getSunTimes: getSunTimes };
