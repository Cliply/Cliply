# FFprobe candidates — inspection development only

Stage 1 verified these upstream archives on 2 November 2026. No FFprobe asset
exists in Cliply's shared `binaries` release (release ID `279753250` at inspection).
No helper was published or installed into the project. Existing FFmpeg, Deno and
yt-dlp files are unchanged. Production local inspection therefore reports
`PROBE_MISSING`; downloads remain available.

[candidates.json](candidates.json) pins the real archive URLs, checksums, exact
members and extracted executable hashes. These are upstream candidate URLs, not
invented Cliply release URLs. `publicationReady: false` is intentional on all
three entries. The developer must explicitly acquire and inject a candidate.

| Target | Proposed shared asset | Extracted bytes | Evidence established |
| --- | --- | ---: | --- |
| macOS ARM64 | `ffprobe` | 66,158,064 | Published archive checksum; executable SHA256; ARM64 Mach-O; signature verification; native version/build/license; WAV and H.264/AAC MP4 inspection; Electron 45.2.1 bridge |
| Linux x64 | `ffprobe-linux-x64` | 172,850,664 | Published archive digest; extracted SHA256; ELF x86-64 header; exact archive member; no native execution |
| Windows x64 | `ffprobe.exe` | 165,371,904 | Published archive digest; extracted SHA256; PE x86-64 header; exact archive member; no native execution |

These are uncompressed helper sizes, not measured installer growth or runtime
memory. They are large enough that final packaging must measure the actual delta.

## Origin, build and source records

The macOS candidate comes from [Martin Riedl's build server](https://ffmpeg.martin-riedl.de/),
dated 20 September 2026, version `9.0.2-https://www.martin-riedl.de`, built with
Apple clang 14.0.0. It differs from Cliply's existing FFmpeg 8.1. Its `-L` reports
GPL version 3 or later; `-buildconf` includes `--enable-gpl`, `--enable-version3`,
static library configuration and the bundled codec/library options. `otool -L`
lists Apple system libraries/frameworks, with no Homebrew paths. The Mach-O load
command declares minimum macOS 12.0 / SDK 12.3; execution was tested only on
macOS 26.6.2 ARM64, not Cliply's minimum macOS 13. `codesign --verify --strict`
passed; the signature names Martin Riedl, team `KU3N25YGLU`.

The [supplier version list](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt)
records included library versions. The [build-script repository](https://git.martin-riedl.de/ffmpeg/build-script)
documents the build and dependencies, and [FFmpeg n9.0.2](https://github.com/FFmpeg/FFmpeg/tree/n9.0.2)
is the named upstream source version. The exact supplier build-script revision,
any local patches and complete corresponding source for all included libraries
have **not** been assembled/verified for redistribution. A current script or
version label is not a complete source package. This remains a publication gap.

Linux and Windows candidates use [BtbN's dated release](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-01-12-49),
the GPL/static-library 8.1 family `n8.1.3-29-gad3b795b72`. The Linux archive is
the same one recorded for the existing FFmpeg; Windows is a separate candidate,
not a provenance claim about the existing 2025 Windows FFmpeg. The named FFmpeg
source is [ad3b795b72388fbb2b216e1e6fd38fba994e1df0](https://github.com/FFmpeg/FFmpeg/commit/ad3b795b72388fbb2b216e1e6fd38fba994e1df0).
[BtbN's build scripts and dependency definitions](https://github.com/BtbN/FFmpeg-Builds)
are the builder reference. The ELF still uses the system loader
`/lib64/ld-linux-x86-64.so.2`; “static” does not mean no system-library dependency.
Native `-version`, `-buildconf`, `-L`, library checks, minimum-OS/media checks and
complete corresponding-source records remain pending on both platforms.
BtbN documents a limited daily archive retention policy: retain exact upstream
material through an authorized source/helper publication before relying on it.

No LosslessCut code, types, tests, fixtures or assets were copied or translated.
Its pinned probe/lifecycle behavior was consulted as research. Cliply's modules
use Node built-ins, existing Cliply archive/architecture utilities and documented
FFprobe CLI options. No licence change or maintainer contact occurred.

## Reproduce staging without publication

Read the URL for the chosen platform from `candidates.json`. Download that archive
into a task-owned temporary directory (for example with `curl --fail --location
--output <temp-archive> <recorded-url>`), then run:

```sh
node scripts/stage-ffprobe.js --platform darwin-arm64 --archive <temp-archive> --output <new-temp-directory>
node scripts/smoke-local-media.js --ffprobe <absolute-staged-ffprobe> --ffmpeg <absolute-existing-Cliply-ffmpeg>
```

Use `linux-x64` or `win32-x64` for their pinned archives. Staging verifies archive
and executable hashes plus architecture, extracts into owned scratch space, and
refuses an existing output directory. It writes only the proposed asset and an
evidence JSON. Native-host staging also records version/build/license. ZIP
extraction uses Cliply's existing reader; Linux `.tar.xz` extraction needs `tar`
with xz support. The script never fetches, uploads or edits project helpers.
Delete your temporary archive/output after inspection. No Python is needed.

## Work required before production availability

1. Complete corresponding-source/notices records, native execution and media
   checks for each candidate. Do not infer GPL terms from the archive family
   alone; retain each native `-L` and build configuration.
2. After separate owner authorization, publish the three verified executables
   with their source/build records under the proposed shared asset names.
3. Extend `scripts/fetch-helpers.js` to fetch those now-existing assets into
   `binaries/{macos,linux}/ffprobe` and `binaries/windows/ffprobe.exe`, verifying
   the approved final hashes (signing can change executable bytes). Keep existing
   FFmpeg/Deno/yt-dlp assets intact. Do not enable failing URLs before publication.
4. Resource filters already map those optional files to
   `<resources>/binaries/ffprobe[.exe]`; `after-pack` already prepares/signs a
   present FFprobe. Neither step supplies an absent executable. Make FFprobe a
   required packaged capability when the production assets are available.
5. Run native nonpublishing package validation with
   `verify-packaged-helpers.js --resources <actual-resources> --require-ffprobe`
   plus inspection/media checks against that actual resource executable. Stage 7
   cannot claim local-media platform support without this evidence. Workflow
   dispatch, publication and release remain separately authorized actions.
