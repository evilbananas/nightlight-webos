'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { getSunTimes } = require('../service/lib/sun');
const schedule = require('../service/lib/schedule');
const Controller = require('../service/lib/controller');
const tzlocation = require('../service/lib/tzlocation');
const places = require('../service/lib/places');

const MIN = 60000;
const near = (actual, expectedIso, toleranceMin = 3) => {
  const diff = Math.abs(actual - Date.parse(expectedIso)) / MIN;
  assert.ok(diff <= toleranceMin, `${new Date(actual).toISOString()} not within ${toleranceMin} min of ${expectedIso}`);
};

const LONDON = { latitude: 51.5074, longitude: -0.1278 };
const TROMSO = { latitude: 69.6492, longitude: 18.9553 };

test('sun times: London summer solstice', () => {
  const t = getSunTimes(Date.parse('2024-06-21T12:00:00Z'), LONDON.latitude, LONDON.longitude);
  near(t.sunrise, '2024-06-21T03:43:00Z');
  near(t.sunset, '2024-06-21T20:21:00Z');
});

test('sun times: Sydney (southern hemisphere, east of UTC)', () => {
  // Local noon AEDT (UTC+11) on 2024-12-21.
  const t = getSunTimes(Date.parse('2024-12-21T01:00:00Z'), -33.8688, 151.2093);
  near(t.sunrise, '2024-12-20T18:41:00Z');
  near(t.sunset, '2024-12-21T09:05:00Z');
});

test('sun times: polar night and midnight sun', () => {
  assert.strictEqual(getSunTimes(Date.parse('2024-12-21T11:00:00Z'), TROMSO.latitude, TROMSO.longitude).polar, 'night');
  assert.strictEqual(getSunTimes(Date.parse('2024-06-21T11:00:00Z'), TROMSO.latitude, TROMSO.longitude).polar, 'day');
});

const cfg = (over) => Object.assign({}, schedule.DEFAULT_CONFIG, over);

test('manual window wrapping midnight', () => {
  const c = cfg({ mode: 'manual', manualStart: '21:00', manualEnd: '07:00' });
  // UTC+1: 22:00 local = 21:00 UTC
  let r = schedule.evaluate(c, null, Date.parse('2024-01-10T21:00:00Z'), 60);
  assert.strictEqual(r.desired, true);
  assert.strictEqual(r.next.on, false);
  assert.strictEqual(r.next.local, '07:00');
  assert.strictEqual(r.next.inMinutes, 9 * 60);

  // 06:59 local is still on, 07:00 local is off.
  assert.strictEqual(schedule.evaluate(c, null, Date.parse('2024-01-11T05:59:00Z'), 60).desired, true);
  r = schedule.evaluate(c, null, Date.parse('2024-01-11T06:00:00Z'), 60);
  assert.strictEqual(r.desired, false);
  assert.strictEqual(r.next.local, '21:00');
});

test('manual window within a single day', () => {
  const c = cfg({ mode: 'manual', manualStart: '01:30', manualEnd: '05:00' });
  assert.strictEqual(schedule.evaluate(c, null, Date.parse('2024-01-10T02:00:00Z'), 0).desired, true);
  assert.strictEqual(schedule.evaluate(c, null, Date.parse('2024-01-10T23:00:00Z'), 0).desired, false);
});

test('sun mode with offsets', () => {
  const c = cfg({ mode: 'sun', sunsetOffset: 30, sunriseOffset: -15 });
  // Sunset 20:21 UTC (+30 -> 20:51), BST = UTC+60
  assert.strictEqual(schedule.evaluate(c, LONDON, Date.parse('2024-06-21T20:40:00Z'), 60).desired, false);
  const r = schedule.evaluate(c, LONDON, Date.parse('2024-06-21T21:00:00Z'), 60);
  assert.strictEqual(r.desired, true);
  assert.strictEqual(r.next.on, false);
  near(r.next.at, '2024-06-22T03:28:00Z');
  assert.match(r.today.sunset, /^21:2[0-3]$/);
});

test('sun mode during polar night stays on with no next transition', () => {
  const r = schedule.evaluate(cfg(), TROMSO, Date.parse('2024-12-21T11:00:00Z'), 60);
  assert.strictEqual(r.desired, true);
  assert.strictEqual(r.next, undefined);
  assert.strictEqual(r.today.polar, 'night');
});

const OSLO = { latitude: 59.9139, longitude: 10.7522 };

test('sun mode stays off when offsets close a short summer night', () => {
  // Night is ~5 h: sunset +180 turns on at ~01:44, after sunrise -180 turns off at ~00:53 (UTC+2).
  const c = cfg({ sunsetOffset: 180, sunriseOffset: -180 });
  for (const iso of ['2024-06-21T00:00:00Z', '2024-06-21T10:00:00Z']) {
    const r = schedule.evaluate(c, OSLO, Date.parse(iso), 120);
    assert.strictEqual(r.desired, false, iso);
    assert.strictEqual(r.next, undefined, iso);
  }
});

