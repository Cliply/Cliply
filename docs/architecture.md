# architecture

cliply is an electron app with no server of its own. everything it does is one
of two things: drawing a screen, or running a yt-dlp process.

```
┌──────────────────────────────────────────────────────────────┐
│ renderer  ·  react + typescript + tailwind                   │
│ src/main/renderer/                                            │
│ draws the ui, holds per-platform stores, never touches disk   │
└───────────────────────────┬──────────────────────────────────┘
                            │  window.electronAPI  (contextBridge)
┌───────────────────────────┴──────────────────────────────────┐
│ preload  ·  src/preload/preload.js                            │
│ the only surface the renderer can reach. one wrapper per      │
│ channel, no logic, no node access leaked through              │
└───────────────────────────┬──────────────────────────────────┘
                            │  ipcMain.handle / webContents.send
┌───────────────────────────┴──────────────────────────────────┐
│ main  ·  src/main/                                            │
│ ipc-handlers.js  translates requests into engine operations   │
│ services/        engine, updaters, cookies, settings, telemetry│
│ utils/           arg building, mapping, taxonomy, transcripts  │
└───────────────────────────┬──────────────────────────────────┘
                            │  spawn(), one process per operation
┌───────────────────────────┴──────────────────────────────────┐
│ yt-dlp  ·  binaries/<platform>/ytdlp/                         │
│ with ffmpeg for merging and converting, deno for youtube's js │
└──────────────────────────────────────────────────────────────┘
```

## the three processes

### renderer — `src/main/renderer/`

react 19, vite, tailwind, shadcn-style components. it renders, it validates what
the user typed, and it asks main for everything else. it has no filesystem
access and no node integration; `contextIsolation` is on.

state is zustand, one store per platform:
[`youtubeStore`](../src/main/renderer/src/lib/youtubeStore.ts),
[`pinterestStore`](../src/main/renderer/src/lib/pinterestStore.ts),
[`tiktokStore`](../src/main/renderer/src/lib/tiktokStore.ts). they are separate
because the three flows share almost nothing: youtube has a quality ladder, dubs,
time ranges and transcripts; the other two have a url and a button.

downloads that report progress run through hooks
([`useVideoDownload`](../src/main/renderer/src/lib/hooks/useVideoDownload.ts),
[`useAudioDownload`](../src/main/renderer/src/lib/hooks/useAudioDownload.ts))
that own a correlation id and a listener. the ones that do not — tiktok,
pinterest, transcripts — just await the ipc call.

### preload — `src/preload/preload.js`

the whole api surface, and deliberately dull: every method is
`invoke(channel, payload)` or a subscription that returns its own unsubscribe.
adding logic here would put it somewhere neither test suite drives.

### main — `src/main/`

| file | owns |
| --- | --- |
| [`index.js`](../src/main/index.js) | app lifecycle, the window, the menu, the quit drain |
| [`ipc-handlers.js`](../src/main/ipc-handlers.js) | one method per channel; translates request shapes into engine calls |
| [`services/ytdlp-engine.js`](../src/main/services/ytdlp-engine.js) | spawning, arg building, progress parsing, error classification |
| [`services/download-runner.js`](../src/main/services/download-runner.js) | drives one download from start to a terminal state |
| [`services/ytdlp-updater.js`](../src/main/services/ytdlp-updater.js) | keeps the yt-dlp engine current |
| [`services/app-updater.js`](../src/main/services/app-updater.js) | keeps cliply itself current |
| [`services/cookie-manager.js`](../src/main/services/cookie-manager.js) | the netscape cookie jar, and whether it is usable |
| [`services/settings-store.js`](../src/main/services/settings-store.js) | download folder, install id, analytics preference |
| [`services/analytics.js`](../src/main/services/analytics.js) | the single exit point for telemetry |

## how one download runs

1. the renderer generates a `download_id` and calls
   `electronAPI.video.downloadCombined({...})`
2. `ipc-handlers` validates the request, resolves the output directory and picks
   an `-o` template ([`utils/ytdlp-mappers.js`](../src/main/utils/ytdlp-mappers.js))
3. it **reserves** the id with the runner *before* replying, so a cancel that
   arrives in the next millisecond has something to cancel
4. it replies `{status: "started"}` and stops waiting
5. the runner asks the engine for a handle. `buildArgs()` turns the request into
   a yt-dlp command line; the engine spawns it and parses its stdout
6. progress lines become `download:progress` events on the id from step 1
7. the process exits. the runner sends a terminal event, records analytics and
   drops the reservation

step 4 is the reason downloads feel responsive and the reason there is a
correlation id at all: the ipc call is not the download, it is the *start* of
one.

### the exception

tiktok, pinterest and transcripts resolve when the file is on disk instead. they
are single files with no useful progress to report, and their components await
the call directly rather than subscribing to events.

## two things worth knowing before you change anything

### the engine gate

downloads and engine self-updates share one lock
([`OperationGate`](../src/main/services/ytdlp-engine.js)). downloads take a
shared read lock and queue behind an update in flight; an update takes an
exclusive write lock and **refuses** rather than queues, because an update must
never sit behind a two-hour download.

this is why the update check is deferred 90 seconds after launch: the user's
first action would otherwise queue behind it.

### repair-on-failure

yt-dlp breaks when youtube changes something, and the fix is always a newer
yt-dlp. so a download that fails with `updateMayFix` triggers one engine update
and one retry, and only one
([`download-runner.js`](../src/main/services/download-runner.js)). a second
failure is reported rather than retried.

## the telemetry boundary

[`services/analytics.js`](../src/main/services/analytics.js) is the only way an
event leaves the process, and it is a boundary rather than a wrapper:

- `ALLOWED_PROPERTIES` — every event, and the exact properties it may carry
- `PROPERTY_KINDS` + `PROPERTY_VOCABULARIES` — the shape each value may have
- everything else is dropped

the renderer may only send four events, and its property bag is forwarded
wholesale — which is safe precisely because the boundary re-validates it. adding
a property means editing those tables on purpose. see
[analytics.md](analytics.md) and [`PRIVACY.md`](../PRIVACY.md).

## where things are on disk

| what | where |
| --- | --- |
| settings, install id, analytics preference | `~/.config/app-data-7c4f/settings.json` |
| the cookie jar | `~/.config/app-data-7c4f/cookies/` |
| the running yt-dlp engine | `<userData>/engine/ytdlp/` |
| the engine that shipped in the installer | `<resources>/binaries/ytdlp/` |
| downloads | `~/Downloads/Cliply`, unless the user moved it |

the engine is copied out of the read-only app bundle into `userData` on first
launch precisely so it *can* be replaced later — see [updates.md](updates.md).
