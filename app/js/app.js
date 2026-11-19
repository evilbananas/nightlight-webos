(function () {
  // Also in service/package.json (name) and service/lib/autostart.js (ELEVATE).
  var SERVICE_ID = 'org.nightlightwebos.app.service';
  var SERVICE = 'luna://' + SERVICE_ID + '/';
  var HBCHANNEL_EXEC = 'luna://org.webosbrew.hbchannel.service/exec';
  var SYSTEM_PREFS = 'luna://com.palm.systemservice/getPreferences';
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
  var timeFormat = '24h'; // from the TV's clock setting; '24h' | '12h'

  function $(id) { return document.getElementById(id); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function hasPending() { for (var k in pending) return true; return false; }

  function toast(text) {
    var bar = $('statusBar');
    $('toast').textContent = text;
    bar.classList.add('toasting');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () {
      bar.classList.remove('toasting');
      // The status text was hidden, so re-measure it in case it needs to scroll.
      var el = $('statusText');
      var text = el.getAttribute('data-text');
      el.removeAttribute('data-text');
      setStatusText(text || '');
    }, 3500);
  }

  // Status text too long for the footer scrolls to the end, pauses, and jumps back. Unchanged text
  // is skipped so the 5 s poll doesn't restart a running scroll. Speed is in rem so it looks the
  // same at any resolution, since the layout scales with the viewport.
  var SCROLL_REM_PER_S = 2;
  var SCROLL_PAUSE_MS = 2500;

  function setStatusText(text) {
    var el = $('statusText');
    if (el.getAttribute('data-text') === text) return;
    el.setAttribute('data-text', text);
    clearTimeout(el.scrollTimer);
    el.classList.remove('scrolling');
    el.textContent = '';
    var span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);

    var dist = el.scrollWidth - el.clientWidth;
    if (dist <= 0) return;
    el.classList.add('scrolling');
    var remPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    var ms = Math.round(dist / (SCROLL_REM_PER_S * remPx) * 1000);
    function move(x, dur) {
      span.style.webkitTransition = dur ? '-webkit-transform ' + dur + 'ms linear' : 'none';
      span.style.transition = dur ? 'transform ' + dur + 'ms linear' : 'none';
      span.style.webkitTransform = span.style.transform = 'translateX(' + x + 'px)';
    }
    (function loop() {
      move(0, 0);
      el.scrollTimer = setTimeout(function () {
        move(-dist, ms);
        el.scrollTimer = setTimeout(loop, ms + SCROLL_PAUSE_MS);
      }, SCROLL_PAUSE_MS);
    })();
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

  // Times stay HH:MM everywhere else; this only changes what's shown.
  function displayTime(s) {
    if (!s) return '—';
    var m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m || timeFormat !== '12h') return s;
    var h = +m[1];
    return (h % 12 || 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  function coordsText(loc) {
    return loc.latitude.toFixed(4) + ', ' + loc.longitude.toFixed(4);
  }

  function hasCoords(loc) {
    return loc && loc.latitude !== null && loc.latitude !== undefined;
  }

  // ---- rendering ---------------------------------------------------------

  function setBadge(text, kind) {
    var el = $('badge');
    el.textContent = text || '';
    el.className = 'badge' + (kind ? ' ' + kind : '') + (text ? '' : ' hidden');
  }

  function renderStatus() {
    var stateEl = $('state');

    if (!status) {
      stateEl.textContent = '—';
      stateEl.className = 'state';
      $('next').textContent = serviceError ? 'Service unavailable' : 'Connecting to service…';
      setBadge(null);
      renderStatusBar(serviceError ? 'error' : 'idle',
        serviceError ? 'Service unavailable: ' + serviceError : 'Connecting to service…');
      return;
    }

    var tv = status.eyeComfort.tv;
    stateEl.textContent = tv === true ? 'ON' : tv === false ? 'OFF' : '?';
    stateEl.className = 'state' + (tv === true ? ' on' : tv === false ? ' off' : '');
    $('toggleBtn').textContent = tv === true ? 'Turn off now' : 'Turn on now';

    var sched = status.schedule || {};
    var ready = status.configAvailable !== false;
    var la = status.eyeComfort.lastApply;
    var next;
    if (!ready) next = 'Waiting for root access…';
    else if (!status.config.enabled) next = 'None, scheduler is off';
    else if (!sched.ok) next = 'Not scheduled';
    else if (sched.next) next = (sched.next.on ? 'On' : 'Off') + ' at ' + displayTime(sched.next.local) + ' · in ' + duration(sched.next.inMinutes);
    else if (sched.today && sched.today.polar === 'night') next = 'None, polar night: on all day';
    else if (sched.today && sched.today.polar === 'day') next = 'None, midnight sun: off all day';
    else next = '—';
    $('next').textContent = next;

    if (!ready) setBadge(null);
    else if (!status.config.enabled) setBadge('Scheduler off', 'muted');
    else if (la && la.ok && la.reason === 'manual' && tv === la.on) setBadge('Manual');
    else if (sched.ok) setBadge('Scheduled');
    else setBadge(null);

    var today = sched.today || {};
    $('onAt').textContent = ready && sched.ok ? displayTime(today.onAt) : '—';
    $('offAt').textContent = ready && sched.ok ? displayTime(today.offAt) : '—';

    var loc = status.location;
    if (ready && hasCoords(loc)) {
      $('locationName').textContent = loc.label || coordsText(loc);
      $('locationDetail').textContent = (loc.label ? coordsText(loc) + ' · ' : '') + (loc.source === 'tv' ? 'TV timezone' : 'Manual coordinates');
    } else {
      $('locationName').textContent = ready && loc && loc.error ? 'Not set' : '—';
      $('locationDetail').textContent = ready && loc && loc.error ? loc.error : '';
    }
    $('version').textContent = 'v' + status.version;

    var problems = [];
    var level = 'ok';
    function problem(text, isError) {
      problems.push(text);
      if (isError) level = 'error';
      else if (level !== 'error') level = 'warn';
    }
    if (!status.elevated && elevateState === 'failed') {
      problem('No root access, so the schedule won\'t start after a reboot until you open this app. Homebrew Channel said: ' + elevateError);
    }
    if (ready && status.config.enabled && sched.error) problem(sched.error, true);
    if (la && !la.ok) problem('Could not change Eye Comfort Mode: ' + la.error, true);
    if (status.warning) problem(status.warning);

    if (problems.length) {
      renderStatusBar(level, problems.join(' · '));
      return;
    }

    if (!status.elevated) {
      level = 'warn';
      renderStatusBar(level, elevateState === 'running' ? 'Requesting root access…' : 'No root access');
      return;
    }
    renderStatusBar(level, 'Running');
  }

  function renderStatusBar(level, text) {
    var bar = $('statusBar');
    ['idle', 'ok', 'warn', 'error'].forEach(function (l) { bar.classList.toggle(l, l === level); });
    setStatusText(text);
  }

  function renderSettings() {
    $('settings').classList.toggle('loading', !draft);
    if (!draft) {
      Nav.ensureFocus();
      return;
    }
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
        : displayTime(draft[key]);
      st.querySelector('.value').textContent = text;
    });
    qsa('.mode-sun').forEach(function (el) { el.classList.toggle('hidden', draft.mode !== 'sun'); });
    qsa('.mode-manual').forEach(function (el) { el.classList.toggle('hidden', draft.mode !== 'manual'); });
    qsa('.loc-tv').forEach(function (el) { el.classList.toggle('hidden', draft.locationSource !== 'tv'); });
    qsa('.loc-manual').forEach(function (el) { el.classList.toggle('hidden', draft.locationSource !== 'manual'); });

    var tzLoc = status && status.location ? status.location.timezoneLocation : null;
    $('tzLocationName').textContent = tzLoc
      ? tzLoc.label || coordsText(tzLoc)
      : status && status.clock.timezone ? 'Unknown for ' + status.clock.timezone : '—';
    $('tzLocationDetail').textContent = tzLoc && tzLoc.label ? coordsText(tzLoc) : '';

    // Prefill manual coordinates from the timezone location when none are saved yet.
    var loc = draft.location || tzLoc;
    var locKey = loc ? loc.latitude + ',' + loc.longitude : '';
    if (locKey !== renderedLocation && document.activeElement !== $('lat') && document.activeElement !== $('lon')) {
      $('lat').value = loc ? loc.latitude.toFixed(4) : '';
      $('lon').value = loc ? loc.longitude.toFixed(4) : '';
      renderedLocation = locKey;
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
      draft = res.configAvailable === false ? null : clone(res.config);
      if (draft && manualDraft) draft.locationSource = 'manual';
    }
    render();
    return true;
  }

  function refresh() {
    Luna.call(SERVICE + 'getStatus', {}, function (res) { onStatus(res, true); });
  }

  function loadTimeFormat() {
    Luna.call(SYSTEM_PREFS, { keys: ['timeFormat'] }, function (res) {
      if (!res.returnValue || (res.timeFormat !== 'HH12' && res.timeFormat !== 'HH24')) return;
      var next = res.timeFormat === 'HH12' ? '12h' : '24h';
      if (next === timeFormat) return;
      timeFormat = next;
      render();
    });
  }

  function startPolling() {
    stopPolling();
    loadTimeFormat();
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
        if (status) draft = status.configAvailable === false ? null : clone(status.config);
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
      var err = res.returnValue ? null : res.errorText || res.stderrString || 'exec failed';
      // elevate-service can fail on its final service rescan after it has already
      // patched the service, so restart and check before reporting a failure.
      Luna.call(SERVICE + 'restart', {}, function () {
        setTimeout(function () {
          Luna.call(SERVICE + 'getStatus', {}, function (st) {
            if (err && !(st.returnValue && st.elevated)) {
              elevateState = 'failed';
              elevateError = shorten(err);
            } else {
              elevateState = 'done';
            }
            onStatus(st, true);
          });
        }, 1500);
      });
    });
  }

  // First line only, so a stack trace from the exec doesn't fill the screen.
  function shorten(text) {
    var line = String(text).split('\n')[0].trim();
    return line.length > 120 ? line.slice(0, 117) + '…' : line;
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
      case 'toggle': if (status) setEyeComfort(status.eyeComfort.tv !== true); break;
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
