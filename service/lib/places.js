'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var PLACES_FILE = path.join(__dirname, '..', 'data', 'places.tsv.gz');
// Beyond this there's no town to name the spot after, e.g. at sea.
var MAX_KM = 100;
var KM_PER_DEG = 111.2;
// A place counts as this many km closer per square root of its population, so a city's name wins
// over the districts GeoNames lists inside it (~7 km for Paris, ~0.25 km for a village of 2,500).
var KM_PER_SQRT_POP = 0.005;

/** `text` has lines of "name\tCC\tlat\tlon\tpopulation". */
function nearestIn(text, latitude, longitude) {
  var cosLat = Math.cos(latitude * Math.PI / 180);
  var best = null;
  var bestScore = Infinity;
  // Walks the text instead of splitting it into an array of ~230k lines.
  for (var start = 0, end; start < text.length; start = end + 1) {
    end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    var c = text.substring(start, end).split('\t');
    if (c.length < 4) continue;
    var dLat = +c[2] - latitude;
    var dLon = Math.abs(+c[3] - longitude);
    if (dLon > 180) dLon = 360 - dLon;
    dLon *= cosLat;
    var km = Math.sqrt(dLat * dLat + dLon * dLon) * KM_PER_DEG;
    if (km > MAX_KM) continue;
    var score = km - KM_PER_SQRT_POP * Math.sqrt(+c[4] || 0);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best ? best[0] + ', ' + best[1] : null;
}

function nearest(latitude, longitude, file) {
  var text;
  try {
    text = zlib.gunzipSync(fs.readFileSync(file || PLACES_FILE)).toString('utf8');
  } catch (e) {
    return null;
  }
  return nearestIn(text, latitude, longitude);
}

module.exports = { nearest: nearest, nearestIn: nearestIn };