test('sun mode stays on when offsets close a short winter day', () => {
  // Day is ~6 h: sunrise +180 turns off at ~12:18, after sunset -180 turns on at ~12:12 (UTC+1).
  const c = cfg({ sunsetOffset: -180, sunriseOffset: 180 });
  for (const iso of ['2024-12-21T11:30:00Z', '2024-12-21T20:00:00Z']) {
    const r = schedule.evaluate(c, OSLO, Date.parse(iso), 60);
    assert.strictEqual(r.desired, true, iso);
    assert.strictEqual(r.next, undefined, iso);
  }
});

test('sun mode without location reports an error', () => {
  const r = schedule.evaluate(cfg(), null, Date.now(), 0);
  assert.strictEqual(r.ok, false);
});

function makeController(startIso, config, failFirst = false, resolveTimezone) {
  const calls = [];
  let now = Date.parse(startIso);
  let saved = config;
  const c = new Controller({
    now: () => now,
    resolveTimezone,
    store: { load: () => saved, save: (d) => { saved = d; } },
    luna: {
      call: (uri, params, cb) => {
        calls.push({ uri, params });
        cb(c.failNext ? new Error('denied') : null, {});
      }
    }
  });
  c.failNext = failFirst;
  c.setClock(0);
  return { c, calls, advance: (iso) => { now = Date.parse(iso); c.tick(); } };
}

const setCalls = (calls) => calls.filter((x) => x.uri.endsWith('/setSystemSettings')).map((x) => x.params.settings.eyeComfortMode);

test('controller applies on start, then only on transitions', () => {
  const { c, calls, advance } = makeController('2024-01-10T20:00:00Z', { mode: 'manual', manualStart: '21:00', manualEnd: '07:00' });
  c.start();
  advance('2024-01-10T20:30:00Z');
  advance('2024-01-10T21:00:00Z');
  advance('2024-01-10T23:00:00Z');
  advance('2024-01-11T07:00:00Z');
  assert.deepStrictEqual(setCalls(calls), ['off', 'on', 'off']);
});

test('controller does not undo a manual override until the next transition', () => {
  const { c, calls, advance } = makeController('2024-01-10T22:00:00Z', { mode: 'manual', manualStart: '21:00', manualEnd: '07:00' });
  c.start();
  c.apply(false, 'manual');
  advance('2024-01-10T23:00:00Z');
  advance('2024-01-11T07:00:00Z');
  assert.deepStrictEqual(setCalls(calls), ['on', 'off', 'off']);
});

test('controller retries after a failed write and re-applies on config change', () => {
  const { c, calls, advance } = makeController('2024-01-10T22:00:00Z', { mode: 'manual', manualStart: '21:00', manualEnd: '07:00' }, true);
  c.start();
  assert.strictEqual(c.lastApply.ok, false);
  c.failNext = false;
  advance('2024-01-10T22:00:30Z');
  assert.strictEqual(c.lastApply.ok, true);

  assert.match(c.updateConfig({ manualStart: 'nope' }), /manualStart/);
  assert.strictEqual(c.updateConfig({ manualStart: '23:00' }), null);
  // Two failed attempts (clock sync + start), one successful retry, then the config change.
  assert.deepStrictEqual(setCalls(calls), ['on', 'on', 'on', 'off']);
});

test('controller drops unknown config keys when loading and saving', () => {
  let saved = { mode: 'manual', timeFormat: '12h' };
  const c = new Controller({
    store: { load: () => saved, save: (d) => { saved = d; } },
    luna: { call: (uri, params, cb) => cb(null, {}) }
  });
  assert.strictEqual(c.config.mode, 'manual');
  assert.strictEqual(c.updateConfig({ enabled: false, bogus: 1 }), null);
  assert.ok(!('timeFormat' in saved) && !('bogus' in saved));
});

test('controller reports a failed save and keeps the previous config', () => {
  const c = new Controller({
    store: { load: () => null, save: () => { throw new Error('ENOSPC'); } },
    luna: { call: (uri, params, cb) => cb(null, {}) }
  });
  assert.match(c.updateConfig({ mode: 'manual' }), /ENOSPC/);
  assert.strictEqual(c.config.mode, 'sun');
});

test('controller stays idle and rejects changes when the config store is unavailable', () => {
  const calls = [];
  const c = new Controller({
    now: () => Date.parse('2024-01-10T22:00:00Z'),
    store: { available: () => false, load: () => null, save: () => assert.fail('should not save') },
    luna: { call: (uri, params, cb) => { calls.push(uri); cb(null, {}); } }
  });
  c.setClock(0);
  c.start();
  c.tick();
  assert.ok(!calls.some((uri) => uri.endsWith('/setSystemSettings')));
  assert.match(c.updateConfig({ mode: 'manual' }), /root access/);
  assert.strictEqual(c.status().configAvailable, false);
});

