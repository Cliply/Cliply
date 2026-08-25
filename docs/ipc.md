# ipc reference

every line between the renderer and the main process. the renderer reaches main
only through `window.electronAPI`, which the preload builds
([`src/preload/preload.js`](../src/preload/preload.js)); the handlers are in
[`src/main/ipc-handlers.js`](../src/main/ipc-handlers.js) and the channel names
in [`src/main/utils/constants.js`](../src/main/utils/constants.js).

> the preload keeps its own copy of the channel names. it has to — it is loaded
> outside the main module graph and cannot `require` from `src/main`. the two
> lists must be edited together.

## the response envelope

every `invoke` resolves to the same shape, and never rejects — the preload's own
catch turns a dead channel into an error response rather than a rejection:

```ts
{ success: true,  data: T }
{ success: false, error: { message, suggestion, code, details?, category? } }
```

`message` is the sentence the user reads. `details` is the raw technical text an
issue report quotes. `category` is the taxonomy answer
([`utils/error-taxonomy.js`](../src/main/utils/error-taxonomy.js)) and is the
field to read — `code` beside it is either the engine's code or the
`"GENERAL_ERROR"` placeholder.

## requests — renderer → main

### media

| channel | preload | what it does |
| --- | --- | --- |
| `video:get-info` | `video.getInfo({url, platform?})` | one `--dump-json` run. returns the quality ladder, the dubbed audio tracks and the transcript tracks |
| `video:download-combined` | `video.downloadCombined(request)` | video+audio. **resolves when the process starts**, not when the file lands |
| `audio:download` | `video.downloadAudio(request)` | audio only. same start-then-events contract |
| `transcript:download` | `video.downloadTranscript(request)` | one subtitle track. **resolves when the file is on disk** |

`pinterest.*` and `tiktok.*` are the same two channels with `platform` filled in.
they resolve on completion, like transcripts, because neither has progress worth
following.

### downloads

| channel | preload | what it does |
| --- | --- | --- |
| `download:cancel` | `download.cancel(id)` | `false` when there was nothing to cancel — usually because it just finished |
| `download:get-status` | `download.getStatus(id)` | one in-flight download |
| `download:get-all` | `download.getAll()` | everything in flight |

### cookies

| channel | preload | what it does |
| --- | --- | --- |
| `cookies:import` | `cookies.import(text)` | import netscape-format cookie text |
| `cookies:import-file` | `cookies.importFile()` | opens a file dialog and imports what it picks |
| `cookies:test` | `cookies.test()` | probes real youtube urls; a dead probe target moves on rather than failing the jar |
| `cookies:status` | `cookies.getStatus()` | what is in the jar, and whether it is usable |
| `cookies:clear` | `cookies.clear()` | empties it |

### settings and system

| channel | preload | what it does |
| --- | --- | --- |
| `settings:get-download-path` | `settings.getDownloadPath()` | `{path, exists, writable}` — writability is probed, not assumed |
| `settings:set-download-path` | `settings.setDownloadPath(p)` | |
| `system:select-download-folder` | `system.selectDownloadFolder()` | folder dialog |
| `system:open-download-folder` | `system.openDownloadFolder()` | reveals it in the file manager |
| `system:health` | `system.getHealth()` | engine path and version, ffmpeg/deno presence, active downloads, uptime |
| `system:get-diagnostics` | `system.getDiagnostics()` | the environment block an issue report attaches |
| `system:open-external` | `system.openExternal(url)` | |

### updates

all four are manual by definition — the background schedule never comes through
ipc. see [updates.md](updates.md).

| channel | preload | what it does |
| --- | --- | --- |
| `update:check` | `updater.checkForUpdates()` | |
| `update:download` | `updater.downloadUpdate()` | refuses with `UPDATE_MANUAL_ONLY` on a build that cannot replace itself |
| `update:install` | `updater.installUpdate()` | quits and hands over to the installer |
| `update:force-security-check` | `updater.forceSecurityCheck()` | the same check, labelled for the "important updates" button |

### telemetry

| channel | preload | what it does |
| --- | --- | --- |
| `analytics:track` | `analytics.track(event, props)` | the renderer may send **four** event names and no others: `url_submitted`, `media_info_loaded`, `media_info_failed`, `download_started` |

the property bag is forwarded wholesale. that is safe because
[`services/analytics.js`](../src/main/services/analytics.js) re-validates every
name and every value against its own tables — filtering in the preload would be
a second, weaker copy of that.

## events — main → renderer

subscriptions return their own unsubscribe function. call it.

| channel | preload | carries |
| --- | --- | --- |
| `download:progress` | `download.onProgress(cb)` | `{downloadId, status, progress?, speed?, eta?, filename?, error?, details?, category?, indeterminate?}` |
| `update:checking` | `updater.onUpdateChecking(cb)` | — |
| `update:available` | `updater.onUpdateAvailable(cb)` | `{version, releaseNotes?, releaseDate?, requiresManualDownload, autoDownloading, platform}` |
| `update:not-available` | `updater.onUpdateNotAvailable(cb)` | — |
| `update:download-progress` | `updater.onDownloadProgress(cb)` | `{percent, bytesPerSecond, total, transferred}` |
| `update:downloaded` | `updater.onUpdateDownloaded(cb)` | `{version, autoInstallOnQuit}` |
| `update:error` | `updater.onUpdateError(cb)` | `{message}` — **only for checks a person asked for** |
| `menu:new-download` | `menu.onEvent("new-download", cb)` | sent by File → New Download |

### `download:progress` is the whole download

the start call returns `{download_id, status: "started"}` and nothing else. every
later fact about that download — percentage, speed, the finished filename, the
failure and its category — arrives on this channel, keyed by the id the
**renderer** generated.

the renderer generates it so its listener can filter from the moment it
subscribes; a main-generated id would leave a window in which another download's
events could settle the wrong mutation.

`status` reaches exactly one of `completed`, `failed` or `cancelled`, once.
`indeterminate: true` means yt-dlp has no percentage to report (a trimmed
download is a single ffmpeg pass), so show a spinner rather than a bar at 0%.

## a request that reaches a command line

nothing from the renderer is interpolated into yt-dlp's arguments without passing
a whitelist first. the containers, audio modes, language tags and transcript
formats are all validated in
[`ytdlp-engine.js`](../src/main/services/ytdlp-engine.js), and each list has a
comment saying what it exists to keep out — `--sub-langs all`, a leading `-`, a
comma-separated list, a format selector written by the caller.

the url is checked separately (`normalizeUrl`: http/https only) and passed after
a `--` terminator, so a url pasted as `--exec=…` is an operand and not a flag.
