'use strict';
const test = require('node:test');
const assert = require('node:assert');
const schedule = require('../service/lib/schedule');
const picture = require('../service/lib/picture');
const Controller = require('../service/lib/controller');

const cfg = (over) => Object.assign({}, schedule.DEFAULT_CONFIG, over);
const blueCut = (wb) => wb.whiteBalanceBlueGain + wb.whiteBalanceBlueOffset;
const greenCut = (wb) => wb.whiteBalanceGreenGain + wb.whiteBalanceGreenOffset;

test('white balance: 6500 K is neutral, lower is warmer, higher is cooler', () => {
  assert.ok(Object.values(picture.whiteBalance(6500)).every((v) => v === 0));
  let prev = picture.whiteBalance(6500);
  for (let k = 6400; k >= 1000; k -= 100) {
    const wb = picture.whiteBalance(k);
    assert.ok(blueCut(wb) <= blueCut(prev) && greenCut(wb) <= greenCut(prev), `${k} K should be at least as warm as ${k + 100} K`);
    assert.strictEqual(wb.whiteBalanceRedGain, 0);
    prev = wb;
  }
  assert.ok(blueCut(picture.whiteBalance(1000)) < blueCut(picture.whiteBalance(2700)));
  const cool = picture.whiteBalance(10000);
  assert.ok(cool.whiteBalanceRedGain < 0 && cool.whiteBalanceBlueGain === 0);
  // Calibrated on the TV: 1000 K turns green and blue fully off (deep red).
  assert.deepStrictEqual(picture.whiteBalance(1000), {
    whiteBalanceRedGain: 0, whiteBalanceGreenGain: -50, whiteBalanceBlueGain: -50,
    whiteBalanceRedOffset: 0, whiteBalanceGreenOffset: -50, whiteBalanceBlueOffset: -50
  });
});

test('color temperature slider: neutral at 6500 K, W50 at 4000 K and below, C50 at 10000 K', () => {
  assert.strictEqual(picture.slider(6500), 0);
  assert.strictEqual(picture.slider(4000), -50);
  assert.strictEqual(picture.slider(1000), -50);
  assert.strictEqual(picture.slider(10000), 50);
  assert.ok(picture.slider(5000) < 0 && picture.slider(5000) > -50);
  assert.ok(picture.slider(8000) > 0 && picture.slider(8000) < 50);
});

test('night level fades in and out, and a cut-short fade turns around', () => {
  const c = cfg({ mode: 'manual', manualStart: '21:00', manualEnd: '07:00', fadeMinutes: 30 });
  const level = (iso, conf = c) => schedule.evaluate(conf, null, Date.parse(iso), 0).level;
  assert.strictEqual(level('2024-01-10T20:59:00Z'), 0);
  assert.strictEqual(level('2024-01-10T21:15:00Z'), 0.5);
  assert.strictEqual(level('2024-01-10T23:00:00Z'), 1);
  assert.strictEqual(level('2024-01-11T07:15:00Z'), 0.5);
  assert.strictEqual(level('2024-01-11T07:30:00Z'), 0);
  assert.strictEqual(level('2024-01-10T21:15:00Z', cfg({ mode: 'manual', fadeMinutes: 0 })), 1);

  // On for 10 minutes with a 60 minute fade: up to 1/6, then back down at the same rate.
  const short = cfg({ mode: 'manual', manualStart: '21:00', manualEnd: '21:10', fadeMinutes: 60 });
  assert.ok(Math.abs(level('2024-01-10T21:10:00Z', short) - 1 / 6) < 1e-9);
  assert.ok(Math.abs(level('2024-01-10T21:15:00Z', short) - 1 / 12) < 1e-9);
  assert.strictEqual(level('2024-01-10T21:30:00Z', short), 0);
});

test('settings key: input, dynamic range and picture mode from a settings reply', () => {
  // Shape of a real reply from webOS 4.4.
  const reply = { dimension: { input: 'default', _3dStatus: '2d', dynamicRange: 'sdr' }, settings: { pictureMode: 'vivid' } };
  assert.strictEqual(picture.settingsKey(reply), 'default/sdr/vivid');
  assert.strictEqual(picture.settingsKey({ settings: { pictureMode: 'cinema' } }), 'cinema');
  assert.strictEqual(picture.settingsKey({ settings: {} }), null);
  assert.strictEqual(picture.settingsKey(undefined), null);
});

test('config validation covers the night settings', () => {
  assert.strictEqual(schedule.validateConfig(cfg()), null);
  assert.match(schedule.validateConfig(cfg({ nightKelvin: 500 })), /nightKelvin/);
  assert.match(schedule.validateConfig(cfg({ nightBacklight: 101 })), /nightBacklight/);
  assert.match(schedule.validateConfig(cfg({ fadeMinutes: -5 })), /fadeMinutes/);
});

