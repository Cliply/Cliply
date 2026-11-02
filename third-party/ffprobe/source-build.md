# Source-built FFprobe evaluation

This is a separate alternative to the supplier pins in `candidates.json`.
It is not production-selected. `published.json` stays empty. Existing FFmpeg,
Deno and yt-dlp are unchanged. No runtime helper downloader is introduced.

## Exact source and build design

The [source pin](source-build.json) records FFmpeg n8.1 commit
`9047fa1b084f76b1b4d065af2d743df1b40dfb56`, the SHA256 of its complete Git tar
export, and hashes of the upstream license files and three IJG-derived files.
The builder accepts either that Git checkout or the exact tar export. It checks
the archive before extracting and does not patch upstream source.

`--disable-everything` disables components; it does not itself disable every
program or internal library. The recipe requests FFprobe, demuxers, parsers,
decoders and file/pipe/fd protocols, with external autodetection and network
disabled. Components with unavailable dependencies remain disabled. It does not
promise every format/decoder. The final configuration is checked for FFprobe,
avcodec/avformat/avutil, H.264/AAC decoding, exactly those three protocols, no
FFmpeg/FFplay program, no GPL/version3/nonfree, no shared FFmpeg libraries and no
avdevice/avfilter/swscale/swresample. Every external/hardware-library variable
from the pinned configure lists is checked, not just the command-line flags.

FFprobe statically includes enabled FFmpeg libraries. It still uses operating-
system and compiler-runtime facilities. Native executable headers, compiler
target, configuration and dependency imports are checked; unexpected dependencies
fail rather than being copied into the app. `-O1` retains the locally tested
Mac behavior and avoids the observed Apple clang default-optimization variance.

## Native recipes and available tools

| Target | Explicit toolchain/target | Evidence boundary |
| --- | --- | --- |
| macOS ARM64 | Apple clang; all commands through `/usr/bin/arch -arm64`; target macOS 13 | Locally executed; compiler, SDK and actual tool hashes recorded |
| Ubuntu 24.04 x64 | `/usr/bin/gcc-13`, NASM, `--arch=x86_64 --target-os=linux`, baseline x86-64 | Prepared for native CI; no Linux execution claimed from the Mac host |
| Windows x64 | MSYS2 UCRT64 GCC/NASM, `--arch=x86_64 --target-os=mingw32`, native Win32 threads | Prepared for native CI; no Windows execution claimed from the Mac host |

Windows uses an explicitly supplied MSYS2 root and its UCRT64 compiler rather
than the MSYS compiler. It links libgcc statically, disables PE linker timestamps
and refuses non-system DLL imports (including MSYS, libgcc and winpthread DLLs).
This does not establish the licensing/source requirements of statically included
compiler-runtime objects: inspect the first native link/toolchain evidence and
retain the matching runtime notices before distributing a Windows asset.
Linux permits only the recorded standard libc/libm/pthread/dl/rt/libgcc/loader
dependencies; ELF version requirements and native ldd resolution are retained.
Ubuntu 24.04 builds do not imply compatibility with older glibc distributions.

Official availability evidence checked 2 November 2026:

