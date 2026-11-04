# bundled helper binaries

Cliply packages FFmpeg, Deno and the standalone yt-dlp engine. Users do not need to install Python, FFmpeg or Deno separately. The large executables stay out of git.

Local-file inspection has a separate, optional FFprobe resolver. Shared FFprobe
assets are not published yet, so normal builds report missing inspection support
without disabling downloads. A local-media build must explicitly require FFprobe;
resource filters alone do not supply it. See the [candidate/staging record](../third-party/ffprobe/README.md)
for verified development inputs, proposed asset names and remaining platform/source gaps.

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

## where the files come from

| Component | Build source and update ownership |
| --- | --- |
| FFmpeg | CI fetches the platform executable from Cliply's helper release. Linux staging verifies a dated BtbN upstream archive; Mac and Windows have their own existing provenance. Exact records belong in [build-info.md](../third-party/ffmpeg/build-info.md). |
| Deno | CI fetches the platform executable from the same helper release. Linux staging extracts the official [denoland/deno](https://github.com/denoland/deno/releases) archive, using the version selected in the staging workflow. |
| yt-dlp | [fetch-ytdlp.js](../scripts/fetch-ytdlp.js) downloads official [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases), verifies SHA256 and preserves the onedir payload. [YtdlpUpdater](../src/main/services/ytdlp-updater.js) independently owns the writable runtime copy and later upstream updates. |
| PO token recovery | [Build PO token payload](../.github/workflows/build-pot-payload.yml) assembles the [bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) plugin and generator with native dependencies per platform. Published `pot-<version>-<platform>.zip` files live in the helper release; the installer verifies the selected hash in `pot-installer.js`. This is downloaded on demand, not bundled into every installer. |

[fetch-helpers.js](../scripts/fetch-helpers.js) stages FFmpeg/Deno downloads,
checks their native executable architecture and sets permissions before installing
them. It does not pin their content digests. The Linux upstream staging workflow
checks archive SHA256, while yt-dlp and PO installations have their own checksum
gates. Do not mistake these different checks for one universal verification path.

## asset names and resource layout

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

`package.json` maps those platform trees into packaged
`<resources>/binaries/ffmpeg[.exe]`, `<resources>/binaries/deno/deno[.exe]` and
`<resources>/binaries/ytdlp/`. Keep the entire yt-dlp directory, including
`_internal/`; the executable alone is incomplete. At startup the app seeds a
writable copy under Electron user data. Packaged resources and the writable engine
are different locations. See [architecture](../docs/architecture.md) and
[release validation](../docs/releasing.md) for their lifecycles.

FFprobe's prepared paths are `binaries/macos/ffprobe`,
`binaries/linux/ffprobe`, `binaries/windows/ffprobe.exe`, copied when present to
`<resources>/binaries/ffprobe[.exe]`. The reviewed publication manifest
[`published.json`](../third-party/ffprobe/published.json) is intentionally empty.
Until it has a platform record, `fetch:helpers` fetches only FFmpeg and Deno.
Each production record contains a versioned `assetName`, verified shared-release
asset ID, executable SHA256 and source-record reference/checksum. FFprobe asset
names are `ffprobe-<source-commit12>-<platform>-<sha256-first12>[.exe]`; only Windows
uses `.exe`. The build downloader uses that exact name, then installs it under
the stable local filename above. Old release assets are retained, so older pinned
builds remain fetchable. Fetching verifies the hash and architecture
before installing any staged helper. It never follows an upstream “latest” URL.
A changed shared asset fails the pinned hash check; it cannot silently update the
helper used by an app build. The source archive has its own content-addressed
asset name and hash; its URL is included in the installed notice record.

`node scripts/fetch-helpers.js --require-ffprobe` fails before downloading anything
when the platform has no publication record. `CLIPLY_REQUIRE_FFPROBE=1` applies
the same requirement to fetching, after-pack and packaged-helper validation.
A published platform automatically requires FFprobe in all three. Local inspection
works offline once a complete app is installed; FFprobe updates travel with app
updates, not a separate runtime downloader. Existing installations do not change
when a GitHub asset changes.

For explicit local development, `CLIPLY_DEV_FFPROBE` may name an absolute,
verified task-owned executable when `NODE_ENV=development`; packaged apps ignore
this override. The resolver never uses PATH/Homebrew or downloads on file open.

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
