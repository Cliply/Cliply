# Builds, updates and releases

## Authoritative configuration

[`package.json`](../package.json) owns versions, targets, resources, hooks and npm
commands. [`after-pack.js`](../scripts/after-pack.js) verifies/prepares bundled
resources. The workflows below own automation; inspect them when changing this
guide. Publishing the desktop app is a separate action from pushing or merging
code. Do not run a publishing workflow to test a change.

| Workflow | Trigger and effect |
| --- | --- |
| [CI](../.github/workflows/ci.yml) | PRs and pushes to master run checks. Manual `package_check=true` also builds native installers with publishing disabled. `ffprobe_candidate_check=true` instead runs only read-only native candidate checks. |
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

Local-media production acceptance is pending. No FFprobe asset is published;
the [source/staging record](../third-party/ffprobe/README.md) lists exact candidates
and unresolved source/native requirements. `published.json` intentionally has no
platform records. Ordinary downloader CI can pass without local-media support.

The prepared CI input `local_media_check=true` requires `package_check=true`.
It sets `CLIPLY_REQUIRE_FFPROBE=1`, requires the published pin during fetching,
fails packaging on a missing FFprobe, and runs packaged offline local-media UI
plus concurrent URL/local-export recovery checks. Run it on a reviewed, pushed
`local-media-tools` ref only when workflow/push authority and helper readiness
are established. Do not dispatch Build Release for validation.