- [GitHub Windows 2025 image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
  documents MSYS2, GCC, Bash and Visual Studio. The prepared workflow uses an
  owned MSYS2 installation on the disposable runner instead of relying on PATH.
- [GitHub Ubuntu 24.04 image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
  documents GCC 13 and build tools. The job explicitly installs gcc-13, make,
  binutils and NASM on that disposable runner.
- [MSYS2 environments](https://www.msys2.org/docs/environments/) define UCRT64;
  the [setup action](https://github.com/msys2/setup-msys2/tree/ec48f7c5447b3140e2b088413ae3a55687bccb6e)
  supports a task-owned location and exposes its actual path. The workflow pins
  that action commit, disables its cache and records installed package versions.
- Official [UCRT64 GCC](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-gcc),
  [NASM](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-nasm) and
  [CRT](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-crt) records expose
  package/source versions and license metadata. Native package resolution is
  rolling, not a claim of a pinned/reproducible Windows toolchain. First-run
  toolchain manifests must be reviewed and frozen before final distribution.

The script records compiler/version/target, make, tool executable hashes, SDK
settings or native package versions, final configuration, binary hash/size,
license, library imports and load commands. Minimum-OS execution is separate
from compiler deployment flags or runner OS labels.

## Local commands

Use a new task-owned absolute output directory. Native host/architecture only:
Before native package validation, install the existing project dependencies and
ordinary platform helpers and run `npm run build:renderer` for the current source.
The CI workflow does these prerequisites; a preserved older dist is not sufficient.

```sh
node scripts/build-ffprobe-prototype.js --source <absolute-pinned-checkout> --output <new-owned-build>
node scripts/build-ffprobe-prototype.js --archive <absolute-exact-source.tar> --output <new-owned-build>
node scripts/validate-ffprobe-candidate.js --source-build <absolute-build> --evidence <new-owned-evidence>
```

On Windows also pass `--msys-root <absolute-UCRT64-installation>` to the builder,
or set `CLIPLY_FFPROBE_MSYS2`. No global tools are installed by these scripts.
The explicit source-build validation branch verifies the record, archive,
recipe, configuration and executable, then copies the exact artifact into a
disposable native app. Existing helper/inspection/four-tool/cancel/crash/package/
UI/normal-service/concurrent-download checks run against that packaged artifact.
Mac signing can change bytes; input and packaged SHA256/size are recorded.
The supplier branch and its workflow continue to use only supplier pins.

The complete source path is:

```sh
node scripts/validate-ffprobe-source.js --source <absolute-pinned-checkout> --evidence <new-owned-evidence>
```

Omit `--source` to fetch only the pinned commit into owned scratch. The script
builds, prepares the Mac draft source packet twice, checks packet determinism,
runs native validation and removes large scratch artifacts. It retains only
small build/log/configuration/package evidence. Source acquisition and native
build failures remain failures; no supplier or platform fallback exists.

After separate push/CI authorization, use existing **CI** on the reviewed ref,
`ffprobe_source_check=true`, all other inputs false. It calls the reusable
`validate-ffprobe-source.yml` at that same commit. Supplier mode retains priority
if both flags are accidentally set. Both validation modes exclude ordinary app
and helper-publication jobs. No workflow is dispatched by this change.

## Corresponding-source packet specification

The Mac draft asset is produced with existing developer tooling:

```sh
node scripts/package-ffprobe-source.js --build <absolute-verified-build> --output <new-owned-packet-directory>
```

Name: `ffprobe-source-<commit12>-darwin-arm64-<unsigned-executable-sha12>-<packet-sha12>.tar.gz`.
The content digest keeps source/notice revisions from colliding even if the
executable bytes stay unchanged.
This is a proposed NEW source asset, not an upload or production manifest entry.
It contains:

- The complete exact unmodified upstream tar, including every per-file notice,
  optional unused source and upstream build machinery.
- The standalone Node build recipe, source pin and packaging recipe; Cliply's
  GPL-3.0-only license for those scripts, separately from FFprobe's license.
- Upstream LICENSE.md, all four COPYING files and the full unmodified IJG-derived
  source files. [The notice](NOTICE.source-build.txt) credits the Independent JPEG
  Group and states that Cliply made no edits to those files from the pinned tree.
- Native build/toolchain/configuration/license/dependency evidence, exact
  executable/source/recipe hashes, a file checksum manifest and offline
  reproduction instructions. Task output paths are normalized to `$BUILD`;
  compiler paths/versions/hashes and system dependencies are retained.

The pinned upstream LICENSE.md describes LGPL-2.1-or-later as the combined
default, other per-file terms and optional GPL parts. Native `-L` must agree;
GPL/version3/nonfree are independently checked off. A top-level LGPL text alone
would omit relevant IJG attribution, so complete notices/source are preserved.
This packet applies to this separate FFprobe executable; it does not assert that
Cliply's existing FFmpeg assets have matching provenance.

Packing uses the existing locked `tar` developer package, sorted explicit files,
portable metadata, mtime zero, fixed file modes and gzip level 9. Tool versions
are in the manifest. Repeating with the same inputs/tool versions must yield the
same hash. Rebuilding the executable from the packet needs only Node and the
recorded native toolchain, not Cliply/npm dependencies, Python or network access.
Source packets are not embedded in installers. Future packaging must include
NOTICE.source-build.txt as `resources/third-party/ffprobe/NOTICE.txt` and
COPYING.LGPLv2.1 as `resources/third-party/ffprobe/COPYING.LGPLv2.1`, together with
a small SOURCE.json linking the final binary/source hashes and source asset URL.
Provide the verified source asset beside the new helper
release asset. Final source URLs, signed binary hashes and source asset hashes
belong in the reviewed publication record after actual upload verification.

Only Mac packet assembly is locally audited. Packet generation deliberately
refuses Windows/Linux records until native runtime/dependency/notices review.
No codec source gap is hidden by that refusal. Native Windows/Linux evidence,
toolchain reproducibility, minimum OS, clean installed/offline behavior, storage
coverage, final per-platform notice integration and verified publication remain
gates before production selection. Archive size is source-distribution overhead,
not installer growth; measure the small installed notice delta separately.
