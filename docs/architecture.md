# Cliply architecture

## Product and process boundaries

This repository contains the Electron desktop app. It supports YouTube video/audio,
trimming and playlists, plus TikTok and Pinterest video downloads. English and
Russian UI strings live under the renderer's `lib/i18n/` directory. Exact tool and
dependency versions belong to the two package manifests and lockfiles.

The app runs standalone yt-dlp processes. Its packaged engine includes a Python
runtime, but there is no FastAPI application server, localhost download API or
user-installed Python dependency. Do not infer the active architecture from
legacy local files. The `cliply-web` marketing site is a separate repository.

```text
React UI and stores
  -> renderer api.ts -> window.electronAPI -> preload -> IPCHandlers
  -> DownloadRunner -> YtdlpEngine -> YtdlpOperation -> yt-dlp
                                                   -> FFmpeg / Deno as needed
  <- download:progress and downloads:list events through preload
```

| Area | Source of truth |
| --- | --- |
| Startup, service construction, update scheduling, quit | [`src/main/index.js`](../src/main/index.js) |
| Window, renderer loading and packaged icon | [`src/main/window.js`](../src/main/window.js) |
| IPC validation, requests, download list snapshots | [`src/main/ipc-handlers.js`](../src/main/ipc-handlers.js) |
| Allowed renderer bridge | [`src/preload/preload.js`](../src/preload/preload.js) |
| Renderer calls and contract types | [`api.ts`](../src/main/renderer/src/lib/api.ts), [`api-types.ts`](../src/main/renderer/src/lib/api-types.ts), [`electron-api.d.ts`](../src/main/renderer/src/lib/electron-api.d.ts) |
| React UI, hooks, state and translations | [`src/main/renderer/src/`](../src/main/renderer/src/) |
| Queue, lifecycle, recovery and terminal events | [`download-runner.js`](../src/main/services/download-runner.js) |
| Public engine API and internal implementation | [`ytdlp-engine.js`](../src/main/services/ytdlp-engine.js), [`ytdlp/`](../src/main/services/ytdlp/) |
| Engine installation and upgrades | [`ytdlp-updater.js`](../src/main/services/ytdlp-updater.js) |
| Optional YouTube token recovery | [`pot-installer.js`](../src/main/services/pot-installer.js) |
| Settings, cookies and history | [`settings-store.js`](../src/main/services/settings-store.js), [`cookie-manager.js`](../src/main/services/cookie-manager.js), [`download-history.js`](../src/main/services/download-history.js) |
| Analytics runtime, schema and redaction | [`analytics.js`](../src/main/services/analytics.js), [`analytics/`](../src/main/services/analytics/) |

## Startup and downloads

`CliplyApp` waits for Electron readiness, constructs shared services, reads settings
and analytics opt-out, initializes cookies, constructs the engine/updater, and
seeds a runnable engine into writable user data. IPC handlers then own the runner
and expose the request boundary. A delayed engine check gives the first download
a head start. Production app updates use electron-updater separately.

Cookie construction and application startup share the same in-flight
initialization promise. This prevents simultaneous startup calls from replacing
the same temporary cookie jar; a later explicit refresh still runs normally.

For a download, IPC maps the request and reserves a runner entry. The runner owns
admission and concurrency; the configured cap is in `APP_CONFIG` in
[`constants.js`](../src/main/utils/constants.js). Queued entries remain cancellable.
The engine creates an operation handle with a promise, progress events and cancel.

The engine module is the public import surface. Its internal modules separate
argument construction, executable paths, stdout/stderr parsing, error wording,
playlist records and process lifecycle. Shared failure categories live in
[`error-taxonomy.js`](../src/main/utils/error-taxonomy.js); do not add a competing
classifier in a caller.

Operations hold read leases on `OperationGate`; installation takes an exclusive
write lease. Updates cannot replace a running engine. Keep this gate separate
from the runner's download slots: metadata operations also use the engine.
Shutdown freezes new work before cancellations or update aborts release the gate.
Process-tree cancellation covers FFmpeg/Deno children as well as yt-dlp itself.

