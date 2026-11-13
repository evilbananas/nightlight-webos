'use strict';
var fs = require('fs');

// zone.tab lists every zone, including ones zone1970.tab leaves out because they are
// folded into another zone (e.g. Europe/Copenhagen into Europe/Berlin).
var ZONE_FILES = ['/usr/share/zoneinfo/zone.tab', '/usr/share/zoneinfo/zone1970.tab'];

/** Parses ISO 6709 "+DDMM[SS]" / "+DDDMM[SS]" into decimal degrees. */
function parseDegrees(s, degDigits) {
  var sign = s.charAt(0) === '-' ? -1 : 1;
  var d = +s.substr(1, degDigits);
  var m = +s.substr(1 + degDigits, 2);
  var sec = s.length > 3 + degDigits ? +s.substr(3 + degDigits, 2) : 0;
  return sign * (d + m / 60 + sec / 3600);
}

/** "+5540+01235" -> { latitude: 55.667, longitude: 12.583 } */
function parseCoordinates(s) {
  var m = /^([+-]\d{4}(?:\d{2})?)([+-]\d{5}(?:\d{2})?)$/.exec(s);
  if (!m) return null;
  return { latitude: parseDegrees(m[1], 2), longitude: parseDegrees(m[2], 3) };
}

/** Finds the reference coordinates of a tz ID (e.g. "Europe/Copenhagen") in zone.tab-formatted text. */
function findInZoneTab(text, timezone) {
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var cols = lines[i].split('\t');
    if (cols.length < 3 || cols[0].charAt(0) === '#' || cols[2] !== timezone) continue;
    var coords = parseCoordinates(cols[1]);
    if (!coords) return null;
    var city = timezone.split('/').pop().replace(/_/g, ' ');
    coords.label = city + ', ' + cols[0].split(',')[0];
    return coords;
  }
  return null;
}

/** Resolves a tz ID to { latitude, longitude, label } using the TV's tz database, or null. */
function resolve(timezone, files) {
  files = files || ZONE_FILES;
  for (var i = 0; i < files.length; i++) {
    var text;
    try {
      text = fs.readFileSync(files[i], 'utf8');
    } catch (e) {
      continue;
    }
    var loc = findInZoneTab(text, timezone);
    if (loc) return loc;
  }
  return null;
}

module.exports = { parseCoordinates: parseCoordinates, findInZoneTab: findInZoneTab, resolve: resolve };
