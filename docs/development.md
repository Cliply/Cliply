# development

## getting a checkout running

```bash
git clone https://github.com/Cliply/Cliply.git
cd Cliply

npm install && npm run install:renderer   # two package trees, two installs
npm run fetch:ytdlp                       # the download engine
```

then ffmpeg and deno, which are too big for git —
[`binaries/README.md`](../binaries/README.md) has the commands for your
platform. without them:

- **no ffmpeg** → downloads above 360p, trims and audio conversion fail
- **no deno** → youtube downloads fail outright (yt-dlp needs a js runtime for
  youtube's challenges since 2025.11.12)

```bash
npm run dev
```

that runs the vite dev server and electron together. the renderer hot-reloads;
`nodemon` restarts electron when anything under `src/main/` changes.

requirements: node ≥ 18 (CI uses 20), npm ≥ 8. no python — the engine is a
binary the app spawns directly.

## the scripts that matter

| script | what it does |
| --- | --- |
| `npm run dev` | dev server + electron, both watching |
| `npm test` | the main-process suite (jest) |
| `npm run test:renderer` | the renderer suite (vitest) |
| `npm run lint` | eslint over `src/main` |
| `npm run fetch:ytdlp` | download and checksum-verify the engine |
| `npm run smoke:ytdlp` | run the fetched engine against a real url |
| `npm run build:renderer` | type-check and bundle the renderer |
| `npm run prepare:full` | icons + renderer build + engine, i.e. everything an installer needs |
| `npm run dist` | build an installer for the current platform |

`npm run dev` alone is enough for almost everything. `prepare:full` and `dist`
are covered in [releasing.md](releasing.md).

## the two test suites

they cover different processes and they do not share a runner.

```bash
npm test                  # jest, tests/**, the main process
npm run test:renderer     # vitest, src/main/renderer/**, react + hooks
```

**the main suite expects a POSIX runner.** several tests assert on process
groups, signal escalation and executable bits, none of which exist on windows —
`tests/ytdlp-lifecycle.test.js`, `tests/ytdlp-updater.test.js` and
`tests/after-pack.test.js` fail there for that reason and not because anything is
broken. CI runs them on ubuntu and macOS.

### one contract spans both runners

telemetry is checked from both ends, and
[`analytics-payloads.fixture.json`](../src/main/renderer/src/lib/analytics-payloads.fixture.json)
is the only thing tying them together:

- the renderer suite drives the real hooks and components and records every
  telemetry bag they build
  ([`analyticsCallSites.test.tsx`](../src/main/renderer/src/lib/analyticsCallSites.test.tsx))
- the main suite replays that same file through the real `Analytics` and asserts
  nothing is dropped or normalised
  ([`renderer-analytics.test.js`](../tests/renderer-analytics.test.js))

so **adding or changing a telemetry call site fails the renderer suite**, and the
fix is to update the fixture — at which point the main suite proves the new bag
is actually sendable. if it is not, the property is missing from
`ALLOWED_PROPERTIES` or its value is outside its vocabulary. that friction is the
feature; see [analytics.md](analytics.md).

## the shape of the code

a few conventions that are consistent enough to be worth naming:

**comments say why, not what.** the interesting files carry long block comments
explaining the decision behind the code — which format yt-dlp really picks, why
an order of arguments is load-bearing, why a value is dropped rather than
guessed. those comments are load-bearing documentation; if you change the
behaviour, change the comment.

**absence over invention.** a size that could not be determined is `null`, not
`0`; a property with no value is left out of a telemetry bag rather than sent as
`null`. a confident wrong number is worse than no number.

**validate at the boundary.** anything from the renderer that could reach a
command line goes through a whitelist first — container names, language tags,
audio modes, transcript formats. these are in
[`ytdlp-engine.js`](../src/main/services/ytdlp-engine.js) and each one has a
comment saying what it is keeping out.

**one place per fact.** the error taxonomy is
[`utils/error-taxonomy.js`](../src/main/utils/error-taxonomy.js) and nowhere
else; the ipc channel names are `utils/constants.js` (mirrored in the preload,
which cannot import from `src/main`); the transcript format list is
`utils/transcript.js`, imported by the engine rather than restated.

## adding a feature that needs a new ipc channel

there is no way around touching six files, and the order matters:

1. `src/main/utils/constants.js` — name the channel
2. `src/preload/preload.js` — mirror the name, add the wrapper
3. `src/main/ipc-handlers.js` — the handler, registered *and* added to
   `cleanup()`'s channel list
4. `src/main/renderer/src/lib/api.ts` — the request/response types and the
   `window.electronAPI` declaration
5. the component or hook that calls it
6. tests on both sides

[ipc.md](ipc.md) lists what exists today. the transcript feature is the most
recent end-to-end example, and [transcripts.md](transcripts.md) walks through
every file it touched.

## debugging

- **renderer** — devtools open automatically in dev (`F12` otherwise)
- **main** — `console.log` goes to the terminal that ran `npm run dev`
- **what yt-dlp was actually told** — every failure keeps the last 200 stderr
  lines, redacted, and the issue reporter attaches them. in dev, `buildArgs()`
  is a pure function: `node -e "console.log(require('./src/main/services/ytdlp-engine').buildArgs('combined', {url:'…', height:1080}))"`
- **which engine is running** — Tools → Video engine, or Help → System Health

## contributing

report bugs, request features, open pull requests. keep it simple and clean like
the rest of the project — and if you are changing something whose comment
explains a decision, either keep the decision or explain the new one.