Trimmed transport failures can retry once with a fresh operation. A successful
engine repair can also permit one retry. Both use the same extra-attempt budget,
hold the existing runner slot and preserve cancellation. Ordinary transfers retain
yt-dlp's native retry behavior. HTTP 403 has a distinct explanation; it is not
automatically treated as bot detection.

A playlist is one runner job containing multiple items. Archive records allow
completed items to be skipped on a repeated run. An archive skip is not proof
that the corresponding file still exists. Preserve saved/reused/skipped counts
and item identity when changing this flow.

## Renderer state and IPC contracts

`lib/api.ts` wraps the preload API. Feature hooks live in `lib/hooks/`, Zustand
stores in `lib/stores/`, and the downloads panel in `components/downloads/`.
The main process owns the ordered download list and pushes snapshots with a
sequence value; the renderer must not reconstruct a competing authoritative list
from asynchronous reads. See
[`downloadsStore.ts`](../src/main/renderer/src/lib/stores/downloadsStore.ts) and
the list/history IPC tests.

When adding a channel or changing a response, inspect main handlers, preload,
renderer declarations, API wrappers and their tests together. Keep Node/file
access in main and expose only the required bridge operations.

## Local-file inspection, preview and copy-only tools

[`local-media.js`](../src/main/services/local-media.js) owns one in-memory source
and at most one inspection, separately from download history, slots and the
yt-dlp update gate. The home entry opens the `/media` workspace after a successful
native selection. The separate session-only store retains source/position across
routes; global download subscriptions and the panel remain mounted. No startup
scan, saved project or new analytics is introduced. One local export has its
own reservation and status; it does not use downloader queue admission.

The narrow [`media` IPC handlers](../src/main/ipc/local-media.js), preload and
renderer `mediaApi` expose these calls:

| Call | Successful data |
| --- | --- |
| `media:open` | `{ cancelled, source }`; main selects one file through a native dialog. Cancel leaves the existing source open. |
| `media:get-state` | `{ source, busy }`; rechecks source identity before returning metadata. |
| `media:close` | `{ closed: true }`; revokes the source and cancels/drains a running probe. A pending dialog's eventual result is discarded. |
| `media:preview(sourceId)` | `{ sourceId, previewId, url, mime, expiresAt }`; one temporary access grant for the currently registered source. |
| `media:release-preview(previewId)` | `{ released: true }`; revokes that grant without closing the inspected source. |
| `media:prepare-export(request)` | `{ cancelled, plan }`; main validates the operation and actual stream IDs, derives the output format, and owns the native save dialog. |
| `media:start-export(planId)` | Export snapshot with a unique job already reserved; plans expire after ten minutes. |
| `media:cancel-export(jobId)` | Export snapshot; repeat cancellation is harmless. |
| `media:export-state` | Revision, preparing flag, plan, job and cleanup error. |
| `media:preview-playback({ previewId, played })` | `{ confirmed }`; trusted native-player event, tied to the current grant. |
| `media:inspect-trim({ sourceId, previewId, start, end, mode })` | Main-owned five-minute timing plan; `mode` is `before` or `after`. |
| `media:cancel-trim` | `{ cancelled }`; drains timing inspection while retaining the source. |
| `media:reveal-output(jobId)` | `{ revealed: true }`; main revalidates its completed path before revealing it. |

Requests are exactly `{ operation: "extractAudio", sourceId, streamIndex }` or
`{ operation: "removeTracks", sourceId, streamIndexes, removeChapters }`, or
`{ operation: "remux", sourceId, targetContainer, streamIndexes, removeChapters }`, or
`{ operation: "trim", sourceId, trimPlanId }`.
Remux targets are exactly `mp4`, `mov`, or `mkv`; main checks the destination
extension. Export requests never accept arbitrary flags, paths or cut times;
trim times go through the separate bounded timing inspection first.

`media:export-updated` sends the same revisioned snapshot only to the trusted
application main frame. Renderer subscriptions live outside the route. Requests
never accept destination paths, executable names or FFmpeg arguments.

