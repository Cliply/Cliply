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
2. The owner authorized new verified assets and their source/build records in
   the existing `binaries` release. Readiness remains a prerequisite: do not
   publish these candidates, replace an existing asset or change licensing to
   bypass missing source/native evidence. No further approval is needed solely
   for the authorized additions once ready.
3. Populate the prepared `published.json` manifest only after verifying the
   uploaded bytes/asset IDs and source records. `scripts/fetch-helpers.js` then
   fetches those now-existing assets into
   `binaries/{macos,linux}/ffprobe` and `binaries/windows/ffprobe.exe`, verifying
   the approved final hashes (signing can change executable bytes). Keep existing
   FFmpeg/Deno/yt-dlp assets intact. Do not enable failing URLs before publication.
4. Resource filters already map those optional files to
   `<resources>/binaries/ffprobe[.exe]`; `after-pack` already prepares/signs a
   present FFprobe. Neither step supplies an absent executable. Make FFprobe a
   required packaged capability with `CLIPLY_REQUIRE_FFPROBE=1` for local-media
   validation; verified published platform records activate that requirement
   automatically. The manifest stays empty until readiness passes.
5. Run native nonpublishing package validation with
   `verify-packaged-helpers.js --resources <actual-resources> --require-ffprobe`
   plus inspection/media checks against that actual resource executable. Stage 7
   cannot claim local-media platform support without this evidence. Workflow
   dispatch, publication and release remain separately authorized actions.

## Stage 7 readiness check — 2 November 2026

The shared release still contains nine existing assets and no FFprobe. Nothing
was uploaded or replaced. All candidate `publicationReady` values remain false.
The macOS archive/executable hashes were reverified and the unchanged candidate
executed natively with the existing Cliply FFmpeg. This is private validation,
not a source-readiness or production-support declaration.

Historical investigation found Riedl's `develop` recipe
[`6a611e19870e197bc37c6e4c7fccddebd3715466`](https://git.martin-riedl.de/ffmpeg/build-script/commit/6a611e19870e197bc37c6e4c7fccddebd3715466).
Its dependency versions match the pinned supplier's 9.0.2 version list. This
supersedes the initial comparison against main's older 9.0.1 recipe. It still
does not identify every exact source: `script/build-x264.sh` downloads
`x264-master.tar.gz` from the moving `master` branch and the supplier list records
only `0.165.x`. Matching complete library sources, notices and recipe provenance
remain unresolved; version agreement alone is not a redistribution packet.

The dated BtbN release resolves to build scripts
[`5ece62897c650b863c1ddda7b6964845344aef2d`](https://github.com/BtbN/FFmpeg-Builds/tree/5ece62897c650b863c1ddda7b6964845344aef2d).
Its current archive API digests match the pinned candidates. Dependency recipes
include commit pins, but `addins/8.1.sh` selects a moving release branch and the
build checks out that branch. An exact builder commit alone does not constitute
the complete sources and notices for every library linked into the candidate.
Those materials have not been assembled and matched; native Windows/Linux
version, license, libraries, media and package execution remain pending.

The next validation needs native Windows x64 and Ubuntu 24.04 x64 hosts, plus
minimum-OS checks (including macOS 13). The available host is macOS ARM64; no
self-hosted GitHub runners were registered. No workflow was dispatched. The
prepared CI `local_media_check=true` gate deliberately fails acquisition while
this manifest is empty. The separate `validate-ffprobe-candidate.yml` workflow
tests pinned candidates in disposable native packages before publication, with
no production manifest changes. See [release checks](../../docs/releasing.md).

## FFprobe-only build evaluation

[`build-ffprobe-prototype.js`](../../scripts/build-ffprobe-prototype.js) evaluates
an alternative executed locally on macOS ARM64. The first native Windows x64
and Ubuntu 24.04 x64 attempts exposed source-export/configuration issues. A second
run compiled Windows but refused its winpthread DLL dependency; Linux passed
backend checks and stopped at the copied test app sandbox setup. Further corrected
recipes/harnesses await native rerun. It exports clean source from FFmpeg n8.1,
commit `9047fa1b084f76b1b4d065af2d743df1b40dfb56`, and builds FFprobe with internal
demuxers/parsers/decoders and file/pipe/fd protocols. Autodetection, network,
external codec libraries, other programs, filters and resamplers are checked off
in the final configuration. `--disable-everything` alone is not proof of those
properties, and requested decoders with unmet dependencies remain disabled.
This retains the leading-video decoding needed for trim validation. `--enable-small`
was rejected because it removes codec profile names needed by existing gates.
The recipe uses `-O1`: repeated Apple clang 16 default-optimization builds emitted
different instruction bytes. It targets macOS 13 and records the actual compiler,
SDK, configuration, source/executable hashes, license and system libraries.
On Mac, all build commands, including configure and make, are launched through
`/usr/bin/arch -arm64`. An ARM64 Node process can otherwise pass an inherited
Intel preference to universal child executables. The recipe checks ARM64 child
execution, an ARM64 Darwin Apple clang target and a thin ARM64 final executable;
it fails instead of selecting an x86 assembler or accepting an Intel build.

```sh
node scripts/build-ffprobe-prototype.js --source <absolute-pinned-FFmpeg-checkout> --output <new-absolute-owned-directory>
```

No global dependencies are installed and no project helper is replaced. Keep
the output in task-owned temporary space. The complete exported source includes
upstream license files; native `-L` reports LGPL 2.1 or later for this configuration.
This is an evaluation, not a production pin or a change to Cliply's GPL license.
The candidate-validation workflow tests the existing supplier pins; it does not
build or test this alternative prototype.
The separate source-built CI mode tests the exact built artifact through the
existing package/media/UI harness. The Mac draft corresponding-source packet
includes full source, hashed recipes/toolchain/configuration, all source notices,
IJG attribution and offline rebuild instructions. See the
[source-build and distribution specification](source-build.md) for exact commands,
official toolchain evidence and deterministic source-asset preparation.
Windows/Linux native execution and runtime notices, minimum OS, final per-platform
source/notice integration and reviewer selection remain required before production.


Source validation now stages the verified Mac packet's installed NOTICE,
[LGPL text](COPYING.LGPLv2.1) and exact source/binary mapping, with post-signing
hash verification. Production notice records remain absent until final review.
An explicit source-CI retention option preserves only a successfully validated
helper and exact source/build/notice inputs as a two-day reviewer artifact;
incomplete Windows/Linux runtime packets stay unapproved. See the
[source guide](source-build.md#optional-short-lived-reviewer-artifact).