Prepublication native evidence uses the separate read-only
[Validate FFprobe candidates](../.github/workflows/validate-ffprobe-candidate.yml)
workflow. An authorized actor must first review, commit and push the Stage 7
`local-media-tools` ref, then dispatch the existing **CI** workflow on that ref
with `ffprobe_candidate_check=true` and all other inputs false. This mode runs
only the read-only candidate workflow; it takes precedence over other modes.
The local reusable-workflow call uses the same commit as CI. Direct manual
dispatch of the new workflow (no inputs) is available only once its definition
exists on the default branch, as required by
[GitHub's dispatch rules](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatch).
Its macOS ARM64, Windows x64
and Ubuntu 24.04 x64 jobs acquire the exact `candidates.json` pins, stage/hash/check
them and build disposable native packages. Native version/license/libraries,
inspection, all four tools, cancel/crash recovery, packaged UI, normal-service
startup and URL recovery run before publication. Only small evidence is uploaded.
The workflow never writes `published.json`, publishes helpers or uses a latest
candidate. These hosts do not establish minimum-OS support.

The alternative **source-built** path is separate: dispatch existing CI with
`ffprobe_source_check=true` and all other inputs false after the reviewed ref is
authorized and pushed. It calls
[Validate source-built FFprobe](../.github/workflows/validate-ffprobe-source.yml)
at the same commit, builds the exact pinned FFmpeg-only design and validates
that executable in a disposable native app. Supplier mode retains priority if
both flags are set; ordinary app/helper-publication jobs are excluded in either
mode. By default only small evidence is uploaded. Target draft source packets with
reviewed runtime inputs are assembled and checked twice in scratch, then removed.
[Run 41513771327](https://github.com/Cliply/Cliply/actions/runs/41513771327) passed
all 12 required native checks on macOS 26 ARM64, Windows Server 2025 x64 and
Ubuntu 24.04 x64 at `07b3e9e`: packaged helpers, inspection, four export matrices,
UI/playback, normal startup, download recovery and URL media. Installed source
and license mappings passed on all three targets. This does not establish
minimum-OS or final production-installer acceptance.
See [source-build commands, notices and packet specification](../third-party/ffprobe/source-build.md).

Locally, `node scripts/validate-ffprobe-source.js --source <pinned-checkout>
--evidence <new-absolute-directory>` builds and exercises this whole path.
`validate-ffprobe-candidate.js --source-build <absolute-build> --evidence
<new-absolute-directory>` validates an already built, hash-bound artifact.
Neither command changes the production manifest or replaces project helpers.

Source CI may explicitly set `ffprobe_retain_artifacts=true` to retain a
successfully validated helper and its exact source/build/notice inputs for two-day
review. It never uploads installers or a shared release. Incomplete runtime/source
packets remain marked unapproved; failed validation creates no final candidate
artifact. See the source guide for checksum verification and cleanup. Retention
is off by default and ignored outside source-check mode.

The source check stages installed NOTICE/LGPL/source mapping in its
private package. Production after-pack requires the reviewed platform source
record/checksum whenever a production FFprobe pin exists, and binds the mapping
to the actual signed helper. Linux also requires pinned GCC/glibc runtime notices
and full GPLv3 text. Windows adds exact GCC/MinGW/winpthreads notices and the
additional GPL texts, with an archive-owner/hash check. These installed notice
paths passed native validation; the production manifest stays empty until final
distribution prerequisites pass. Windows runtime inventory updates must include the
[package/source review](../third-party/ffprobe/source-build.md#runtime-update-reviewed-4-november-2026)
and fresh source CI; supplier-candidate success cannot qualify changed source-built inputs.

With existing dependencies, built renderer and ordinary project helpers, the
same candidate checks can run locally:

```sh
node scripts/validate-ffprobe-candidate.js --evidence <new-absolute-evidence-directory>
```

`--archive <absolute-pinned-archive>` avoids downloading it again. The script
checks the same hashes either way, uses an owned project/package copy, preserves
the production manifest and removes its temporary executables/media on exit.
It requires a native desktop session (Linux: Xvfb/DBus is supported). Passing
candidate checks does not satisfy the separate corresponding-source gate.

For a private native package already containing verified candidate bytes:

```sh
node scripts/verify-packaged-helpers.js --resources <actual-resources> --require-ffprobe
node scripts/smoke-packaged-local-media.js --resources <actual-resources>
node scripts/smoke-download-recovery.js --resources <actual-resources> --local-media
node scripts/smoke-media.js --resources <actual-resources>
```

Use the native resources tree. The package UI check copies the app into an owned
temporary directory, runs its actual ASAR/preload/renderer and bundled helpers
without development overrides, then removes that copy and profile. Its test entry
isolates dialogs, telemetry, updates and unrelated external services. It checks
inspection, playback, all four exports in one session, route/file changes,
invalid and large files, EN/RU, theme and cleanup. It is not a substitute for a
normal installed-app startup/update check. `--idle-only` measures that isolated
unopened workspace for comparisons; it is not cold-start product benchmarking.
`--normal-startup` instead initializes real application services, settings,
cookie storage, engine seeding, IPC and the renderer in a fresh owned profile.
Analytics is opted out and external update scheduling is disabled. It records
startup/service time, three-second idle process metrics and normal quit drainage;
it neither clears OS caches nor proves installed-app/update behavior.
`--long-media` runs the UI actions on a generated five-minute, 720p H.264/AAC
file instead of the small fixture. For bounded POSIX helper CPU/RSS, temporary
disk and sequential range measurements, use
`node scripts/measure-local-media.js <new-absolute-directory> <ffmpeg> <ffprobe>`.
An optional fourth argument must be a disposable small mounted volume for the
real disk-full check. Never supply a normal user volume. Remove generated media
after retaining the JSON evidence; CPU samples are process-lifetime averages and
can miss short helper peaks.
On Linux, run the UI check under an available desktop session (CI uses Xvfb/DBus).
No sandbox bypass is added for packaged acceptance. On an ephemeral GitHub Linux
runner, the local-media smoke configures only its private app copy's genuine
Electron `chrome-sandbox` as root-owned mode 4755, matching an installed DEB.
It first checks private scratch ownership, regular files and byte identity with
the installed Electron dependency. Electron still launches as the runner user;
SUID is removed before cleanup. No AppArmor/sysctl or global sandbox setting is
changed, and neither `--no-sandbox` nor disabled user-namespace protections are
used. Local desktop runs do not perform this privileged CI setup.

The owner authorized new verified shared FFprobe assets and source records once
the recorded readiness conditions pass. That does not authorize unverified
candidates, replacement of existing assets, an app release or a workflow dispatch.
Minimum-OS evidence and final source/distribution, installer footprint and
installed-package gates remain outstanding.

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
## Local workspace development smoke

Build the renderer, then use the [verified FFprobe staging recipe](../third-party/ffprobe/README.md#reproduce-staging-without-publication).
On a native host with the existing project FFmpeg and the staged FFprobe, run:

```sh
CLIPLY_SMOKE_PREVIEW=1 \
CLIPLY_SMOKE_FFPROBE=<absolute-staged-ffprobe> \
CLIPLY_SMOKE_FFMPEG=<absolute-project-ffmpeg> \
npm run smoke:electron
```

This opt-in extension creates synthetic H.264/AAC MP4, PCM WAV and unsupported
FFV1 Matroska in an isolated temporary profile, exercises native playback/seek,
file switching, route return, background download list delivery and source
invalidation, and checks protocol ranges/HEAD/foreign contexts. It removes the
profile and media on exit. `CLIPLY_SMOKE_EVIDENCE=<directory>` additionally keeps
small UI captures and a JSON result. Plain `npm run smoke:electron` continues to
test the missing-helper path. These development checks do not establish native
package/helper support on other platforms or authorize any publication.

The trim (`CLIPLY_SMOKE_TRIM=1`) and combined
(`CLIPLY_SMOKE_INTEGRATION=1`) UI checks also exercise the resizable editor at
1200×800 and 800×600, English/Russian labels, light/dark presentation and keyboard
panel resizing without seeking. They assert preview visibility, inspector width,
absence of page overflow and separation of timeline/transport controls. The
packaged combined UI runner includes the same checks. With
`CLIPLY_SMOKE_EVIDENCE`, it retains layout captures and `workspace-layout.json`.
A fixed 784×535 client-area case reproduces the smaller content area inside a
minimum-size Windows window on every host. The preview and transport footer must
remain visible; panel minimums share the measured space after the resize handle.
