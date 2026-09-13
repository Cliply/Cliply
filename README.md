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

### get it

grab it from [releases](https://github.com/Cliply/Cliply/releases/latest), or [cliply.space](https://cliply.space/downloads) if you'd rather just click a button. windows gets an `.exe` installer, macos a `.dmg` for apple silicon. an intel mac has to build from source for now, and linux isn't packaged yet, though it builds and runs fine if you want to.

the first launch on macos shows a warning that says the app can't be checked for malicious software. that's gatekeeper, and it isn't about cliply specifically. apple only stops showing it once the app is signed with a paid developer certificate, and cliply doesn't make any money. so for now, this clears it:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Cliply.app
```

all that does is drop the "downloaded from the internet" flag. only ever run it on something you actually trust, like a release off this page.

### setup

node 18 or newer.

```bash
npm install && npm run install:renderer
npm run fetch:ytdlp
npm run dev
```

`fetch:ytdlp` pulls the official yt-dlp build for your platform into `binaries/`, checksum-verified. no python needed, the app spawns the binary directly and keeps it current on its own. you'll want ffmpeg and deno as well, and [binaries/README.md](binaries/README.md) walks through both.

`npm run dist` packages it for your platform. `npm test` runs the main process suite and `npm run test:renderer` runs the interface one, and both run on every pull request. the main suite is macos only, since it asserts posix file modes and process signals.

### how it works

the interface is react and typescript in [`src/main/renderer/`](src/main/renderer/), talking to the main process over ipc rather than http. the main process spawns the bundled yt-dlp binary once per operation from [`src/main/services/ytdlp/`](src/main/services/ytdlp/), parses its progress, maps its errors, and owns its own updates. electron holds the two together and handles windows, menus and file dialogs.

if you're poking at the telemetry, [`docs/analytics.md`](docs/analytics.md) explains how to read it and which numbers will mislead you.

### note on yt-dlp

cliply depends on yt-dlp, it's what powers the downloading engine. i'm not affiliated with yt-dlp or youtube-dl in any way, and their [full documentation is here](https://github.com/yt-dlp/yt-dlp/wiki) if you're curious.

### contributing

this is open source, so bugs, ideas and pull requests are all welcome. just keep it simple and clean like the rest of the project.

### support

cliply is free and it's staying that way. if you'd like to help it along you can [sponsor it](https://github.com/sponsors/devansh1401) or [buy me a coffee](https://buymeacoffee.com/itssdevk), and that's also what would pay for the macos certificate.

### license

[GPL-3.0-only](LICENSE). ffmpeg ships with it under the same terms, and its source is in [`third-party/`](third-party/).
