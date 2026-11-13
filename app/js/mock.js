/* In-browser stand-in for the Luna bus, used only when PalmServiceBridge is missing
 * (i.e. when index.html is opened on a desktop for UI work). */
window.MockLuna = (function () {
  var state = {
    returnValue: true,
    version: 'dev',
    elevated: false,
    autostartInstalled: false,
    config: {
      enabled: true, mode: 'sun', sunsetOffset: 0, sunriseOffset: 0,
      manualStart: '21:00', manualEnd: '07:00', locationSource: 'tv', location: null, autostart: true
    },
    clock: { offset: 60, timezone: 'Europe/Copenhagen', local: '13:15' },
    eyeComfort: { tv: false, desired: false, lastApply: null },
    schedule: {
      ok: true, desired: false,
      next: { on: true, local: '16:09', inMinutes: 174 },
      today: { sunrise: '07:41', sunset: '16:09', onAt: '16:09', offAt: '07:41', polar: null }
    },
    location: null
  };
  var TZ_LOC = { latitude: 55.6667, longitude: 12.5833, label: 'Copenhagen, DK' };

  function copy() {
    var c = state.config;
    var loc = c.locationSource === 'manual' ? c.location : TZ_LOC;
    state.location = {
      source: c.locationSource, latitude: loc.latitude, longitude: loc.longitude,
      label: loc.label, timezoneLocation: TZ_LOC, error: null
    };
    return JSON.parse(JSON.stringify(state));
  }

  function call(uri, params, cb) {
    var method = uri.split('/').pop();
    setTimeout(function () {
      if (method === 'setConfig') {
        for (var k in params.config) state.config[k] = params.config[k];
        state.autostartInstalled = state.elevated && state.config.autostart;
      } else if (method === 'setEyeComfort') {
        state.eyeComfort.tv = !!params.enabled;
      } else if (method === 'exec') {
        state.elevated = true;
        return cb({ returnValue: true, stdoutString: 'elevated' });
      }
      cb(copy());
    }, 150);
  }

  return { call: call };
})();