const ZONE_TAB = [
  '# comment\tline',
  'DK\t+5540+01235\tEurope/Copenhagen',
  'US\t+404251-0740023\tAmerica/New_York\tEastern (most areas)',
  'DE,DK,NO,SE,SJ\t+5230+01322\tEurope/Berlin'
].join('\n');

test('timezone location: zone.tab parsing', () => {
  const cph = tzlocation.findInZoneTab(ZONE_TAB, 'Europe/Copenhagen');
  assert.strictEqual(cph.label, 'Copenhagen, DK');
  assert.ok(Math.abs(cph.latitude - 55.6667) < 1e-3 && Math.abs(cph.longitude - 12.5833) < 1e-3);
  const ny = tzlocation.findInZoneTab(ZONE_TAB, 'America/New_York');
  assert.ok(Math.abs(ny.latitude - 40.7142) < 1e-3 && Math.abs(ny.longitude + 74.0064) < 1e-3);
  assert.strictEqual(ny.label, 'New York, US');
  assert.strictEqual(tzlocation.findInZoneTab(ZONE_TAB, 'Europe/Berlin').label, 'Berlin, DE');
  assert.strictEqual(tzlocation.findInZoneTab(ZONE_TAB, 'Etc/UTC'), null);
});

test('controller uses the TV timezone location, and manual coordinates override it', () => {
  const resolve = (tz) => tzlocation.findInZoneTab(ZONE_TAB, tz);
  // 16:30 local in Copenhagen (UTC+1): after sunset there (~16:09), before sunset in London.
  const { c } = makeController('2026-11-13T15:30:00Z', { mode: 'sun' }, false, resolve);
  assert.strictEqual(c.lastEval.ok, false); // timezone not known yet
  c.setClock(60, 'Europe/Copenhagen');
  assert.strictEqual(c.lastDesired, true);
  assert.strictEqual(c.status().location.label, 'Copenhagen, DK');

  assert.strictEqual(c.updateConfig({ locationSource: 'manual', location: { latitude: 51.5074, longitude: -0.1278 } }), null);
  assert.strictEqual(c.lastDesired, false);

  c.updateConfig({ locationSource: 'tv' });
  c.setClock(0, 'Etc/UTC');
  assert.strictEqual(c.lastEval.ok, false);
  assert.match(c.lastEval.error, /Etc\/UTC/);
});

test('places: nearest town, a city over its own districts, across the antimeridian, and none far out at sea', () => {
  const text = 'Paris\tFR\t48.853\t2.349\t2138551\nParis 01 Louvre\tFR\t48.859\t2.342\t15114\n' +
    'Versailles\tFR\t48.804\t2.135\t85416\nLabasa\tFJ\t-16.433\t179.950\t27949\nApia\tWS\t-13.833\t-171.767\t40407\n';
  assert.strictEqual(places.nearestIn(text, 48.86, 2.34), 'Paris, FR');
  assert.strictEqual(places.nearestIn(text, 48.80, 2.13), 'Versailles, FR');
  assert.strictEqual(places.nearestIn(text, -16.4, -179.9), 'Labasa, FJ');
  assert.strictEqual(places.nearestIn(text, 0, -30), null);
});

test('controller names manual coordinates when they are saved, and ones saved before naming existed', () => {
  const nameLocation = (lat, lon) => `${lat}/${lon}`;
  let saved = { locationSource: 'manual', location: { latitude: 48.86, longitude: 2.34, label: null } };
  const c = new Controller({
    nameLocation,
    store: { load: () => saved, save: (d) => { saved = d; } },
    luna: { call: (uri, params, cb) => cb(null, {}) }
  });
  assert.strictEqual(c.config.location.label, '48.86/2.34');
  assert.strictEqual(saved.location.label, '48.86/2.34');
  assert.strictEqual(c.updateConfig({ location: { latitude: 51.5, longitude: -0.12, label: 'stale' } }), null);
  assert.strictEqual(saved.location.label, '51.5/-0.12');
  assert.strictEqual(c.updateConfig({ mode: 'manual' }), null);
  assert.strictEqual(saved.location.label, '51.5/-0.12');
});

test('timezone location: reads zone.tab first, then zone1970.tab, skipping missing files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-tz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zoneTab = path.join(dir, 'zone.tab');
  const zone1970 = path.join(dir, 'zone1970.tab');
  fs.writeFileSync(zoneTab, 'DK\t+5540+01235\tEurope/Copenhagen\n');
  // Made-up conflicting entry, to check which file wins when both list a zone.
  fs.writeFileSync(zone1970, 'DE,DK\t+5230+01322\tEurope/Copenhagen\nUS\t+404251-0740023\tAmerica/New_York\n');
  const files = [path.join(dir, 'missing.tab'), zoneTab, zone1970];

  assert.strictEqual(tzlocation.resolve('Europe/Copenhagen', files).label, 'Copenhagen, DK');
  assert.strictEqual(tzlocation.resolve('America/New_York', files).label, 'New York, US');
  assert.strictEqual(tzlocation.resolve('Etc/UTC', files), null);
});
