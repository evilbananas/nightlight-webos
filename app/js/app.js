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

  function formatKelvin(k) {
    var name = k < 2000 ? 'candle' : k < 3500 ? 'warm' : k < 5000 ? 'neutral' : k <= 6500 ? 'daylight' : 'cool blue';
    return k + ' K · ' + name;
  }

  function formatStepper(el, value) {
    switch (el.getAttribute('data-kind')) {
      case 'offset': return formatOffset(value, el.getAttribute('data-event'));
      case 'kelvin': return formatKelvin(value);
      case 'percent': return value + ' %';
      default: return displayTime(value);
    }
  }

  var PICTURE_MODES = {
    off: { name: null, desc: 'Keeps your picture mode. In Vivid and Standard the color filter can only go as warm as LG\'s warmest Color Temperature setting.' },
    eco: { name: 'Eco', desc: 'Switches to Eco at night, which is dimmer and saves power, and back to your picture mode in the morning.' },
    cinema: { name: 'Cinema', desc: 'Switches to Cinema at night, which is warmer and darker than Vivid, and back to your picture mode in the morning.' },
    expert1: { name: 'Expert 1', desc: 'Switches to Expert (bright room) at night. Expert modes allow the full color range, down to deep red.' },
    expert2: { name: 'Expert 2', desc: 'Switches to Expert (dark room) at night. Expert modes allow the full color range, down to deep red.' }
  };

  /** Black-body color of `k` kelvin as [r, g, b] 0..255 (same curve fit as service/lib/picture.js). */
  function kelvinRgb(k) {
    var t = k / 100;
    var r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    var g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    var b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [r, g, b].map(function (v) { return Math.round(Math.min(Math.max(v, 0), 255)); });
  }

  /** Roughly how the night picture looks: its color, darkened by the backlight setting. */
  function nightColor(cfg) {
    var rgb = cfg.colorEnabled ? kelvinRgb(cfg.nightKelvin) : [251, 247, 255];
    // Damped, so a dim night still reads as warm light rather than mud.
    var light = cfg.dimEnabled ? 0.6 + 0.4 * cfg.nightBacklight / 100 : 1;
    return 'rgb(' + rgb.map(function (v) { return Math.round(v * light); }).join(',') + ')';
  }

  /** Shows the focused setting's explanation in the help strip, which is hidden while focus is outside the settings. */
  function showHelp(el) {
    var row = el;
    while (row && !(row.classList && row.classList.contains('nav-row'))) row = row.parentNode;
    var desc = row && row.querySelector('.desc');
    $('help').classList.toggle('collapsed', !desc);
    if (!desc) return;
    $('helpLabel').textContent = row.querySelector('.label').textContent;
    $('helpText').textContent = desc.textContent;
  }

  function usesPicture(cfg) {
    return cfg.colorEnabled || cfg.dimEnabled || cfg.nightPictureMode !== 'off';
  }

  /** Whether night mode is on: the night level with a picture feature on, else Eye Comfort Mode. Null if unknown. */
  function nightOn() {
    if (!status) return null;
    if (usesPicture(status.config) && status.night) return status.night.level > 0;
    var tv = status.eyeComfort.tv;
    return tv === true || tv === false ? tv : null;
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

    var cfg = status.config;
    var night = status.night || {};
    var on = nightOn();
    // With a picture feature on, show the night level (it fades); otherwise Eye Comfort Mode itself.
    if (usesPicture(cfg) && on !== null) {
      var level = night.level || 0;
      stateEl.textContent = level >= 1 ? 'ON' : level <= 0 ? 'OFF' : Math.round(level * 100) + ' %';
    } else {
      stateEl.textContent = on === true ? 'ON' : on === false ? 'OFF' : '?';
    }
    stateEl.className = 'state' + (on === true ? ' on' : on === false ? ' off' : '');
    $('toggleBtn').textContent = on === true ? 'Turn off now' : 'Turn on now';

    var showLight = cfg.colorEnabled || cfg.dimEnabled;
    $('lightSection').classList.toggle('hidden', !showLight);
    if (showLight) {
      $('lightBar').style.background = 'linear-gradient(to right, #fbf7ff, ' + nightColor(cfg) + ')';
      $('lightMarker').style.left = Math.round((night.level || 0) * 100) + '%';
      var parts = [];
      if (PICTURE_MODES[cfg.nightPictureMode] && PICTURE_MODES[cfg.nightPictureMode].name) parts.push(PICTURE_MODES[cfg.nightPictureMode].name);
      if (cfg.colorEnabled) parts.push(cfg.nightKelvin + ' K');
      if (cfg.dimEnabled) parts.push('Backlight ' + cfg.nightBacklight + ' %');
      $('lightNight').textContent = 'Night · ' + parts.join(' · ');
    }

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
    else if (night.manual) setBadge('Manual');
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
    var sup = night.supported;
    if (ready && sup && cfg.colorEnabled && !sup.color) problem('This TV doesn\'t expose color temperature or white balance settings, so the color filter can\'t work.', true);
    if (ready && sup && cfg.dimEnabled && !sup.backlight) problem('This TV doesn\'t expose a backlight setting, so it can\'t be dimmed.', true);
    if (night.error) problem(night.error, true);
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
      st.querySelector('.value').textContent = formatStepper(st, draft[st.getAttribute('data-key')]);
    });
    qsa('.slider').forEach(function (sl) {
      var value = draft[sl.getAttribute('data-key')];
      var min = +sl.getAttribute('data-min');
      var pct = (value - min) / (+sl.getAttribute('data-max') - min) * 100 + '%';
      sl.querySelector('.value').textContent = formatStepper(sl, value);
      sl.querySelector('.thumb').style.left = pct;
      sl.querySelector('.fill').style.width = pct;
    });
    qsa('[data-show-if]').forEach(function (el) { el.classList.toggle('hidden', !draft[el.getAttribute('data-show-if')]); });
    var pm = PICTURE_MODES[draft.nightPictureMode];
    $('pictureModeDesc').textContent = pm ? pm.desc : '';
    if (Nav.current()) showHelp(Nav.current());
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
    if (v === 'true' || v === 'false') return v === 'true';
    return /^-?\d+(\.\d+)?$/.test(v) ? +v : v;
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
    if (el.getAttribute('data-kind') !== 'time') {
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
      if (onStatus(res)) toast('Night mode turned ' + (enabled ? 'on' : 'off') + ' until the next scheduled change');
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
    var slider = el;
    while (slider && !(slider.classList && slider.classList.contains('slider'))) slider = slider.parentNode;
    if (slider && draft) {
      // Magic Remote: jump to the clicked point on the track, snapped to the step.
      var rect = slider.querySelector('.track').getBoundingClientRect();
      var min = +slider.getAttribute('data-min');
      var max = +slider.getAttribute('data-max');
      var step = +slider.getAttribute('data-step');
      var frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      var v = Math.round((min + frac * (max - min)) / step) * step;
      if (v !== draft[slider.getAttribute('data-key')]) setValue(slider.getAttribute('data-key'), v);
      return;
    }
    switch (el.getAttribute('data-action')) {
      case 'toggle': if (status) setEyeComfort(nightOn() !== true); break;
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

  Nav.init({ adjust: adjust, back: exitApp, focus: showHelp });
  document.addEventListener('click', onClick, false);
  document.addEventListener('visibilitychange', onVisibility, false);
  document.addEventListener('webkitvisibilitychange', onVisibility, false);
  document.addEventListener('webOSRelaunch', startPolling, false);
  render();
  startPolling();
})();
