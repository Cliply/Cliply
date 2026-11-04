# Bundled FFprobe

Cliply builds FFprobe from official, unmodified FFmpeg n8.1.3 source at
`1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7`. The exact source archive, upstream
notices and build configuration are pinned in [source-build.json](source-build.json).
Existing FFmpeg, Deno, yt-dlp and recovery helpers are unchanged.

[Published records](published.json) select one verified helper for each supported
target: macOS Apple Silicon ARM64, Windows x64 and Linux x64. The helper and its
matching source/build/notice archive are separate assets in Cliply's existing
[`binaries` release](https://github.com/Cliply/Cliply/releases/tag/binaries).
The source archive is not included in installers.

| Target | Local build destination | Packaged resource |
| --- | --- | --- |
| `darwin-arm64` | `binaries/macos/ffprobe` | `binaries/ffprobe` |
| `win32-x64` | `binaries/windows/ffprobe.exe` | `binaries/ffprobe.exe` |
| `linux-x64` | `binaries/linux/ffprobe` | `binaries/ffprobe` |

Asset names include the source commit, platform and binary hash. Source archives
also include their own content hash. Never replace an older versioned asset:
older source refs must retain their pinned inputs. The manifest records asset IDs,
SHA256 and the checksum of `distributions/<platform>/SOURCE.json`. Fetching uses
the exact asset name and verifies SHA256 and executable architecture before
installing it. Published platforms automatically require FFprobe in fetching,
after-pack and packaged-helper verification; an incomplete build fails.

The installed `resources/third-party/ffprobe/SOURCE.json` binds the input helper,
source archive and notice files to the actual packaged executable after macOS
signing. Linux/Windows helpers must retain their original bytes. Git attributes
preserve canonical LF source/build and notice records on every checkout.

The app runs the bundled executable by absolute path. It never installs FFprobe
on first use, searches PATH/Homebrew or downloads a helper when a file opens.
Updates to FFprobe arrive through a new app build/update. For explicit local
development only, `CLIPLY_DEV_FFPROBE` may name a verified absolute executable;
packaged apps ignore that override.

## Build and verify

```sh
node scripts/fetch-helpers.js --platform <darwin-arm64|win32-x64|linux-x64> --require-ffprobe
```

Native source validation builds the pinned source and tests the exact artifact,
including packaged media operations, compatibility playback, cancellation, normal
services and concurrent download recovery. Source/runtime/notice hashes and
unexpected library imports remain strict gates. The Windows helper uses system
Windows/UCRT DLLs without an MSYS2/compiler DLL installation; Linux uses the
reviewed system libc/libm; macOS uses Apple system libraries/frameworks.

See [source/build records](source-build.md) and the [release guide](../../docs/releasing.md)
for source qualification, explicit promotion and final installer validation.
Promotion checks all three retained native artifacts before adding any release
asset, never overwrites an asset, and re-downloads uploads before generating
production records. Original evaluation markers remain part of the immutable
build evidence; production selection is recorded separately in `published.json`
and the verified distribution records.

Native acceptance covers the actual runner OS versions documented in the release
guide. Deployment flags do not establish minimum-OS execution, broader Linux
compatibility or Developer ID/Gatekeeper acceptance. No installer is published by
the nonpublishing validation workflow.

## Alternative supplier fixtures

[candidates.json](candidates.json) retains the earlier Riedl/BtbN supplier inputs
for explicit comparison tests. They are not production-selected or approved by
the source-built qualification. `stage-ffprobe.js` and supplier CI continue to
operate in owned scratch copies, preserving production pins and project helpers.
Source candidate validation likewise clears production records only in its
private project, so a published helper cannot contaminate the next candidate run.
