'use strict';
var fs = require('fs');

// Homebrew Channel runs every executable in this directory at boot (rooted TVs only).
var INIT_DIR = '/var/lib/webosbrew/init.d';
var ELEVATE = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service';

function scriptPath(serviceId) {
  // run-parts skips file names containing dots.
  return INIT_DIR + '/' + serviceId.replace(/[^A-Za-z0-9_-]/g, '-');
}

function script(serviceId) {
  var file = scriptPath(serviceId);
  return [
    '#!/bin/sh',
    '# Installed by NightLight OS: starts the Eye Comfort scheduler at boot.',
    'SERVICE=' + serviceId,
    'output=$(luna-send -n 1 "luna://$SERVICE/start" \'{}\')',
    '',
    '# Bus not ready yet: retry in the background.',
    'if echo "$output" | grep -q "status unknown"; then',
    '  (sleep 2; ' + file + ') &',
    '  exit',
    'fi',
    '',
    '# App was uninstalled: remove this script.',
    'if echo "$output" | grep -q "Service does not exist"; then',
    '  rm -f ' + file,
    '  exit',
    'fi',
    '',
    '# Elevation can be lost after an app update: re-elevate and restart.',
    'if echo "$output" | grep -q \'"elevated":false\' && [ -x "' + ELEVATE + '" ]; then',
    '  "' + ELEVATE + '" "$SERVICE" >/dev/null 2>&1',
    '  luna-send -n 1 "luna://$SERVICE/restart" \'{}\' >/dev/null 2>&1',
    '  sleep 1',
    '  luna-send -n 1 "luna://$SERVICE/start" \'{}\' >/dev/null 2>&1',
    'fi',
    ''
  ].join('\n');
}

function isInstalled(serviceId) {
  return fs.existsSync(scriptPath(serviceId));
}

function install(serviceId) {
  if (!fs.existsSync(INIT_DIR)) throw new Error(INIT_DIR + ' not found. Is Homebrew Channel installed and the TV rooted?');
  var file = scriptPath(serviceId);
  var content = script(serviceId);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.writeFileSync(file, content);
  fs.chmodSync(file, parseInt('755', 8));
}

function uninstall(serviceId) {
  var file = scriptPath(serviceId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { install: install, uninstall: uninstall, isInstalled: isInstalled, ELEVATE: ELEVATE };
