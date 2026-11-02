# FFmpeg build information

Cliply bundles one FFmpeg executable for each supported platform. They are separate builds, not one universal binary. The shared [binaries release](https://github.com/Cliply/Cliply/releases/tag/binaries) is the source used by packaging workflows.

## Linux x64

- Upstream builder: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
- Upstream release: [`autobuild-2026-11-01-12-49`](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-01-12-49).
- Archive: `ffmpeg-n8.1.3-29-gad3b795b72-linux64-gpl-8.1.tar.xz`.
- FFmpeg version: `n8.1.3-29-gad3b795b72`; source commit prefix: `ad3b795b72`.
- Build family: Linux x86-64, GPL, static FFmpeg 8.1 branch.
- Cliply asset: `ffmpeg-linux-x64`. Packaging copies only the `ffmpeg` executable, not the upstream archive or ffplay/ffprobe.

The helper-staging workflow prints the actual executable's version, build configuration and license before publication, verifies media operations natively, and checks its archive against the upstream SHA256 listing. Keep that provenance with the release asset when replacing it. BtbN's repository contains its build scripts and third-party dependency definitions; the exact FFmpeg revision can be resolved in the [official source repository](https://github.com/FFmpeg/FFmpeg/commit/ad3b795b72).

## macOS Apple Silicon

- Existing Cliply asset: `ffmpeg` (ARM64).
- Observed version: `8.1-https://www.martin-riedl.de`.
- Builder: [Martin Riedl](https://www.martin-riedl.de/).
- This Linux packaging change does not replace the existing macOS asset.

## Windows x64

- Existing Cliply asset: `ffmpeg.exe`.
- Observed version: `N-119857-g49e52ca24f-20250608`.
- Its exact original upstream archive/build recipe has not been established from the existing asset record. Do not substitute the Linux build provenance for it.
- This Linux packaging change does not replace the existing Windows asset.

## Historical source archive

`FFmpeg-d9797544b45a6f2fbd334dd41194b95026555297.zip` is retained as a historical source snapshot. It corresponds to revision `d9797544b45a6f2fbd334dd41194b95026555297`; it does **not** represent the exact source for every currently bundled platform binary.

## Source and licensing

FFmpeg is [licensed under LGPL or GPL depending on its configuration](https://ffmpeg.org/legal.html), and external libraries can add further terms. `--enable-gpl` alone does not establish that a binary is GPLv3. Use each actual executable's `-L` output and its build configuration when recording its license.

Distributing a GPL binary requires the corresponding source and applicable license/build information for that binary and its included libraries. A different historical source snapshot or a link to current FFmpeg master is not a substitute. Preserve the upstream source/build material for the exact release whenever updating a helper, and make it available alongside distribution as required by the applicable licenses.

Cliply's application license is [GPL-3.0-only](../../LICENSE).