Only the application window's main frame at its expected local URL is accepted;
renderer-supplied paths/options are refused. The shared host now requires
`webSecurity:true`, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`
and `allowRunningInsecureContent:false`. Top-level external navigation and new
Electron windows are denied; app website links use the existing external-browser
bridge. The scoped YouTube embed referer is preserved in the same session hook.
The window loads the same canonical `pathToFileURL` URL used for authorization,
including encoded Windows short-name tildes and literal percent signs. Electron's
legacy `loadFile` formatting can differ. Authorization remains an exact URL
comparison after removing only the route fragment; queries and foreign frames,
windows, file paths and remote origins are still rejected. The existing fallback
load also uses `pathToFileURL` and does not expand the trusted URL set.

[`preview.js`](../src/main/services/local-media/preview.js) registers the
`cliply-media` scheme before app readiness and its handler only in the owner's
session. Its exact URL contains a random 256-bit token, never a path. Tokens last
30 minutes and are revoked on replacement, close, expiry, full navigation,
renderer loss or shutdown. Route cleanup releases the token and stops/unloads
the native element; returning requests new access and restores position.
Unloading the element during expiry/retry must not overwrite that position with
the browser's reset-to-zero time event.

Before sending headers, main checks the owner WebContents, exact trusted top
frame URL, GET/HEAD method and media/fetch request type, then injects a private
proof header. The protocol fails closed without that proof; caller headers are
overwritten. A leaked URL alone cannot authorize foreign frames/windows/sessions.
The one header hook also preserves the YouTube referer; do not replace it with
another listener. CSP permits the custom scheme for media/fetch without a CSP
bypass privilege. Responses are uncached and stream only the main-owned file;
single prefix/open/suffix byte ranges and HEAD are supported, malformed or multiple
ranges return 416, and at most four streams remain live. Identity is rechecked
before opening and on the opened descriptor to catch replacement during open.
Revocation destroys active streams. A local process can still modify bytes during
an already-open read: this is a bounded stat detector, not an immutable snapshot.

The workspace rechecks identity every two seconds while mounted. Native controls
report loading/play/seek/end/error, support audio-only media and distinguish
decoder failure from successful inspection. The player chooses default tracks;
all probed tracks remain visible, including cover artwork. There is no software
decode/transcode fallback. Audio extraction and full-file track removal are enabled for verified profiles;
compatible full-file container changes and reviewed multi-section cuts
are also enabled. The section editor can plan exports independently of playback;
the legacy single-range request still requires its playback acknowledgement.

The version-1 [DTO](../src/main/renderer/src/lib/local-media-types.ts) contains an
opaque source ID, filename/size, nullable duration/start, format-family labels,
all actual stream indexes (including unknown/unsupported types), bounded stream
details, chapter count and bounded chapter start/end/title. It carries separate probe, native-preview, trim,
extraction, removal and remux capabilities. Probe success enables inspection
only; the DTO's preview capability remains unchecked until the renderer tries
the native element. Export capability remains independent of local playback status.
Main computes separate `extractionProfiles`, `trackRemovalProfile`, `remuxProfiles` and `trimProfile` from the
verified codecs/container, stream properties and duration. Unsupported streams
stay in the inventory and are not silently removed from a planned copy.

Canonical path plus device/inode/size/nanosecond mtime/ctime stay in main. They
are checked before/after probing and on state access, and changes revoke the
registration. This is a stat change detector, not a cryptographic identity or a
defence against a hostile local process racing file replacement. Devices,
directories, relative paths, URLs and UNC inputs are refused. Mounted network
filesystems that present ordinary local paths are not identified by this check.

The [probe runner](../src/main/services/local-media/probe.js) uses shell-free
argv, file-only protocols, a small self-contained demuxer allow-list and disabled
MOV external references. It limits JSON to 1 MiB, stderr to 64 KiB, streams to
128, chapters to 512, probing analysis to 5 MB/5 seconds, and wall time to
30 seconds. A 64 MiB single-allocation cap is not a total-RSS limit. Invalid or
missing numeric fields remain `null`; inventories are refused, never silently
truncated. Errors carry stable codes and path-free messages, not raw stderr.

Cancel/timeout/overflow sends TERM, escalates to KILL after 500 ms and waits for
close. A further 2-second drain failure reports `PROBE_STUCK` while keeping the
slot occupied until actual exit. Quit freezes admission and drains local exports and inspection;
repeated quit requests cannot bypass that drain. Installer handoff drains first
and refuses to proceed if a helper is still active. A cleanup warning after all
helpers exit retains its recovery record without preventing quit/install. Source selection/state are discarded
on close or app exit; nothing is written to the source.

An ordinary quit drains local media before committing downloader teardown.
If that drain fails, download admission, the engine and update scheduling remain
operational; local media stays frozen until the app closes. After a
successful drain, queue admission and the engine freeze together before the
first asynchronous history write. Downloads are cancelled before an updater
abort can release its gate.
The window close button prevents immediate destruction and delegates to this
same drain; it does not set the quit flag early. A refused quit leaves the
window available for the error and a later retry.

See [FFprobe staging](../third-party/ffprobe/README.md) for the development-only
verified candidates. Missing FFprobe returns `PROBE_MISSING` on open, with no
download or startup failure.

### One-track audio export

The main-owned [planner](../src/main/services/local-media/export-plan.js) accepts
one full-duration track: AAC-LC to ADTS `.aac`, MP3 to `.mp3`, or signed 16-bit
little-endian PCM to `.wav`. Only mono/stereo and the tested source families are
enabled. Other tracks, artwork, chapters and source tags are omitted with an
explicit UI notice. There is no codec conversion, batch, range or preview
requirement. The original source stays open after success or cancellation.

[LocalExport](../src/main/services/local-media/export.js) reserves before replying,
allows one local job, maps `0:<actual index>` and uses `-c copy`. Input and exclusive
temporary output are opened in main and inherited as seekable descriptors. The
[supervisor](../src/main/services/local-media/export-worker.js) uses Electron's
embedded Node and owns one FFmpeg child. Parent IPC loss stops and drains FFmpeg;
no separately installed Node or Python is needed. Machine progress is bounded,
monotonic and capped below 100 until publication. Diagnostics are bounded and
never sent to the renderer. Cancellation escalates TERM to KILL; a helper that
has not actually closed keeps admission held and prevents quit/install success.

[ExportOutput](../src/main/services/local-media/export-output.js) places an
exclusive partial in a private random directory in the chosen destination.
Before publication, main rechecks source identity and validates nonempty output,
one audio stream, codec/sample rate/channels, output family, absent chapters and
duration within the larger of 250 ms or 2%. Native acceptance additionally decodes
and compares the selected encoded audio; this is not sample-accurate editing.

The final file is created with an atomic, no-clobber hard link. Existing files,
symlinks, hardlink aliases and collision races are refused. Unsupported
filesystems fail without an overwrite/copy fallback. Entering `publishing` is the
cancel commit point: cancellation is then ignored, so a saved file cannot also
be reported cancelled. Cleanup removes the temporary link, never the final file.

A bounded `<userData>/local-media/partial.json` record stores the owned paths,
random marker and directory/file identities. Restart marks interrupted work and
cleans only a matching recorded partial; it never scans folders, resumes work or
removes unknown files. Uncertain ownership or a changed destination blocks new
exports until cleanup can be verified; it does not trap shutdown/install once
the writer and validation probe have exited. Recovery can finish removing an
empty staging directory after an interrupted cleanup when its durable identity
still matches; missing markers never authorize deleting remaining contents or
replacement directories. A hard crash in the
small setup window before ownership is durable can leave an empty staging
artifact requiring inspection. File descriptors and identity checks reduce path
races; they are not protection against a hostile local process modifying bytes
or directories. Network-mounted local paths are not positively identified.
Descriptor inheritance, joined exports and hard-link publication are covered by
the native checks recorded in [validation status](#local-media-validation-status).

### Full-file track removal

The same planner and `LocalExport` lifecycle accept one `removeTracks` request.
The workspace's action choice and selections are session-only and survive route
changes; switching/closing the source resets them. All streams start checked,
including unsupported attachments, artwork and data. “Remove all audio” changes
only audio selection. Unchecking an unsupported stream is explicit consent to
omit it; chapters require a separate removal checkbox when present. Chapter,
attachment, data and cover-art preservation are not advertised for this action.
The source remains open, and decoder/preview failure does not block planning.

The initial same-container matrix is H.264 `yuv420p` SDR video (at most one
retained), mono/stereo AAC-LC audio, and compatible text subtitles: `mov_text`
for MP4/MOV or `subrip` for MKV. Retained subtitle codecs are never converted.
Require at least one playable video/audio stream and positive known duration.
Same-container audio-only AAC results are tested for all three containers;
other audio-only formats should use Extract audio. Nonzero MKV rotation, HDR,
other active disposition flags, unsafe-to-round-trip titles and unverified
streams are refused unless removed. Container detection checks both demuxer
family and filename extension; MOV additionally requires QuickTime brand and
MP4 a recognized MP4 brand, rather than trusting the shared `mov,mp4,...` label.

Maps use actual input IDs sorted in ascending order. Output ordinals then scope
stream metadata and disposition arguments. File metadata is copied, and the
runtime validator checks ordinary `title`, `artist`, `comment` tags, stream
title/handler name, language, default/forced flags and rotation. MOV/MP4's `name`
tag is normalized as a displayed track title and passed back as the muxer's
`title` option; values altered by display sanitization/truncation are refused.
Other format-specific metadata may vary; this is not privacy sanitization.
Matroska uses `-default_mode passthrough` so zero default flags stay zero.
MOV/MP4 automatically promotes a retained track when its type has no default;
that selection is refused with `TRACK_DEFAULT`, rather than silently changing
the flag. Keep the existing default track too, or use Extract audio.

The validator checks nonempty data, container family/brand, exact stream count,
order, codec and tested properties, video dimensions/pixel/color/rotation,
audio profile/rate/channels, expected tags/flags, absent chapters and duration
within the larger of 250 ms or 2%. Native acceptance additionally compares each
retained stream's encoded-content hash and fully decodes video/audio. There is
no new runner or publication path. The reviewed cleanup rule remains: uncertain
ownership blocks new exports but does not trap shutdown/install after helpers
have actually exited; live helpers still block drainage.

The synthetic harness is `scripts/smoke-local-tracks.js <new-task-dir>
<absolute-project-ffmpeg> <absolute-verified-ffprobe>`. Set `CLIPLY_SMOKE_TRACKS=1`
with the existing `CLIPLY_SMOKE_FFMPEG`/`CLIPLY_SMOKE_FFPROBE` overrides to include
the real Electron UI checks in `npm run smoke:electron` after renderer build.
Use a task-owned directory and remove helpers/media after verification. Later
source-built native package checks supersede the initial macOS-only Stage 4
evidence; see [validation status](#local-media-validation-status).

### Compatible full-file container changes

Change format reuses the track selection panel and the same export lifecycle.
Every stream starts selected. Target changes never silently remove tracks or
convert codecs; incompatible selections require explicit removal. The original
source and in-memory options stay open after export and navigation. The UI
explains that quality/codecs remain unchanged and smaller size is not guaranteed.

Source container evidence is independent of filename: FFprobe's MOV-family
major brand identifies verified MP4 (`isom`, `iso2`, `mp41`, `mp42`, `avc1`) or
MOV (`qt`). For the shared Matroska/WebM family, a bounded 4096-byte EBML Header
DocType check accepts only `matroska`; WebM/unknown/malformed headers are refused.
This small check in [container.js](../src/main/services/local-media/container.js)
is not a general media detector. Same-container track removal keeps its existing
source-profile policy.

The tested cross-container matrix is H.264 yuv420p SDR and AAC-LC mono/stereo
at 44.1/48 kHz, with known near-zero starts (within 100 ms). MP4/MOV `mov_text`
can be retained between those two containers when flags survive. MKV text
subtitles cannot be copied to MOV/MP4, and MOV text cannot be copied to MKV.
Unsupported streams stay selected until explicitly removed. MOV forced tracks,
MOV/MP4 selections without a retained default of each type, and nonzero rotation
to MKV are refused. Portrait rotation is verified for MOV↔MP4. No conversion,
compression, combined trimming or automatic fallback is exposed.

Full-file chapters can be preserved into MKV when there are at most 512 bounded,
ordered, nonoverlapping chapters, within the source duration, with exact titles
up to 256 characters and no additional chapter tags. `-map_chapters 0` copies
them; source chapter data tracks still require explicit removal. MOV/MP4 chapter
output is not enabled because its muxer can create an implicit chapter data
track. Other cases require separate explicit chapter-removal consent. Chapter
editing and trimmed chapter rewriting remain out of scope.

Before publication, remux validation checks content container, stream order/count,
codec, tested tags/language/default/forced/rotation and ordinary properties,
plus duration, start offsets and chapter count/timing/title. Start and chapter
differences are bounded to 50 ms for the measured AAC priming/container rounding;
whole duration retains the existing 250 ms / 2% tolerance. Native acceptance
compares decoded video exactly and decoded audio's aligned overlap exactly,
allowing up to 2048 sample frames of priming/padding at the edges. These checks
do not claim universal codec, complex timestamp or arbitrary metadata support.

Reproduce the synthetic cross-container matrix with
`node scripts/smoke-local-remux.js <new-task-dir> <project-ffmpeg> <verified-ffprobe>`.
After building the renderer, set `CLIPLY_SMOKE_REMUX=1`,
`CLIPLY_SMOKE_FFMPEG`, `CLIPLY_SMOKE_FFPROBE` and optional
`CLIPLY_SMOKE_EVIDENCE` for `npm run smoke:electron`. Helpers must follow the
existing verified staging process; the scripts do not download or replace them.

### Visual cutting and stream-copy export

Cutting is the default local-file tool. The preview sits above a zoomable,
scrollable timeline with draggable boundaries, marked sections and a retained
output lane. I/O sets the active section's boundaries, B splits at the cursor,
Delete deletes a marking, and Ctrl/Cmd+Z / Shift+Ctrl/Cmd+Z undo/redo. Fields for
precise times are secondary. Edits survive route changes and repeated exports;
a new source resets the bounded session history. Nothing persists as a project.

“Keep marked sections” exports the marked ranges; “Remove marked sections”
exports their complement. A middle removal retains both sides and joins them in
source order into one output. The separate retained-content preview skips the
omitted sections using requested times; it is not proof of keyframe-exact output.
Review shows each planned cut and output format before destination selection.
Arbitrary segment reordering, separate-clip batch export and smart re-encoding
are outside this iteration.

The measured video profile is SDR H.264 yuv420p with AAC-LC or HE-AAC,
mono/stereo 44.1/48 kHz, in MP4/MOV or compatible MKV. Up to 16 audio tracks can
be retained; every supported track is mapped explicitly. MP4/MOV must have a
default track of each type, with no other active disposition flags. Rotation is
preserved where verified. MP4/MOV exports retain their container. MKV video
exports to MP4 without re-encoding; the UI shows this in the reviewed plan.
Audio-only AAC MP4/MOV/M4A and PCM16 WAV retain their existing measured profiles.
Chapters, subtitles, attachments/data, additional video, HDR and other codecs
receive specific capability reasons; nothing is silently dropped or converted.
MP3/raw ADTS cutting remains refused. Use the explicit full-file tools when
appropriate, which have their own compatibility rules.

Preview and stream-copy support are independent. The new segment request does
not require playback; source identity and trusted IPC remain mandatory. Native
H.264/AAC MKV and H.264/HE-AAC MP4 playback have passed on the macOS development
host. No proxy/transcode fallback is introduced for unmeasured codecs; failure
to play does not disable a valid export plan. The legacy single-range IPC request
still validates its existing preview acknowledgment for backward compatibility.

Timing uses bounded packet scans and decoded leading-frame checks. Video start
requests scan a 40-second window, leaving room within the existing 61-second
observed span limit for FFprobe's earlier keyframe seek. No whole-file packet
cache is created. Limits remain 8192 packets, 2 MiB JSON and 15 seconds per packet
probe, with the existing supervised cancellation/drain. Missing leading DTS on
at most 16 packets can be reconstructed from the first known DTS and packet
durations; missing internal timing still fails. VFR/B-frame ends use PTS/DTS,
never average-frame-rate multiplication.

MP4/MOV source starts remain within 1 ms; compatible MKV starts may be within
100 ms. Matroska planning uses the video origin and export preserves timestamps
with an explicit rebase. Its B-frame seek compensates FFmpeg's earlier seek;
this is specific to Matroska, not a universal offset. Each cut is validated for
streams, tags, dispositions, duration and a decoded starting picture before
concat. Concat explicitly places the next part after the planned presentation
end, including B-frame tails, and retains its zero-based timeline. Fast cuts can
include extra pictures or short picture/audio gaps at boundaries; they are not
frame/sample accurate. Existing duration/start acceptance thresholds remain.

See the segment contract/lifecycle below. Run the old single-cut matrix with
`node scripts/smoke-local-trim.js <task-dir> <ffmpeg> <ffprobe>`, and the joined
matrix with `node scripts/smoke-local-segments.js <task-dir> <ffmpeg> <ffprobe>`.
Both require a new disposable fixture directory. After building the renderer,
`CLIPLY_SMOKE_TRIM=1` plus the existing helper/evidence overrides for
`npm run smoke:electron` exercises native editor playback, retained preview,
export, route return, cancellation and replacement. HE-AAC fixture encoding uses
AudioToolbox on macOS; other native hosts do not inherit that validation.

### Local-media validation status

These are narrow verified profiles, not support for every file carrying an
extension. Main rejects unknown, incompatible or ambiguous layouts before saving.

| Action | Enabled behavior | Important limits |
| --- | --- | --- |
| Extract audio | One actual selected AAC-LC/MP3/PCM16 track, full duration, to ADTS AAC/MP3/WAV | No conversion or batch; verified mono/stereo PCM only; preview not required |
| Remove tracks | Full-file compatible MP4/MOV/MKV, explicit retained tracks or Remove all audio | No implicit loss; tested H.264/AAC/text-subtitle profiles only; MP4/MOV default-flag promotion refused |
| Change container | Full-file compatible MP4/MOV/MKV, all streams selected initially | Incompatible tracks need deliberate removal; bounded chapters preserved only in compatible MKV; unsupported subtitle flags refused |
| Cut video | Visual keep/remove sections, joined original-quality output; H.264/AAC-LC or HE-AAC MP4/MOV, compatible MKV to MP4; existing AAC/PCM audio profiles | Keyframe/packet/block boundaries; chapters/subtitles/HDR and unmeasured codecs refused; preview independent |

All four use the same one-job lifecycle, source checks, owned partial, validated
output and atomic no-clobber publication. Main handles destination paths and
commands; the renderer never supplies shell text. The original remains open.
Exports can run beside URL downloads without occupying yt-dlp's replacement gate.
No background proxies, thumbnails, waveforms, compression or saved projects were added.

| Target | Evidence established | Still required |
| --- | --- | --- |
| macOS ARM64 | New editor: development Electron playback/export and decoded multi-cut fixtures. Prior native package/helper checks passed at 07b3e9e | New native package run, production FFprobe pins/installer acceptance, macOS 13 (owner deferred), broader performance/storage evidence |
| Windows x64 | Prior source-built package/helper checks passed on Server 2025 at 07b3e9e | New editor native validation, production distribution, Windows 10 (owner deferred) |
| Ubuntu 24.04 x64 | Prior source-built package/helper checks passed at 07b3e9e | New editor native validation and production distribution |

The macOS private package check runs offline with development helper overrides
absent. Its test entry isolates external services and dialogs; it does not claim
normal updater/installed-app acceptance. Final production FFprobe acquisition is
inactive while `third-party/ffprobe/published.json` is empty. Missing-helper errors
remain readable and do not stop downloads. Native/helper readiness gates cannot
be waived by a successful ordinary downloader build.

Reproduce combined UI with `CLIPLY_SMOKE_INTEGRATION=1` and the existing verified
helper overrides for `npm run smoke:electron`, or run
`scripts/smoke-packaged-local-media.js --resources <native-resources>` without
overrides. Its fixtures include a 12-second H.264/AAC source and a sparse 512 MiB
WAV; sparse-file opening is not large-disk throughput evidence. The package
checker has `--idle-only` for like-for-like isolated startup/idle measurements.
Native compatibility/cancel/crash matrices remain in the individual smoke scripts.
[Release checks](releasing.md) define the pending three-platform CI gate.

Follow-up acceptance: finish exact corresponding-source/notices and native host
verification, publish only ready pinned helpers, run native package/minimum-OS
checks, and complete cold/warm normal-service startup, representative long media,
helper CPU/RSS peaks, slower/removable storage and disk-exhaustion measurements.
Do not infer zero overhead or cross-platform support from small local fixtures.

## Storage and privacy

| Data | Location / behavior |
| --- | --- |
| Settings, install identity, counters and opt-out | `~/.config/app-data-7c4f/settings.json`, owned by SettingsStore; retained for compatibility with older installs |
| YouTube cookie jar | `~/.config/app-data-7c4f/cookies/youtube_cookies.txt`; owner-only modes on POSIX, managed by CookieManager |
| Writable engine | `<Electron userData>/engine/ytdlp/`, with the complete standalone payload |
| Optional token payload | `<Electron userData>/pot/`, separate from the directory engine updates replace |
| Download history | `<Electron userData>/downloads/history.json`; bounded metadata, not an automatically resumed queue |
| Playlist records/archives | Paths produced by engine/playlist helpers and IPC mapping under user data; inspect the helpers before changing retention |
| Downloaded media | User-selected folder, with `Downloads/Cliply` as the configured default |

Paths differ between platforms and test overrides. Use the existing services and
path helpers rather than constructing another copy of these rules. Never clear
these locations merely to make development or tests pass.

Only the main-process Analytics service sends telemetry. Renderer events pass
through IPC validation. The event/property allow-list and vocabularies are in
`analytics/schema.js`, redaction is in `analytics/redact.js`, and environment
detection is in `analytics/environment.js`. Packaged builds are eligible;
development requires explicit opt-in, and the user's opt-out still applies.
Consult [PRIVACY.md](../PRIVACY.md) and the [analytics guide](analytics.md) before
changing a payload or interpreting a dashboard. Local persisted metadata and
telemetry have different privacy boundaries.

## Binary and update boundaries

FFmpeg and Deno come from Cliply's shared `binaries` release. Build-time yt-dlp
comes from official upstream archives. The runtime updater seeds from the package,
then verifies, stages, probes and swaps newer upstream engines into writable user
data under the gate. Calling `yt-dlp -U` is not the app's update mechanism.

On Windows, atomic directory swaps retry only EPERM/EBUSY rename failures up to
five times with 100–500 ms delays (1.5 seconds total per rename). The caller's
replacement gate stays held through retire, install and any rollback; persistent
failures still fail and retain existing recovery metadata. Other errors and
platforms fail immediately. Probes still wait for child closure before swapping.

Optional token recovery builds the provider's native dependencies per platform,
checks a pinned payload hash and downloads only on demand. It is not a dependency
that every installer carries. Cookie imports and token escalation are different
recovery paths; preserve their existing validation and settings behavior.

Use the [binary guide](../binaries/README.md) for asset mappings and provenance,
and the [release guide](releasing.md) for app packaging and publication. A helper
fetcher's broader list of upstream architectures does not establish app support
on those architectures.

### Visual editor continuation

The corrected editor direction supersedes the one-section product restriction.
`media:inspect-trim` also accepts `{ sourceId, ranges: [{ start, end }], intent:
"keep" | "remove", mode: "before" | "after" }`. Main validates up to 32 ordered,
disjoint marked ranges and computes the retained intervals, including both sides
of a middle removal. Empty outputs and retained slivers below 0.1 seconds are
refused. The existing legacy request remains supported. Segment planning does
not require native playback; preview capability is separate from stream copying.

A main-owned timing plan contains every retained cut. Keyframe-expanded overlaps
are refused. One export reservation cuts and validates each part, then joins the
parts into one new file. Concat timestamps use each planned presentation extent,
including B-frame tails, and preserve the demuxer's zero-based timeline. AAC
packet boundaries and video reordering can leave short gaps at joins; this is
fast stream copying, not frame-exact editing or re-encoding. All intermediates
are individually recorded in the existing ownership ledger, validated before
publication and cleaned on cancellation/recovery. Original file identity,
explicit stream maps and atomic no-clobber publication remain mandatory.
