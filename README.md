<p align="center">
  <h1 align="center">cliply</h1>
  <img src="assets/stars.jpeg" width="1024" alt="shooting stars over a grainy blue sky" />
</p>

<p align="center">
  a clean little desktop app to download videos<br />
  <a href="https://cliply.space">cliply.space</a>
</p>

<p align="center">
  <a href="https://github.com/Cliply/Cliply/releases/latest">download</a> ·
  <a href="https://x.com/cliplydotspace">twitter</a> ·
  <a href="https://reddit.com/r/cliply">r/cliply</a>
</p>

cliply started as a small weekend project. i just wanted a simple way to download videos without ads, shady websites, popups, or unnecessary clutter.

so i built one.

it's free, open source, and available for macos and windows.

### what it does

cliply supports **youtube, tiktok, and pinterest**.

for youtube, you can:

- choose video quality
- download audio in mp3, m4a, or the original format
- trim videos by setting a start and end time
- download playlists
- set a quality limit for playlist downloads

downloads run through a queue, with multiple downloads running at once. the downloads panel shows what's running, what's finished, and keeps your recent download history. if youtube asks for authentication, there's a guided cookie import.

it speaks english and russian based on your system language, updates itself, and keeps yt-dlp updated automatically. it also sends a little usage data so i can find bugs, and one click in the Tools menu turns that off for good. [here's what it sends, exactly](PRIVACY.md).

got an idea or found something broken? [open an issue](https://github.com/Cliply/Cliply/issues).

### local files — under validation

this branch also has a local-file workspace: preview a file, mark sections on a visual timeline, keep or remove them and save
one joined result. You can also extract audio, remove tracks or change a compatible container.
these tools copy existing media without re-encoding. fast cuts can move to a
nearby video keyframe; unsupported layouts show a reason instead of converting
or silently dropping tracks. the original stays open and exports use a new file.

production availability is pending: shared ffprobe assets and their complete
source records are not ready. source-built package checks for the visual editor
passed on macos 26, windows server 2025 and ubuntu 24.04; older os verification
and final production distribution remain pending.
normal builds without ffprobe show a readable inspection error; downloads still
work. see the [verified profiles and limits](docs/architecture.md#local-media-validation-status)
and [development staging instructions](third-party/ffprobe/README.md).

### get it

grab it from [releases](https://github.com/Cliply/Cliply/releases/latest), or [cliply.space](https://cliply.space/downloads) if you'd rather just click a button. windows gets an `.exe` installer, macos a `.dmg` for apple silicon. intel macs aren't currently supported. linux x64 packaging is prepared for the next release: an AppImage and a `.deb` for ubuntu/debian systems. linux downloads become available when those files appear on the release page.

the first launch on macos shows a warning that says the app can't be checked for malicious software. that's gatekeeper, and it isn't about cliply specifically. apple only stops showing it once the app is signed with a paid developer certificate, and cliply doesn't make any money. so for now, this clears it:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Cliply.app
```

all that does is drop the "downloaded from the internet" flag. only ever run it on something you actually trust, like a release off this page.

### setup

node 22.12 or newer (npm 10 or newer). the current desktop build uses electron 45 and requires macos 13 or newer on apple silicon, or 64-bit windows 10 or newer. linux builds target x64, with native build and package checks on ubuntu 24.04; this does not promise compatibility with every distribution.

```bash
npm install && npm run install:renderer
npm run fetch:helpers
npm run fetch:ytdlp
npm run dev
```

`fetch:helpers` downloads the platform's ffmpeg and deno from cliply's shared `binaries` release. `fetch:ytdlp` pulls the official yt-dlp build for your platform into `binaries/`, checksum-verified. no python needed, the app spawns the binary directly and keeps it current on its own. [binaries/README.md](binaries/README.md) explains the layout and platform selection.

`npm run dist` packages it for your platform. on linux, `npm run dist:linux:safe` creates an AppImage and `.deb` without publishing. update manifests come from electron-builder and must reference the actual attached installers. `npm test` runs the main process suite and `npm run test:renderer` runs the interface one. CI runs the main suite on posix systems and focused recovery tests on windows, where process signals and file modes differ.

### how it works

the interface is react and typescript in [`src/main/renderer/`](src/main/renderer/), talking to the main process over ipc rather than http. the main process spawns the bundled yt-dlp binary once per operation from [`src/main/services/ytdlp/`](src/main/services/ytdlp/), parses its progress, maps its errors, and owns its own updates. electron holds the two together and handles windows, menus and file dialogs.

if you're poking at the telemetry, [`docs/analytics.md`](docs/analytics.md) explains how to read it and which numbers will mislead you.

### note on yt-dlp

cliply depends on yt-dlp, it's what powers the downloading engine. i'm not affiliated with yt-dlp or youtube-dl in any way, and their [full documentation is here](https://github.com/yt-dlp/yt-dlp/wiki) if you're curious.

### contributing

this is open source, so bugs, ideas and pull requests are all welcome. just keep it simple and clean like the rest of the project.

for coding agents, start with [AGENTS.md](AGENTS.md). the [engineering docs](docs/README.md) map the current architecture, binary sources, tests and release workflows. keep those guides current when changing how the app works.

### release notes

the Build Release workflow generates notes before publishing: short installation instructions, github's merged-pr summary, and a collapsed list of commits since the previous published stable app version. it requires the full git history and an authenticated github cli. preview without creating a tag or release with `node scripts/generate-release-notes.js --tag v0.4.1`; use `--tag v0.4.0 --target v0.4.0` to inspect a historical release. `.github/release.yml` groups prs by label, and `.github/RELEASE_NOTES.md` owns the installation text.

### support

cliply is free and it's staying that way. if you'd like to help it along you can [sponsor it](https://github.com/sponsors/devansh1401) or [buy me a coffee](https://buymeacoffee.com/itssdevk), and that's also what would pay for the macos certificate.

### license

[GPL-3.0-only](LICENSE). ffmpeg ships with it; platform-specific source and build provenance are documented in [`third-party/ffmpeg/build-info.md`](third-party/ffmpeg/build-info.md).
