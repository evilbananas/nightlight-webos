(function () {
  var SERVICE_ID = 'org.nightlightos.app.service';
  var SERVICE = 'luna://' + SERVICE_ID + '/';
  var HBCHANNEL_EXEC = 'luna://org.webosbrew.hbchannel.service/exec';
  var ELEVATE = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service';
  var POLL_MS = 5000;
  var SAVE_DELAY_MS = 600;

  var status = null;
  var draft = null; // config as shown in the UI, including unsaved edits
  var pending = {}; // unsaved config changes
  var saveTimer = null;
  var saving = false;
  var pollTimer = null;
  var serviceError = null;
  var renderedLocation = null;
  // Manual location picked in the UI but no coordinates saved yet (saved on "Use").
  var manualDraft = false;
  var elevateState = 'idle'; // 'idle' | 'running' | 'done' | 'failed'
  var elevateError = null;

  function $(id) { return document.getElementById(id); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function hasPending() { for (var k in pending) return true; return false; }

  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.classList.remove('show'); }, 3500);
  }

  // ---- formatting --------------------------------------------------------

  function duration(min) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (h && m) return h + ' h ' + m + ' min';
    if (h) return h + ' h';
    return m + ' min';
  }

  function formatOffset(min, event) {
    if (!min) return 'At ' + event;
    return duration(Math.abs(min)) + (min > 0 ? ' after ' : ' before ') + event;
  }

  function parseTime(s) {
    var p = String(s).split(':');
    return (+p[0]) * 60 + (+p[1]);
  }

  function formatTime(min) {
    min = ((min % 1440) + 1440) % 1440;
    var h = Math.floor(min / 60);
    var m = min % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function locationText(loc) {
    if (!loc || loc.latitude === null || loc.latitude === undefined) return 'Not set';
    var coords = loc.latitude.toFixed(2) + ', ' + loc.longitude.toFixed(2);
    var text = loc.label ? loc.label + ' (' + coords + ')' : coords;
    return loc.source ? text + (loc.source === 'tv' ? ' · TV timezone' : ' · manual') : text;
  }

  // ---- rendering ---------------------------------------------------------

  function renderStatus() {
    var stateEl = $('state');
    var alerts = [];

    if (!status) {
      stateEl.textContent = '—';
      stateEl.className = 'state';
      $('next').textContent = serviceError ? 'Service unavailable' : 'Connecting to service…';
      if (serviceError) alerts.push({ error: true, text: serviceError });
      renderAlerts(alerts);
      return;
    }

    var tv = status.eyeComfort.tv;
    stateEl.textContent = tv === true ? 'ON' : tv === false ? 'OFF' : 'Unknown';
    stateEl.className = 'state' + (tv === true ? ' on' : tv === false ? ' off' : '');

    var sched = status.schedule || {};
    var next;
    if (!status.config.enabled) next = 'Scheduler is off';
    else if (!sched.ok) next = 'Not scheduled';
    else if (sched.next) next = 'Turns ' + (sched.next.on ? 'on' : 'off') + ' at ' + sched.next.local + ' · in ' + duration(sched.next.inMinutes);
    else if (sched.today && sched.today.polar === 'night') next = 'Polar night: on all day';
    else if (sched.today && sched.today.polar === 'day') next = 'Midnight sun: off all day';
    else next = '';
    $('next').textContent = next;

    var today = sched.today || {};
    $('localTime').textContent = status.clock.local + (status.clock.timezone ? ' (' + status.clock.timezone + ')' : '');
    $('sunrise').textContent = today.sunrise || '—';
    $('sunset').textContent = today.sunset || '—';
    $('onAt').textContent = today.onAt || '—';
    $('offAt').textContent = today.offAt || '—';
    $('locationText').textContent = locationText(status.location);
    $('version').textContent = 'v' + status.version;

    if (!status.elevated && elevateState === 'failed') {
      alerts.push({ text: 'Could not get root access through Homebrew Channel (' + elevateError + '). The schedule works while the TV is on, but it won\'t start again after a reboot until you open this app.' });
    }
    if (status.config.enabled && sched.error) alerts.push({ error: true, text: sched.error });
    var la = status.eyeComfort.lastApply;
    if (la && !la.ok) alerts.push({ error: true, text: 'Could not change Eye Comfort Mode: ' + la.error });
    if (status.warning) alerts.push({ text: status.warning });
    renderAlerts(alerts);
  }

  function renderAlerts(alerts) {
    var box = $('alerts');
    box.innerHTML = '';
    alerts.forEach(function (a) {
      var div = document.createElement('div');
      div.className = 'alert' + (a.error ? ' error' : '');
      div.textContent = a.text;
      box.appendChild(div);
    });
  }

  function renderSettings() {
    if (!draft) return;
    qsa('.seg').forEach(function (seg) {
      var value = String(draft[seg.getAttribute('data-key')]);
      Array.prototype.forEach.call(seg.children, function (opt) {
        opt.classList.toggle('selected', opt.getAttribute('data-value') === value);
      });
    });
    qsa('.stepper').forEach(function (st) {
      var key = st.getAttribute('data-key');
      var text = st.getAttribute('data-kind') === 'offset'
        ? formatOffset(draft[key], st.getAttribute('data-event'))
        : draft[key];
      st.querySelector('.value').textContent = text;
    });
    qsa('.mode-sun').forEach(function (el) { el.classList.toggle('hidden', draft.mode !== 'sun'); });
    qsa('.mode-manual').forEach(function (el) { el.classList.toggle('hidden', draft.mode !== 'manual'); });
    qsa('.loc-tv').forEach(function (el) { el.classList.toggle('hidden', draft.locationSource !== 'tv'); });
    qsa('.loc-manual').forEach(function (el) { el.classList.toggle('hidden', draft.locationSource !== 'manual'); });

    var tzLoc = status && status.location ? status.location.timezoneLocation : null;
    $('tzLocationText').textContent = tzLoc
      ? locationText(tzLoc)
      : status && status.clock.timezone ? 'Unknown for ' + status.clock.timezone : '—';

    // Prefill manual coordinates from the timezone location when none are saved yet.
    var loc = draft.location || tzLoc;
    var locKey = loc ? loc.latitude + ',' + loc.longitude : '';
    if (locKey !== renderedLocation && document.activeElement !== $('lat') && document.activeElement !== $('lon')) {
      $('lat').value = loc ? loc.latitude.toFixed(4) : '';
      $('lon').value = loc ? loc.longitude.toFixed(4) : '';
      renderedLocation = locKey;
    }

    if (status) {
      $('rootText').textContent = status.elevated
        ? 'Yes' + (status.autostartInstalled ? ', starts at boot' : '')
        : elevateState === 'running' ? 'Requesting…' : 'No';
    }
    Nav.ensureFocus();
  }

  function render() {
    renderStatus();
    renderSettings();
  }

  // ---- service calls -----------------------------------------------------

  function onStatus(res, quiet) {
    if (!res.returnValue) {
      if (!quiet) toast(res.errorText || 'Request failed');
      if (!status) serviceError = res.errorText || 'Could not reach ' + SERVICE_ID;
      render();
      return false;
    }
    serviceError = null;
    status = res;
    if (!res.elevated && elevateState === 'idle') elevate();
    if (!hasPending() && !saving) {
      draft = clone(res.config);
      if (manualDraft) draft.locationSource = 'manual';
    }
    render();
    return true;
  }

  function refresh() {
    Luna.call(SERVICE + 'getStatus', {}, function (res) { onStatus(res, true); });
  }

  function startPolling() {
    stopPolling();
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function save() {
    if (!hasPending()) return;
    var patch = pending;
    pending = {};
    saving = true;
    Luna.call(SERVICE + 'setConfig', { config: patch }, function (res) {
      saving = false;
      if (!onStatus(res)) {
        // Roll the UI back to what the service has.
        if (status) draft = clone(status.config);
        render();
      } else {
        toast('Saved');
      }
    });
  }

  function setValue(key, value) {
    if (!draft) return;
    if (key === 'locationSource') {
      manualDraft = value === 'manual' && !draft.location;
      if (manualDraft) {
        draft.locationSource = value;
        renderSettings();
        toast('Enter coordinates and press Use');
        return;
      }
    }
    draft[key] = value;
    pending[key] = value;
    renderSettings();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
  }

  // ---- controls ----------------------------------------------------------

  function parseValue(v) {
    return v === 'true' ? true : v === 'false' ? false : v;
  }

  function adjust(el, dir) {
    if (!draft) return;
    var key = el.getAttribute('data-key');
    if (el.classList.contains('seg')) {
      var values = Array.prototype.map.call(el.children, function (c) { return c.getAttribute('data-value'); });
      var idx = values.indexOf(String(draft[key]));
      var nextIdx = dir === 0 ? (idx + 1) % values.length : Math.min(Math.max(idx + dir, 0), values.length - 1);
      if (nextIdx !== idx) setValue(key, parseValue(values[nextIdx]));
      return;
    }
    var step = +el.getAttribute('data-step') * (dir === 0 ? 1 : dir);
    if (el.getAttribute('data-kind') === 'offset') {
      var v = Math.min(Math.max(draft[key] + step, +el.getAttribute('data-min')), +el.getAttribute('data-max'));
      if (v !== draft[key]) setValue(key, v);
    } else {
      var other = key === 'manualStart' ? draft.manualEnd : draft.manualStart;
      var s = Math.abs(step);
      // Snap to the step grid so ‹/› lands on round times; start and end must differ.
      var t = Math.round((parseTime(draft[key]) + step) / s) * s;
      if (formatTime(t) === other) t += step;
      setValue(key, formatTime(t));
    }
  }

  function setEyeComfort(enabled) {
    Luna.call(SERVICE + 'setEyeComfort', { enabled: enabled }, function (res) {
      if (onStatus(res)) toast('Eye Comfort Mode turned ' + (enabled ? 'on' : 'off') + ' until the next scheduled change');
    });
  }

  function saveCoords() {
    var lat = parseFloat(String($('lat').value).replace(',', '.'));
    var lon = parseFloat(String($('lon').value).replace(',', '.'));
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
      toast('Latitude must be between -90 and 90, longitude between -180 and 180');
      return;
    }
    setValue('location', { latitude: lat, longitude: lon, label: null });
    setValue('locationSource', 'manual');
    manualDraft = false;
    renderedLocation = null;
    save();
  }

  // Requests root for the service through Homebrew Channel, once per app launch, the
  // same way other homebrew apps do. Nothing is shown on the TV unless it fails.
  function elevate() {
    elevateState = 'running';
    Luna.call(HBCHANNEL_EXEC, { command: ELEVATE + ' ' + SERVICE_ID }, function (res) {
      if (!res.returnValue) {
        elevateState = 'failed';
        elevateError = res.errorText || res.stderrString || 'exec failed';
        render();
        return;
      }
      // Restart the service so it relaunches with root privileges.
      Luna.call(SERVICE + 'restart', {}, function () {
        setTimeout(function () {
          elevateState = 'done';
          refresh();
        }, 1500);
      });
    });
  }

  function onClick(e) {
    var el = e.target;
    if (el.parentNode && el.parentNode.classList && el.parentNode.classList.contains('seg')) {
      setValue(el.parentNode.getAttribute('data-key'), parseValue(el.getAttribute('data-value')));
      return;
    }
    if (el.classList.contains('arrow')) {
      adjust(el.parentNode, +el.getAttribute('data-dir'));
      return;
    }
    switch (el.getAttribute('data-action')) {
      case 'turn-on': setEyeComfort(true); break;
      case 'turn-off': setEyeComfort(false); break;
      case 'save-coords': saveCoords(); break;
    }
  }

  function exitApp() {
    if (window.PalmSystem && window.PalmSystem.platformBack) window.PalmSystem.platformBack();
    else window.close();
  }

  function onVisibility() {
    if (document.hidden || document.webkitHidden) stopPolling();
    else startPolling();
  }

  Nav.init({ adjust: adjust, back: exitApp });
  document.addEventListener('click', onClick, false);
  document.addEventListener('visibilitychange', onVisibility, false);
  document.addEventListener('webkitvisibilitychange', onVisibility, false);
  document.addEventListener('webOSRelaunch', startPolling, false);
  render();
  startPolling();
})();
