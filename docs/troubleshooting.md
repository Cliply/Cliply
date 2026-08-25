# troubleshooting

what actually goes wrong, what causes it, and where to look. the user-facing
wording for each of these lives in `ERROR_METADATA`
([`services/ytdlp-engine.js`](../src/main/services/ytdlp-engine.js)); the
categories are [`utils/error-taxonomy.js`](../src/main/utils/error-taxonomy.js).

## first, three things to check

**Help → System Health** — engine path and version, whether ffmpeg and deno were
found, how many downloads are running. most "it does not work" reports are one
of these being missing.

**Tools → Video engine** — which yt-dlp this install is actually running. this is
read from the engine rather than from telemetry, so it stays right for people who
switched telemetry off. "version unknown" means the probe failed, which is itself
the answer.

**the Report button on a failure toast** — it stages the redacted stderr tail, the
error category and the environment into a prefilled github issue. that is far
more useful than a screenshot.

---

## downloads

### "YouTube asked us to confirm you're not a bot" — `BOT_DETECTION`

youtube is rate-limiting the ip, not the app. import cookies from Settings; a
signed-in session usually clears it. cookies live at
`~/.config/app-data-7c4f/cookies/` and `cookies:test` probes real videos to say
whether they still work.

if the jar was imported but is refused, the status message says which way it is
unusable — no cookies, no *youtube* cookies, or expired ones.

### "YouTube changed something the downloader needs to catch up with" — `EXTRACTION_FAILED`

the common one, and mostly self-healing: this failure triggers one engine update
and one retry automatically
([updates.md](updates.md#repair-on-failure)). if it survives that, the newest
yt-dlp does not have the fix yet either.

### "The video processor is missing" — `FFMPEG_MISSING`

no ffmpeg in `binaries/<platform>/`. only some downloads need it — a pre-muxed
360p file will succeed while a 1080p merge fails — which is why this can look
intermittent. see [ffmpeg.md](ffmpeg.md).

### "A component the downloader needs is missing" — `JS_RUNTIME_MISSING`

no deno. yt-dlp has needed a javascript runtime for youtube's challenges since
2025.11.12; without it youtube downloads fail and other sites keep working.

### "Your antivirus stopped the video processor" — `FFMPEG_AV_BLOCKED`

ffmpeg exited with 137 (SIGKILL) or a kill token appeared next to its name in
stderr. windows defender and friends do this to unsigned binaries. allow Cliply,
then retry.

### "The download stopped responding" — `STALLED`

the watchdog: two minutes with no output at all from yt-dlp, and the process tree
is killed. partial `.part` files stay resumable.

### "Can't write to the download folder" — `PERMISSION_ERROR` / `PATH_ERROR`

the folder's writability is probed rather than assumed, so this means a real
write failed. on windows also suspect path length — try a shorter download
folder.

### it downloaded, but there is no file

check the folder Settings actually points at, not the default. `system:health`
reports the resolved path.

### a download hung for a minute and then worked

repair-on-failure. the first attempt failed with something a newer engine fixes,
the engine updated, and the retry succeeded. expected.

---

## transcripts

### "No transcript was available for that language"

yt-dlp treats a subtitle track it could not find as a warning and exits 0, so
"success with no file" is the ordinary shape of this. it means the track really is
not there.

if the language was in the menu but the file is not, the likely cause is a track
listed under `automatic_captions` that youtube has since dropped. try the other
kind — the menu labels each row *Subtitles* or *Auto-generated*.

### the Transcript tab is empty

that video has no subtitles and no captions. most videos do not.
[transcripts.md](transcripts.md#which-languages-are-offered) explains what gets
listed and what is filtered out.

### the plain text has a line missing

a caption whose entire content is a number is indistinguishable from an srt cue
index and is dropped. known, asserted in
[`tests/transcript.test.js`](../tests/transcript.test.js). download SRT instead if
it matters.

---

## updates

### nothing happens in dev

correct. `app.isPackaged` is false, so the app updater schedules nothing and says
so once in the log. see [updates.md](updates.md).

### "check for updates" says up to date when there is a newer release

the check reads `latest.yml` / `latest-mac.yml` / `latest-linux.yml` from the
release. a release missing the file for your platform reads as "nothing newer" —
which is why the release workflow fails outright if one is absent.

### an update is found but nothing downloads

macOS and non-AppImage linux builds cannot replace themselves; they are offered
the releases page instead. this is by design and the dialog says so.
[updates.md](updates.md#which-builds-can-update-themselves).

### it downloaded but did not install on quit

`autoInstallOnAppQuit` is flipped on only once a download has landed. if the app
was killed rather than quit, the installer never ran — reopen and use Install
Now.

---

## development

### `npm test` fails on windows

expected. `ytdlp-lifecycle`, `ytdlp-updater` and `after-pack` assert on process
groups, signal escalation and executable bits, none of which windows has. run
them on WSL, or let CI do it.

### the renderer suite fails after touching a telemetry call site

by design. `analyticsCallSites.test.tsx` records every bag the renderer can build
and compares it to
[`analytics-payloads.fixture.json`](../src/main/renderer/src/lib/analytics-payloads.fixture.json).
update the fixture; the main suite then proves the new bag survives the privacy
boundary.
[development.md](development.md#one-contract-spans-both-runners).

### a telemetry property is silently missing in production

it was dropped at the boundary. every drop warns on `console.warn`, which nobody
sees in a packaged build. the cause is one of:

- the property is not in that event's `ALLOWED_PROPERTIES` list
- its value is outside its `PROPERTY_VOCABULARIES` entry or fails its kind check

both are in [`services/analytics.js`](../src/main/services/analytics.js), and
both are meant to require a deliberate edit.

### electron will not start after `npm ci`

the root `postinstall` runs `electron-builder install-app-deps`. if the install
was run with `--ignore-scripts`, electron has no binary. re-run `npm install`.

---

## when none of that helps

open an issue with the Report button, or at
<https://github.com/Cliply/Cliply/issues>. the stderr tail it attaches is
redacted — home directory, paths and credential-shaped strings are stripped
before it ever leaves the process
([`redactLogLine`](../src/main/services/ytdlp-engine.js)).
