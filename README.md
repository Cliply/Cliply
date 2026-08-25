<p align="center">
  <h1 align="center">cliply</h1>
  <img src="assets/stars.jpeg" width="1024" alt="image :D " />
  <br />
  <p align="center"><i>a clean little desktop app to download videos</i></p>
 <div align="center">
  <a href="https://cliply.space"><img src="https://img.shields.io/badge/visit-our_page-blue?style=for-the-badge&logo=globe&logoColor=white&size=10" alt="visit our page" /></a>
  <a href="https://x.com/cliplydotspace"><img src="https://img.shields.io/badge/follow-@cliplydotspace-black?style=for-the-badge&logo=x&logoColor=white&size=10" alt="follow us on x" /></a>
</div>
</p>

cliply started as a small weekend project, just wanted a simple way to grab videos without ads, bloat, or shady sites. it's free, fast, and respects your privacy. no logins, no ads, no cross-site tracking, no bs. it does send a little usage data so we can find bugs, and one click in the Tools menu turns that off — [what it sends, exactly](PRIVACY.md).

## what it is

cliply is a cross-platform video downloader with a nice interface.

currently, you can:

- download videos in multiple qualities (144p to 4k)
- grab audio-only files
- trim clips to specific time ranges
- save transcripts as srt, vtt or plain text

new features are being added regularly. got an idea? request it [here](https://cliply.space/hey)

## setup

**install dependencies**

```bash
npm install && npm run install:renderer
```

**get the yt-dlp engine**

```bash
npm run fetch:ytdlp
```

downloads the official yt-dlp build for your platform into `binaries/`, checksum-verified. no python needed — the app spawns the binary directly and keeps it up to date on its own.

**get ffmpeg and deno**

ffmpeg does the merging, trimming and conversion; deno is the javascript runtime
yt-dlp needs for youtube. see [binaries/README.md](binaries/README.md) for the
commands, and [docs/ffmpeg.md](docs/ffmpeg.md) for what ffmpeg is used for and
what its license asks of us.

**run it locally**

```bash
npm run dev
```

## building

```bash
# build everything
npm run prepare:full

# create packages
npm run dist

# platform specific
npm run dist:mac
npm run dist:win
npm run dist:linux
```

cutting an actual release is a button in Actions — see
[docs/releasing.md](docs/releasing.md).

## docs

[`docs/`](docs/) has the longer explanations:

| | |
| --- | --- |
| [architecture](docs/architecture.md) | what the three processes are and what each one owns |
| [development](docs/development.md) | the scripts, the two test suites, the conventions |
| [ipc](docs/ipc.md) | every channel between the renderer and main |
| [transcripts](docs/transcripts.md) | how subtitle downloads work, end to end |
| [updates](docs/updates.md) | the two independent updaters |
| [releasing](docs/releasing.md) | building installers and cutting a release |
| [ffmpeg](docs/ffmpeg.md) | what it does here, and what the GPL asks of a fork |
| [troubleshooting](docs/troubleshooting.md) | the failures people actually hit |
| [analytics](docs/analytics.md) | how to read the dashboards without being misled |

## how it works

**frontend:** react + typescript + tailwind → [`src/main/renderer/`](src/main/renderer/)  
**engine:** the electron main process spawns the bundled yt-dlp binary once per operation → [`src/main/services/`](src/main/services/)  
**desktop:** electron handles the app shell → window management, ipc communication, file operations

built with open source tools, depends on [yt-dlp](https://github.com/yt-dlp/yt-dlp).
everything cliply ships that somebody else wrote is listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## note on yt-dlp

cliply depends on yt-dlp, it's what powers the downloading engine.

we're not affiliated with yt-dlp or youtube-dl in any way. you can check out their [full documentation here](https://github.com/yt-dlp/yt-dlp/wiki) if you're curious.

## contributing

this is open source! feel free to report bugs, suggest features, or submit pull requests. just keep it simple and clean like the rest of the project.

> stuff to do

- [x] add docs
- [x] add support for transcripts
- [x] fix race conditions in downloads
- [x] ffmpeg docs and license
- [x] fix auto upgrade system
- [x] add github workflows for new release

next up:

- [ ] code signing, so macOS can auto-update and windows stops warning
- [ ] more platforms (instagram is stubbed in `SUPPORTED_PLATFORMS` and not wired up)
- [ ] playlist downloads — the engine already has a `playlist-info` operation with no ui
