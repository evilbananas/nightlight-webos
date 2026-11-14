# Contributing

This covers building, testing and releasing NightLight. For installing and using the app, see the
[README](README.md).

## Project layout

- `app/` is the web app shown on the TV.
- `service/` is the background service that switches Eye Comfort Mode on schedule.
- `test/` has the tests for the scheduling code, run with Node's built-in test runner.
- `tools/` has scripts for icons, versioning and the Homebrew Channel repo.

## Setup

You need Node.js 22, which is what CI uses. Install the dependencies:

```sh
npm ci
```

This also installs the webOS TV CLI (`ares-*` commands) locally, so the npm scripts below work without a global
install. To run the CLI directly, use `npx`, for example `npx ares-setup-device`.

## Testing

```sh
npm test
```

CI runs the tests and builds the package on every push to `main` and on pull requests.

To work on the UI without a TV, open `app/index.html` in a desktop browser. When there's no Luna bus, the app uses
the stand-in in `app/js/mock.js`.

## Building and installing on a TV

Register your TV once with `npx ares-setup-device`. See LG's
[CLI guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide) for details. Then:

```sh
npm run package   # builds dist/org.nightlightwebos.app_<version>_all.ipk
npm run deploy    # installs the .ipk for the current version on the TV
npm run launch    # opens the app on the TV
```
To regenerate the icons in `app/`, run `npm run icons`.

## Releasing

Commit everything first, then run:

```sh
npm version 0.2.0
```

You can also use `npm version patch`, `minor` or `major` to bump from the current version. The command:

1. Runs the tests and stops if any fail.
2. Sets the version in `package.json`, `package-lock.json`, `app/appinfo.json` and `service/package.json`.
3. Commits the change as "Bump version to v0.2.0" and creates the tag `v0.2.0`.
4. Pushes the commit and the tag to GitHub.

The tag starts the [release workflow](.github/workflows/release.yml), which:

- checks that the tag matches the version in `app/appinfo.json`
- runs the tests and builds the `.ipk`
- creates a GitHub release with the `.ipk` attached
- rebuilds `repo.json` and `icon.png` on the `gh-pages` branch, which is the repository Homebrew Channel reads
