/* Minimal Luna bus client. Uses PalmServiceBridge (what webOSTV.js wraps); falls back
 * to a mock service when opened in a desktop browser for UI development. */
var Luna = (function () {
  var inflight = [];

  function call(uri, params, cb) {
    if (typeof window.PalmServiceBridge === 'undefined') {
      return window.MockLuna.call(uri, params || {}, cb);
    }
    var bridge = new window.PalmServiceBridge();
    // Keep a reference so the bridge is not garbage collected before replying.
    inflight.push(bridge);
    bridge.onservicecallback = function (msg) {
      var i = inflight.indexOf(bridge);
      if (i >= 0) inflight.splice(i, 1);
      var res;
      try {
        res = JSON.parse(msg);
      } catch (e) {
        res = { returnValue: false, errorText: 'Invalid response from ' + uri };
      }
      if (cb) cb(res);
    };
    bridge.call(uri, JSON.stringify(params || {}));
  }

  return { call: call };
})();
