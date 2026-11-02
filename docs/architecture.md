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

## Local-file inspection, preview and copy-only tools (Stages 1–6)

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
compatible full-file container changes and validated single-section fast trims
are also enabled. Trimming alone requires native playback confirmation.

The version-1 [DTO](../src/main/renderer/src/lib/local-media-types.ts) contains an
opaque source ID, filename/size, nullable duration/start, format-family labels,
all actual stream indexes (including unknown/unsupported types), bounded stream
details, chapter count and bounded chapter start/end/title. It carries separate probe, native-preview, trim,
extraction, removal and remux capabilities. Probe success enables inspection
only; the DTO's preview capability remains unchecked until the renderer tries
the native element. Full-file export capability remains independent of local playback status.
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
Windows/Linux descriptor inheritance, hard-link behavior and packaged embedded
Node execution still require native Stage 7 acceptance.

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
Use a task-owned directory and remove helpers/media after verification. Native
Stage 4 evidence is macOS ARM64 development-host only; other platforms and
packaged execution remain Stage 7 gates.

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

### Single-section fast trim

Trim keeps one range, the validated source container and every source stream.
Controlled decimal-second fields accept up to six fractional digits; Set start /
Set end read the native element's actual time. I/O set the edges and arrow keys
seek five seconds, except while typing or using native controls. The range
survives exports/routes, resets with the source, and is locked during planning
or export. The user reviews requested and approximate planned content bounds,
then chooses a destination and saves. Returning to the route retains the range
but requires playback under the newly issued preview grant.

`onPlaying` acknowledges playback through the existing trusted-main-frame IPC
boundary. Main requires that acknowledgment and a live matching preview grant
for timing inspection, destination planning and export admission. This is an
attestation by the trusted renderer, not independent proof of decoded content.
Preview error/release/expiry clears it. Full-file extraction/removal/remux do
not require playback. A successful probe alone never enables trim.

The narrow matrix is H.264 yuv420p SDR in MP4/MOV, with zero or one AAC-LC
track, or one AAC-LC track in MP4/MOV/M4A, or PCM16 WAV. Audio is mono/stereo
44.1/48 kHz. All MOV-family tracks must retain their default disposition with
no other active flags. Known MOV-family starts must be within 1 ms of zero.
Chapters, subtitle/data/artwork/attachment streams, additional audio/video,
HDR and unsupported codecs/timing block the whole trim. Existing validated
language/title/tags/rotation checks apply; no implicit stream removal occurs.
MP3 and raw ADTS trimming remain refused: the native MP3 candidate exposed
about 99 ms of decoded-start error from reservoir/skip metadata. This does not
change full-file MP3/AAC extraction. Matroska trim is also outside this matrix.

[trim-plan.js](../src/main/services/local-media/trim-plan.js) reuses the existing
supervised FFprobe runner and single interactive-probe slot. Only explicit
Review cut requests scan packets. The start window is at most 60 seconds for
video or four for audio; the end window is at most four. Each process has a
15-second timeout, 2 MiB JSON cap, 8192-packet cap and existing stderr/drain
limits. Missing/nonfinite timing, nonincreasing DTS, packets longer than 100 ms,
PTS/DTS separation over 500 ms and unexpectedly long scans are refused. FFprobe
seeks approximately, so the result is validated instead of trusting the interval
request. There is no whole-file packet cache or renderer-supplied command.

Video chooses an actual preceding/following key packet within ten seconds of
the requested start. A collapsed range is refused; requested and planned cuts
must each be at least 100 ms. A bounded leading decode additionally checks that
the key packet is a usable picture at the chosen time (within 1 ms). The output
gets the same check at zero before publication. Those probes allow ten seconds,
64 KiB JSON, 128 frames and no decoder stderr. Stuck probes retain admission
until the process actually exits; cancellation, close and shutdown use existing
drain rules.

Video seeks before input, with a two-microsecond rounding guard for nonzero
keyframe times; PCM seeks before input at the requested time. Audio-only AAC
seeks after input and uses `-copyinkf`; video never gets that option. Output
`-t` uses requested end minus seek start; EOF omits `-t`. The command keeps
`-c copy`, actual stream maps and original-container muxing. No encoding,
universal timestamp offset, MKV B-frame workaround or `avoid_negative_ts`
policy is introduced.

Planned video end estimates the presentation extent of packets whose DTS is
before the requested end, accounting for B-frame reorder and VFR without FPS
multiplication. PCM's end can round to a copy block; AAC cuts follow packet
boundaries with priming/padding. Admission/output-duration tolerances are 500 ms
for video, 100 ms for PCM and 50 ms for audio-only AAC; output starts must remain
within 50 ms of zero. These are bounded acceptance limits, not frame/sample
accuracy promises. The native fixture matrix also checks actual decoded first/
last frames and aligned audio onset/end, fully decodes every output and verifies
source hashes. A bounded runtime leading check does not fully decode every
production output or prove every media timeline is correct.

Main owns a five-minute timing plan and invalidates earlier destination plans
when timing is recomputed. Source identity, current grant and plan expiry are
rechecked. Saving reuses `LocalExport` reservation, descriptors, owned partial,
progress/cancel, metadata validation, no-clobber publication and recovery ledger.
No second export runner or persistent project state is introduced. Uncertain
cleanup still blocks exports while allowing shutdown once helpers have exited.

Reproduce with `node scripts/smoke-local-trim.js <new-task-dir> <project-ffmpeg>
<verified-ffprobe>`. After renderer build, `CLIPLY_SMOKE_TRIM=1` plus the existing
helper/evidence environment overrides runs real Electron playback, trim, repeat,
route and cancel checks via `npm run smoke:electron`. Evidence is macOS ARM64
development-host only; native Windows/Linux and packaged checks remain Stage 7.

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

Optional token recovery builds the provider's native dependencies per platform,
checks a pinned payload hash and downloads only on demand. It is not a dependency
that every installer carries. Cookie imports and token escalation are different
recovery paths; preserve their existing validation and settings behavior.

Use the [binary guide](../binaries/README.md) for asset mappings and provenance,
and the [release guide](releasing.md) for app packaging and publication. A helper
fetcher's broader list of upstream architectures does not establish app support
on those architectures.
