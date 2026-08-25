# updates

cliply has two updaters. they are unrelated, they fail differently, and
confusing them is the single most common way to misread a bug report.

| | what it replaces | how often | where |
| --- | --- | --- | --- |
| **app updater** | cliply itself | 30s after launch, then every 12h | [`services/app-updater.js`](../src/main/services/app-updater.js) |
| **engine updater** | the bundled yt-dlp | 90s after launch, and on a failed download | [`services/ytdlp-updater.js`](../src/main/services/ytdlp-updater.js) |

the engine updater is the one that matters day to day: yt-dlp breaks whenever
youtube changes something, and the fix is always a newer yt-dlp. the app updater
ships our own changes.

---

# the engine updater

## why it exists at all

the official yt-dlp builds are pyinstaller **onedir** bundles, and those cannot
update themselves — `yt-dlp -U` refuses. so the whole flow is ours:

```
latest stable tag → platform zip + SHA2-256SUMS → checksum → staged unpack
                  → --version probe → atomic swap
```

every step before the swap is throwaway work. a failure anywhere leaves the
running engine exactly as it was, and the swap is a pair of renames inside one
directory — only a directory we have already watched start up is ever renamed
into place.

## seeding

the app bundle is read-only (and signed on macOS), so the engine that actually
runs is a copy under `userData`:

```
<userData>/engine/ytdlp/     ← the one that runs, and the one that gets replaced
<resources>/binaries/ytdlp/  ← the one that shipped, read-only
```

on first launch the bundled engine is copied into `userData`. that copy is the
entire reason self-updating is possible at all.

`seed()` runs before anything can need the engine and reports why it did what it
did: `missing`, `corrupt`, `bundled-newer`, `up-to-date`, `copy-failed`,
`corrupt-and-no-bundle`. the reason is telemetry (`engine_seeded`) because a
seed that keeps failing is invisible otherwise.

## the check

deferred 90 seconds after launch, and deliberately so: the update holds the
engine gate until it finishes, and the user's very first download would otherwise
queue behind it, which reads as a frozen app on a slow connection. if they are
busy when the timer fires, the check refuses (`busy`) and runs next launch.

## repair-on-failure

a download that fails with `updateMayFix` — an extraction-signature break, the
shape youtube changes produce — triggers one engine update and one retry
([`download-runner.js`](../src/main/services/download-runner.js)). exactly one:
a second failure is reported rather than retried.

this is why a download can appear to hang for a minute and then succeed.

## reading the telemetry

`engine_update_failed` is **not a failure count**. `update_reason` includes
`busy`, which means the check never ran. always split by `update_reason` — see
[analytics.md](analytics.md#engine_update_failed-is-not-a-failure-count).

---

# the app updater

electron-updater against the github releases feed. the interesting part is not
the download; it is deciding **which builds can update themselves** and **which
failures are worth interrupting somebody over**.

## which builds can update themselves

| build | can check | can install | why not |
| --- | --- | --- | --- |
| windows | yes | yes | |
| linux, AppImage | yes | yes | |
| linux, .deb or .tar.gz | yes | **no** | the deb belongs to the package manager, the tarball to whoever unpacked it |
| macOS | yes | **no** | squirrel.mac verifies the running app's code signature before swapping it, and these builds are unsigned |
| a `npm run dev` checkout | **no** | no | there is no installer to hand a new version to |

a build that cannot install one is still told there is one. that is the manual
path: `update:available` arrives with `requiresManualDownload: true` and the
dialog offers the releases page instead of a download button.

macOS additionally offers a "Learn Why" link, because on macOS the reason is code
signing specifically; on linux it is packaging, and that page would answer the
wrong question.

## which failures reach the user

this is the part that used to be wrong, and it was wrong in a way nobody could
see from the code: every failure raised an error toast, including on checks
nobody asked for.

two kinds of silence now, both deliberate:

- **a missing feed is not a failure.** every install sees a 404 for its channel
  file between a tag being pushed and its build finishing, and any platform with
  no published release sees it permanently. on a *manual* check this answers "you
  are up to date", which is true — there is no newer version, because there is no
  version. on a background check it says nothing at all.
- **a background failure is not news.** nobody asked, and the next check is
  twelve hours away.

both are logged. what changed is whether a toast interrupts somebody who was not
asking a question.

`AppUpdater` knows which is which because `check({manual: true})` is only ever
called from the ipc layer — the background schedule calls `check()` with no
arguments, and the ipc channel is the menu item and the renderer's buttons.

## the feed

`package.json` → `build.publish` points at `Cliply/Cliply` releases. each
platform reads its own file:

| platform | feed file | asset it names |
| --- | --- | --- |
| windows | `latest.yml` | `Cliply.Setup.<version>.exe` |
| macOS | `latest-mac.yml` | `Cliply-<version>-arm64.zip` — **the zip, not the dmg** |
| linux | `latest-linux.yml` | `Cliply-<version>-x64.AppImage` |

the mac feed names the zip and only the zip. a release that publishes the dmg
alone leaves that feed pointing at a file that 404s, which is invisible until the
day code signing is added and mac updates are expected to work — so the release
workflow uploads both, and **fails the job outright if any of the three feed
files is missing**
([`.github/workflows/build-release.yml`](../.github/workflows/build-release.yml)).

## installing

`autoDownload` and `autoInstallOnAppQuit` both start off. the second is flipped
on only once a download has actually landed, so a quit before that can never try
to install a half-file.

`install()` sets `global.isUpdating`, which the app's quit path reads: an
install-triggered quit still drains telemetry (it is the boundary between two
versions, which is the whole reason `previous_version` exists) but skips the
teardown that would fight an installer already waiting on this process to exit.

## if you are debugging it

- **nothing happens in dev.** `app.isPackaged` is false, so the updater schedules
  nothing and says so once in the log. that is correct, not broken.
- **"no update feed published for this platform yet"** in the log means a 404 on
  the channel file. check the release actually has `latest*.yml` attached.
- **an update is found but nothing downloads** — check `canUpdate()`. a .deb or a
  mac build will never download, by design.
- the timers are unref'd and cleared on quit, so nothing fires into a torn-down
  app.

## related

- [releasing.md](releasing.md) — how a release gets built and published
- [`tests/app-updater.test.js`](../tests/app-updater.test.js) — the decision
  table above, as assertions