// Like webOS 4.4: the slider is a number, the other values strings.
const DAY = {
  pictureMode: 'standard', backlight: '80', colorTemperature: 20,
  whiteBalanceRedGain: '0', whiteBalanceGreenGain: '0', whiteBalanceBlueGain: '2',
  whiteBalanceRedOffset: '0', whiteBalanceGreenOffset: '0', whiteBalanceBlueOffset: '0'
};

/**
 * Fake TV that keeps picture settings per picture mode, and Eye Comfort Mode apart from
 * them. With `tv.range` set, replies carry a dimension like the real TV.
 */
function makeTv(config, startIso, state = null, setup = () => {}) {
  const tv = {
    mode: 'standard', eye: 'off', range: null,
    modes: {
      standard: Object.assign({}, DAY),
      hdr: Object.assign({}, DAY, { pictureMode: 'hdr', backlight: '100' }),
      expert1: Object.assign({}, DAY, { pictureMode: 'expert1', backlight: '60', colorTemperature: -10 })
    }
  };
  setup(tv);
  const notes = [];
  let now = Date.parse(startIso);
  let savedState = state;
  const c = new Controller({
    now: () => now,
    notify: (m) => notes.push(m),
    store: { load: () => config, save: () => {} },
    stateStore: { load: () => savedState, save: (d) => { savedState = JSON.parse(JSON.stringify(d)); } },
    luna: {
      call: (uri, params, cb) => {
        const cur = tv.modes[tv.mode];
        if (uri.endsWith('/getSystemSettings')) {
          const settings = {};
          for (const k of params.keys) if (k in cur) settings[k] = cur[k];
          return cb(null, tv.range ? { settings, dimension: { input: 'default', dynamicRange: tv.range } } : { settings });
        }
        const settings = Object.assign({}, params.settings);
        if ('eyeComfortMode' in settings) {
          tv.eye = settings.eyeComfortMode;
          delete settings.eyeComfortMode;
        }
        if ('pictureMode' in settings) {
          tv.mode = settings.pictureMode;
          return cb(null, {});
        }
        for (const k in settings) assert.strictEqual(typeof settings[k], typeof DAY[k], `${k} written as ${typeof settings[k]}`);
        Object.assign(cur, settings);
        cb(null, {});
      }
    }
  });
  c.setClock(0);
  return {
    c, tv, notes,
    state: () => savedState,
    at: (iso) => { now = Date.parse(iso); c.tick(); },
    pic: (mode = tv.mode) => tv.modes[mode]
  };
}

const NIGHT = { mode: 'manual', manualStart: '21:00', manualEnd: '07:00', colorEnabled: true, nightKelvin: 2000, dimEnabled: true, nightBacklight: 20, fadeMinutes: 30 };

test('picture fades to night values and back, and restores the day values', () => {
  const { c, at, pic, state } = makeTv(NIGHT, '2024-01-10T20:00:00Z');
  c.start();
  assert.strictEqual(pic().backlight, '80');
  assert.strictEqual(state(), null);

  at('2024-01-10T21:15:00Z');
  assert.strictEqual(pic().backlight, '50');
  assert.deepStrictEqual(state().snapshots.standard.backlight, 80);

  at('2024-01-10T22:00:00Z');
  const night = picture.whiteBalance(2000);
  assert.strictEqual(pic().backlight, '20');
  assert.strictEqual(pic().colorTemperature, -50);
  assert.strictEqual(pic().whiteBalanceBlueGain, String(night.whiteBalanceBlueGain));
  assert.strictEqual(pic().whiteBalanceGreenGain, String(night.whiteBalanceGreenGain));

  at('2024-01-11T07:30:00Z');
  assert.deepStrictEqual(pic(), DAY);
  assert.deepStrictEqual(state().snapshots, {});
});

test('day values survive a restart at night', () => {
  const first = makeTv(NIGHT, '2024-01-10T23:00:00Z');
  first.c.start();
  assert.strictEqual(first.pic().backlight, '20');

  // New service process: the TV now shows night values, the saved state has the day ones.
  const second = makeTv(NIGHT, '2024-01-11T06:00:00Z', first.state(), (tv) => { tv.modes.standard = Object.assign({}, first.pic()); });
  second.c.start();
  assert.strictEqual(second.pic().backlight, '20');
  second.at('2024-01-11T08:00:00Z');
  assert.deepStrictEqual(second.pic(), DAY);
});

test('day values are put back when the TV starts after night mode ended', () => {
  const first = makeTv(NIGHT, '2024-01-10T23:00:00Z');
  first.c.start();
  const second = makeTv(NIGHT, '2024-01-11T09:00:00Z', first.state(), (tv) => { tv.modes.standard = Object.assign({}, first.pic()); });
  assert.strictEqual(second.pic().backlight, '20');
  second.c.start();
  assert.deepStrictEqual(second.pic(), DAY);
  assert.deepStrictEqual(second.state().snapshots, {});
});

