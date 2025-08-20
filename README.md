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

cliply started as a small weekend project, just wanted a simple way to grab videos without ads, bloat, or shady sites. it's free, fast, and respects your privacy. no logins, no tracking, no bs.

## what it is

cliply is a cross-platform video downloader with a nice interface.

currently, you can:

- download videos in multiple qualities (144p to 4k)
- grab audio-only files
- trim clips to specific time ranges
- download entire playlists

new features are being added regularly. got an idea? request it [here](https://cliply.space/hey)

## setup

**install dependencies**

```bash
npm install && npm run install:renderer
```

**set up python environment**

```bash
npm run setup:python:venv && npm run setup:python-deps
```

**get ffmpeg (for trimming & conversion)**  
see [docs/binaries](binaries/README.md) for help

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

## how it works

**frontend:** react + typescript + tailwind → [`src/main/renderer/`](src/main/renderer/)  
**backend:** python fastapi + yt-dlp → [`python/`](python/)  
**desktop:** electron handles the app shell → window management, ipc communication, file operations

built with open source tools, depends on [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## note on yt-dlp

cliply depends on yt-dlp, it's what powers the downloading engine.

we're not affiliated with yt-dlp or youtube-dl in any way. you can check out their [full documentation here](https://github.com/yt-dlp/yt-dlp/wiki) if you're curious.

## contributing

this is open source! feel free to report bugs, suggest features, or submit pull requests. just keep it simple and clean like the rest of the project.

> stuff to do

- [ ] add docs
- [ ] add support for transcripts
- [x] fix race conditions in downloads
- [ ] ffmpeg docs and license
- [ ] fix auto upgrade system
- [ ] add github workflows for new release
