# NightLight for webOS

Homebrew app for rooted LG TVs that turns Eye Comfort Mode (LG's blue light filter) on in the evening and off in
the morning. It can follow sunset and sunrise, optionally shifted by a number of minutes, or use fixed on and off
times.

It works out sunrise and sunset from the TV's timezone setting. The TV ships the standard tz database, and
`/usr/share/zoneinfo/zone.tab` lists coordinates for each timezone's main city. Since a timezone can cover a large
area, you can switch Location to Manual in the app and enter your latitude and longitude for better accuracy.

## Requirements

- A rooted LG webOS TV with [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel). Root is what
  lets the scheduler start by itself when the TV boots. On webOS 10.3.1 the service could change the setting without
  root; older firmware may be stricter.
- Node.js 18 or newer on your computer to build the package and run the tests.

## Installing

Download the `.ipk` from the [Releases](https://github.com/evilbananas/nightlight-webos/releases) page, or build it
yourself (see Building). Install it with `ares-install` or over SSH (see Installing over SSH), then open it once (see
First run).

## Building

```sh
npm install
npm test            # unit tests for the sun/schedule/controller logic
npm run package     # creates dist/org.nightlightos.app_<version>_all.ipk
```

You can install the `.ipk` with `ares-install` (`npm run deploy`, after setting the TV up with `ares-setup-device`).

### Releasing a new version

```sh
npm run set-version -- 0.2.0   # updates app/appinfo.json and both package.json files
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

Pushing the tag runs the Release workflow (`.github/workflows/release.yml`), which runs the tests, builds the
`.ipk` and publishes it as a GitHub release.

### First run

1. Open NightLight on the TV once. If the service isn't running as root yet, the app asks Homebrew Channel to run
   `elevate-service` for `org.nightlightos.app.service` and restarts the service. This happens in the background;
   there is nothing to confirm on the TV. The app only shows a message if it fails.
2. Once it runs as root, the service writes a boot script to
   `/var/lib/webosbrew/init.d/org-nightlightos-app-service` so the schedule keeps working after a reboot without
   opening the app. You can turn this off with the "Start at boot" setting.

At boot the script waits for the Luna bus to come up, then starts the service. Reinstalling or updating the app
drops the service's root permissions, so if the service reports it isn't root, the script runs `elevate-service`
again. If the app has been uninstalled, the script deletes itself.

### Installing over SSH

```sh
scp dist/org.nightlightos.app_<version>_all.ipk root@TV_IP:/tmp/nightlight.ipk
ssh root@TV_IP 'luna-send -i -f luna://com.webos.appInstallService/dev/install \
  "{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"/tmp/nightlight.ipk\",\"subscribe\":true}"'
# wait for "installed", then Ctrl+C. To elevate without opening the app:
ssh root@TV_IP '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service org.nightlightos.app.service \
  && luna-send -n 1 luna://org.nightlightos.app.service/start "{}"'
```

Tested on webOS 10.3.1 (Node 16).

## How it works

```
app/       Web UI in plain ES5, works with the remote's arrow keys and the Magic Remote pointer
service/   Node.js Luna service, also ES5 since older webOS versions ship old Node releases
  service.js          Luna methods, keep-alive, clock subscription, checks the schedule every 30 s
  lib/sun.js          Sunrise/sunset (NOAA approximation), handles polar day and night
  lib/schedule.js     Turns the config into on/off events, works out the current and next state
  lib/controller.js   Writes the TV setting when the schedule changes state
  lib/tzlocation.js   Looks up coordinates for the TV's timezone in zone.tab
  lib/autostart.js    Writes the Homebrew Channel boot script
tools/make-icons.js   Generates the app icons (npm run icons)
tools/set-version.js  Sets the version everywhere it appears (npm run set-version)
.github/workflows/    Release workflow, runs when a version tag is pushed
```

The TV setting is changed with:

```sh
luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings \
  '{"category":"picture","settings":{"eyeComfortMode":"on"}}'
```

The service only writes the setting when the schedule flips from off to on or back, plus once at startup and after
you change settings. If you turn Eye Comfort Mode on or off yourself, from the TV menu or the app's "Turn on now" and
"Turn off now" buttons, it stays that way until the next scheduled change.

Time and timezone come from `com.palm.systemservice/time/getSystemTime`, so daylight saving and timezone changes on
the TV are picked up without restarting anything.

Settings are saved to `/home/root/.config/nightlight-os/config.json`, or to the service directory if the service
isn't running as root.

### Service API

| Method | Payload | Description |
| --- | --- | --- |
| `getStatus` | `{}` | Config, TV state, today's times and the next change, location in use, clock, root and boot script status |
| `setConfig` | `{"config": {...}}` | Update some or all of `enabled`, `mode`, `sunsetOffset`, `sunriseOffset`, `manualStart`, `manualEnd`, `locationSource` (`tv` or `manual`), `location` (`{latitude, longitude}`), `autostart` |
| `setEyeComfort` | `{"enabled": true}` | Turn it on or off now; the schedule takes over again at the next change |
| `start` | `{}` | Starts the service (used by the boot script) |
| `restart` | `{}` | Exits the service; the next call starts it again |

Example: `luna-send -n 1 luna://org.nightlightos.app.service/getStatus '{}'`

## Troubleshooting

If the app says it could not change Eye Comfort Mode, check that your model has the setting:

```sh
luna-send -n 1 luna://com.webos.settingsservice/getSystemSettings '{"category":"picture","keys":["eyeComfortMode"]}'
```

Service logs: `journalctl | grep nightlight`, or `/var/log/messages` on older firmware.

To work on the UI, open `app/index.html` in a desktop browser. Without a TV it talks to a fake service in
`app/js/mock.js`.