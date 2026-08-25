# building and releasing

## what CI runs

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), on every push to
`main`/`master` and every pull request into one:

| job | runs on | what |
| --- | --- | --- |
| `main process` | ubuntu + macOS 14 | `npm run lint`, `npm test` |
| `renderer` | ubuntu | lint, `npm run build` (type check + bundle), `npm test` |

both POSIX platforms, because the main suite asserts on process groups, signals
and executable bits — none of which exist on windows. see
[development.md](development.md#the-two-test-suites).

CI does not build installers. that is the release workflow, and it takes far too
long to run on a branch.

## building locally

```bash
npm run prepare:full   # icons + renderer bundle + yt-dlp engine
npm run dist           # an installer for this platform
```

`dist` runs `prepare:full` first (`predist`), so the two-step form is only useful
when you want to inspect what `prepare:full` produced. per-platform:

```bash
npm run dist:win     # NSIS installer + portable exe
npm run dist:mac     # dmg + zip (arm64)
npm run dist:linux   # AppImage + deb + tar.gz
```

each sets `BUILD_TARGET_PLATFORM` so `fetch:ytdlp` gets the right engine.

**ffmpeg and deno must already be in `binaries/`** — `prepare:full` fetches the
yt-dlp engine and nothing else. [`binaries/README.md`](../binaries/README.md).

**cross-platform builds mostly do not work.** you can produce a linux package on
macOS, but the mac dmg needs macOS and the windows installer wants windows (or
wine). the release workflow uses a runner per platform for this reason.

### `dist:*:safe`

```bash
npm run dist:win:safe
```

builds with `--publish never` and then runs
[`scripts/create-update-files.js`](../scripts/create-update-files.js), which
writes placeholder `latest*.yml` files for the platforms this machine did not
build. it exists so a locally assembled release does not leave the other two
platforms' installs 404ing on their channel file.

CI does not use it — the release workflow builds all three for real.

## cutting a release

### the button

Actions → **Bump version and release** → Run workflow. pick `patch`, `minor` or
`major` (or type an exact version), and it:

1. works out the next version and refuses if that tag already exists
2. bumps `package.json` and the lockfile, commits, tags `v<version>`, pushes
3. asks `build-release.yml` to build that tag

`dry_run` does step 1 and stops, which is the way to check what a bump would
produce.

step 3 is an explicit `gh workflow run` rather than relying on the tag push,
because **a tag pushed with `GITHUB_TOKEN` does not start another workflow** —
github blocks that to keep workflows from triggering each other in a loop. the
same trick is in
[`auto-release-on-merge.yml`](../.github/workflows/auto-release-on-merge.yml).

### by hand

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release 0.3.6"
git tag -a v0.3.6 -m "Release v0.3.6"
git push origin master --follow-tags
```

a tag pushed from a laptop *does* trigger `build-release.yml` — the restriction
above applies only to the workflow token.

### what the build does

[`build-release.yml`](../.github/workflows/build-release.yml), four jobs:

| job | runner | produces |
| --- | --- | --- |
| `build-macos` | macos-14 | `.dmg`, `.zip`, `latest-mac.yml` |
| `build-windows` | windows-latest | `Cliply.Setup.*.exe`, `latest.yml` |
| `build-linux` | ubuntu-latest | `.AppImage`, `.deb`, `.tar.gz`, `latest-linux.yml` |
| `create-release` | ubuntu-latest | the github release, with `SHA256SUMS.txt` |

each build job fetches its own ffmpeg and deno. mac and windows take theirs from
this repository's `binaries` release; linux takes the yt-dlp GPL build and the
official deno zip, because the `binaries` release only carries the other two.

`create-release` **fails the run if any of `latest.yml`, `latest-mac.yml` or
`latest-linux.yml` is missing.** a release short one feed file leaves that
platform's installs checking against nothing, and that failure is otherwise
silent for months — see [updates.md](updates.md#the-feed).

release notes are [`RELEASE_NOTES.md`](../.github/RELEASE_NOTES.md) — the
standing macOS gatekeeper explainer — with github's generated commit log
appended underneath.

### re-running a build

Actions → **Build Release** → Run workflow, with `tag` set to an existing tag.
the job deletes the release and recreates it with fresh assets; the tag itself is
left alone.

> [!WARNING]
> recreating a release replaces its assets. anyone whose updater had already read
> the old `latest*.yml` will be pointing at a checksum that no longer matches, so
> re-run a release only while it is fresh.

## the automated path

[`auto-release-on-merge.yml`](../.github/workflows/auto-release-on-merge.yml)
watches for merged PRs whose head branch starts with `auto-update/`. those are
the automated yt-dlp engine bumps: when one merges, it tags the version in
`package.json` and starts the build. nothing else triggers it.

## signing

there is none, on any platform, and it is a decision rather than an oversight —
certificates cost money and this is a small project.

what it costs:

- **macOS** — gatekeeper blocks the app on first launch. the release notes carry
  the `xattr -rd com.apple.quarantine` explainer, and mac cannot auto-update at
  all, because squirrel.mac verifies the signature before swapping the app
- **windows** — SmartScreen warns on first run. `verifyUpdateCodeSignature` is
  turned off in the app, because with no signature there is nothing to verify and
  leaving it on fails every update at the last step

adding signing means: a certificate in secrets, `CSC_LINK`/`CSC_KEY_PASSWORD`
(win) and notarization credentials (mac), removing the
`CSC_IDENTITY_AUTO_DISCOVERY: false` override, and flipping `canUpdate()` for
darwin in [`services/app-updater.js`](../src/main/services/app-updater.js). the
mac `.zip` is already published for exactly that day.

## the `binaries` release

there is a permanent release tagged `binaries` holding `ffmpeg`, `ffmpeg.exe`,
`deno` and `deno.exe` — the mac and windows builds the workflow downloads. it is
not a versioned release and does not appear in the releases list as latest.

updating one means uploading a new asset under that tag. the licensing that comes
with the ffmpeg ones is in [ffmpeg.md](ffmpeg.md) — a new build means a new
source archive in `third-party/ffmpeg/` to match it.