test('switching picture mode at night applies night values there too, and both are restored', () => {
  const { c, tv, at, pic } = makeTv(NIGHT, '2024-01-10T23:00:00Z');
  c.start();
  tv.mode = 'hdr';
  c.setPictureMode('hdr');
  assert.strictEqual(pic('hdr').backlight, '20');

  at('2024-01-11T08:00:00Z');
  assert.strictEqual(pic('hdr').backlight, '100');
  assert.strictEqual(pic('standard').backlight, '20'); // not the active mode, so left for now
  tv.mode = 'standard';
  c.setPictureMode('standard');
  assert.deepStrictEqual(pic('standard'), DAY);
});

test('turning the night features off at night puts the day picture back', () => {
  const { c, pic } = makeTv(NIGHT, '2024-01-10T23:00:00Z');
  c.start();
  assert.strictEqual(c.updateConfig({ colorEnabled: false }), null);
  assert.strictEqual(pic().whiteBalanceBlueGain, '2');
  assert.strictEqual(pic().backlight, '20');
  assert.strictEqual(c.updateConfig({ enabled: false }), null);
  assert.deepStrictEqual(pic(), DAY);
});

test('manual off holds through the morning and the evening fades in from day', () => {
  const { c, at, pic } = makeTv(NIGHT, '2024-01-10T23:00:00Z');
  c.start();
  c.setManual(false);
  assert.strictEqual(pic().backlight, '80');
  at('2024-01-11T07:10:00Z');
  assert.strictEqual(pic().backlight, '80');
  at('2024-01-11T21:15:00Z');
  assert.strictEqual(pic().backlight, '50');
});

test('notifications only on scheduled transitions, not at startup', () => {
  const { c, at, notes } = makeTv(Object.assign({}, NIGHT, { notify: true }), '2024-01-10T22:00:00Z');
  c.start();
  at('2024-01-11T07:00:00Z');
  at('2024-01-11T21:00:00Z');
  assert.deepStrictEqual(notes, ['NightLight: night mode turning off over 30 min', 'NightLight: night mode turning on over 30 min']);
});

test('eye comfort is turned off at night when only the picture features are used', () => {
  const { c, tv } = makeTv(Object.assign({}, NIGHT, { eyeComfort: false }), '2024-01-10T23:00:00Z', null, (t) => { t.eye = 'on'; });
  c.start();
  assert.strictEqual(tv.eye, 'off');
});

test('a TV without the picture keys reports it instead of writing', () => {
  const { c, tv } = makeTv(NIGHT, '2024-01-10T23:00:00Z', null, (t) => { t.modes.standard = { pictureMode: 'standard' }; });
  c.start();
  assert.deepStrictEqual(tv.modes.standard, { pictureMode: 'standard' });
  assert.match(c.status().night.error, /doesn't report/);
  assert.deepStrictEqual(c.status().night.supported, { color: false, backlight: false });
});

test('night picture mode: switches at night, fades there, restores and switches back in the morning', () => {
  const { c, tv, at, pic, state } = makeTv(Object.assign({}, NIGHT, { nightPictureMode: 'expert1' }), '2024-01-10T20:00:00Z', null, (t) => { t.range = 'sdr'; });
  c.start();
  assert.strictEqual(tv.mode, 'standard');

  at('2024-01-10T21:15:00Z');
  assert.strictEqual(tv.mode, 'expert1');
  assert.deepStrictEqual(state().modeSwitches, { 'default/sdr/': 'standard' });
  assert.strictEqual(pic('expert1').backlight, '40'); // halfway from expert1's 60 to 20
  assert.deepStrictEqual(pic('standard'), DAY);

  at('2024-01-11T07:30:00Z');
  assert.strictEqual(tv.mode, 'standard');
  assert.strictEqual(pic('expert1').backlight, '60');
  assert.strictEqual(pic('expert1').colorTemperature, -10);
  assert.deepStrictEqual(state(), { snapshots: {}, modeSwitches: {} });
});

test('night picture mode: a manual change at night is kept, and HDR is not switched', () => {
  const { c, tv, at } = makeTv(Object.assign({}, NIGHT, { nightPictureMode: 'expert1' }), '2024-01-10T23:00:00Z', null, (t) => { t.range = 'sdr'; });
  c.start();
  assert.strictEqual(tv.mode, 'expert1');
  tv.mode = 'standard';
  c.setPictureMode('default/sdr/standard');
  at('2024-01-10T23:30:00Z');
  assert.strictEqual(tv.mode, 'standard');

  tv.range = 'hdr';
  tv.mode = 'hdr';
  c.setPictureMode('default/hdr/hdr');
  assert.strictEqual(tv.mode, 'hdr');
  assert.strictEqual(tv.modes.hdr.backlight, '20');
});
