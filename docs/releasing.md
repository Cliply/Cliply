# Builds, updates and releases

## Authoritative configuration

[`package.json`](../package.json) owns versions, targets, resources, hooks and npm
commands. [`after-pack.js`](../scripts/after-pack.js) verifies/prepares bundled
resources. The workflows below own automation; inspect them when changing this
guide. Publishing the desktop app is a separate action from pushing or merging
code. Do not run a publishing workflow to test a change.

| Workflow | Trigger and effect |
| --- | --- |
| [CI](../.github/workflows/ci.yml) | PRs and pushes to master run checks. Manual `package_check=true` also builds native installers with publishing disabled. |
| [Build Release](../.github/workflows/build-release.yml) | A pushed `v*` tag or manual dispatch builds and publishes an app release. Both triggers are publishing actions. |
| [Stage Linux helpers](../.github/workflows/stage-linux-helpers.yml) | Manual/reusable upstream verification. `publish=false` is the default; explicit publication adds Linux FFmpeg/Deno assets to the existing helper release. |
| [Build PO token payload](../.github/workflows/build-pot-payload.yml) | Manual native payload builds for selected platforms. `publish=false` is the default; publication writes to the helper release. |

## Native targets and verification

| Build runner | Target | Installer formats | Packaged resources for probes |
| --- | --- | --- | --- |
| `macos-26` | Apple Silicon ARM64 | DMG and ZIP | `dist/mac-arm64/Cliply.app/Contents/Resources` |
| `windows-latest` | x64 | NSIS installer and portable executable are built; release upload currently selects the Setup installer | `dist/win-unpacked/resources` |
| `ubuntu-24.04` | Linux x64 | AppImage and DEB | `dist/linux-unpacked/resources` |

Mac Intel, Linux ARM and Alpine/musl are not established supported app targets.
Linux verification covers Ubuntu 24.04 x64; do not turn that into a claim about
every distro. Package presence on a branch is not published download availability.
Check real release assets before changing download promises on the separate site.

Ordinary CI installs dependencies, lints main, tests main on POSIX and focused
recovery on Windows, tests/builds the renderer and exercises Electron startup,
preload and IPC. On Linux, Xvfb/D-Bus provide the source-tree GUI session.

Manual CI with `package_check=true` additionally fetches helpers/yt-dlp, builds
installers with `--publish never`, runs real packaged helper/media/recovery checks,
and validates aggregated update manifests against installer size/SHA512. Its token
is read-only. Keep helper staging inputs off for normal package validation.

Run only the probes needed for a helper or packaging change:

```sh
node scripts/verify-packaged-helpers.js --resources <resources-directory>
node scripts/smoke-media.js --resources <resources-directory>
node scripts/smoke-download-recovery.js --resources <resources-directory>
```

The resource argument must point to the actual native build, not a different
platform's tree. Media/recovery checks create local fixtures and clean their
temporary files. Ordinary mocked unit tests do not require these executables.

Local inspection's FFprobe is currently optional and has no shared release
assets. Its [staging record](../third-party/ffprobe/README.md) describes exact
candidates and remaining source/native checks. The resource filters include a
present FFprobe, and the helper verifier checks it when present. To require
local-inspection capability explicitly, use:

```sh
node scripts/verify-packaged-helpers.js --resources <actual-resources> --require-ffprobe
node scripts/smoke-local-media.js --ffprobe <actual-resources>/binaries/ffprobe --ffmpeg <actual-resources>/binaries/ffmpeg
```

Use `.exe` paths on Windows. The second command creates/deletes synthetic WAV
and H.264/AAC MP4 fixtures and checks inspection, source preservation and failure
drainage; it is not preview/export validation. Current downloader CI does not
require FFprobe yet, so its success alone cannot establish local-media support.
Do not publish candidates or dispatch native CI without the required task authorization.

The Linux package smoke script runs only on an ephemeral GitHub runner. It copies
the app into disposable test packages, installs/purges its DEB, checks X11/Wayland
launch, verifies updater selection and exercises AppImage filesystem replacement.
It loads the production ASAR/preload/renderer with production services isolated.
It does not establish full service startup, live update discovery, graphical DEB
authorization or live YouTube challenge success. Never install these test fixtures
over a person's app or extend these claims beyond what the checks exercise.

## What a publishing run does

Only perform this sequence when the user requests an actual app release:

1. Review the approved commit, package/lockfile version and intended version tag.
   Normal changes should already have passed CI; perform native package validation
   when the changed behavior warrants it.
2. Build Release checks out the requested ref, fetches platform helpers from the
   shared release and yt-dlp from upstream, builds the renderer, then packages each
   target with `--publish never`. The platform jobs do not individually publish.
3. Aggregation waits for all three native jobs, downloads installers and genuine
   latest*.yml files, and verifies their file references, sizes and SHA512.
4. With full git history available, it generates installation instructions, GitHub
   PR notes and linked non-merge commits. Generation failures stop before touching
   an existing release. Notes must describe the checked-out build.
5. The existing publication step deletes an existing release of the same tag, if
   present, then creates the GitHub release with installers, update metadata and
   generated notes, marking it latest. A rerun is therefore also a publishing
   action that can replace an existing release.

Do not use [`create-update-files.js`](../scripts/create-update-files.js) as a
substitute for genuine builder output. It can create placeholder metadata for
platforms not built. Legacy Mac/Windows `:safe` npm scripts still invoke it;
prefer the native CI package check or direct builder `--publish never` validation
when checking the actual release inputs.

## Release descriptions and previews

[`generate-release-notes.js`](../scripts/generate-release-notes.js) only generates
Markdown. It never creates a version tag or release. It selects the previous
published stable app version reachable from the target, excluding the current
tag, drafts, prereleases, failed-build-only tags and `binaries`. Existing tags
define their own target; an explicitly conflicting target is refused.

With git history and authenticated `gh`, preview to stdout:

```sh
node scripts/generate-release-notes.js --tag v0.4.1 --target HEAD
node scripts/generate-release-notes.js --tag v0.4.0 --target v0.4.0
```

These version numbers are examples, not instructions to publish them. A preview
uses the installation text in the current checkout. The static header is in
[RELEASE_NOTES.md](../.github/RELEASE_NOTES.md); GitHub PR categories are in
[release.yml](../.github/release.yml). Direct commits remain in the collapsed
commit list even when GitHub has no merged PR summary. Generated text normalizes
em dashes. No AI service or external summarization dependency is used.

## Three different update paths

- **App updates:** electron-updater consumes the GitHub app release and platform
  latest*.yml files. AppImage and DEB use different updater implementations.
- **Engine updates:** YtdlpUpdater fetches verified upstream yt-dlp archives into
  user data. Busy checks are deferred; bounded transient retries and shutdown
  guards live in `src/main/index.js` and `ytdlp-updater.js`.
- **Helper changes:** FFmpeg/Deno are packaged resources, not updated by the
  yt-dlp updater. The optional PO payload has its own versioned, checksum-pinned
  download. See the [binary guide](../binaries/README.md).

Keep required helper assets and matching PO hashes available before releasing
code that selects them. Do not replace another platform's files during a scoped
update. Remove only your temporary validation uploads after verification; retain
intended public helper assets and useful CI logs.
