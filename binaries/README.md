# bundled helper binaries

Cliply packages FFmpeg, Deno and the standalone yt-dlp engine. Users do not need to install Python, FFmpeg or Deno separately. The large executables stay out of git.

## fetch the release helpers

From the project root, with Node 22.12 or newer:

```sh
npm run fetch:helpers
npm run fetch:ytdlp
```

The helper downloader uses the same [Cliply `binaries` release](https://github.com/Cliply/Cliply/releases/tag/binaries) as the release workflow. It chooses the current supported platform by default. To prepare another platform explicitly:

```sh
npm run fetch:helpers -- --platform linux-x64
BUILD_TARGET_PLATFORM=linux-x64 npm run fetch:ytdlp
```

The `BUILD_TARGET_PLATFORM` example uses a POSIX shell. In PowerShell, set `$env:BUILD_TARGET_PLATFORM = 'linux-x64'` before running `npm run fetch:ytdlp`. The engine fetcher checks upstream SHA256 sums and keeps the complete standalone directory, including its Python runtime and modules.

| Target | FFmpeg release asset | Deno release asset | Local platform directory |
| --- | --- | --- | --- |
| macOS Apple Silicon | `ffmpeg` | `deno` | `macos` |
| Windows x64 | `ffmpeg.exe` | `deno.exe` | `windows` |
| Linux x64 | `ffmpeg-linux-x64` | `deno-linux-x64` | `linux` |

The resulting layout is:

```text
binaries/
├── deno/
│   ├── linux/deno
│   ├── macos/deno
│   └── windows/deno.exe
├── linux/
│   ├── ffmpeg
│   └── ytdlp/...
├── macos/
│   ├── ffmpeg
│   └── ytdlp/...
└── windows/
    ├── ffmpeg.exe
    └── ytdlp/...
```

macOS and Linux require executable permissions; the downloader and packaging hook set these. Linux binaries cannot be substituted with macOS or Windows executables. Copying a Homebrew FFmpeg executable is not a portable release build: it can depend on libraries installed only on the development machine.

## build and check

Install dependencies and build the renderer before packaging. `npm run prepare:full` prepares icons, the app and yt-dlp; fetch FFmpeg and Deno first as above.

On a Linux x64 machine:

```sh
npm run dist:linux:safe
node scripts/verify-packaged-helpers.js --resources dist/linux-unpacked/resources
```

This creates AppImage and DEB packages without publishing. Release CI builds each platform natively, executes all three packaged helpers, and checks that update metadata references files attached to the release. AppImage uses electron-builder's static runtime toolset; Linux tarballs and ARM builds are not part of the initial release.

For Linux token-recovery payloads, the `Build PO token payload` workflow builds natively on Linux x64 so its canvas native module matches the packaged runtime. It is downloaded on demand rather than added to every installer. The workflow defaults to verification only; publishing to the shared release is an explicit option.

## updating helpers

Keep new Linux assets beside the existing Mac and Windows assets in the shared `binaries` release; do not rename or replace another platform's files. Record the actual upstream version and source in [the FFmpeg build information](../third-party/ffmpeg/build-info.md). Test merging, trimming, audio conversion, HTTPS downloads and YouTube recovery before replacing a helper. Version output alone does not prove those operations work.
