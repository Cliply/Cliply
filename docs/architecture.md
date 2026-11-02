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
