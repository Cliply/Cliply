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
Git exports explicitly use LF line endings and tar umask `0002`, independently
of host Git settings. Git for Windows' CRLF conversion also affects `git archive`;
the first native run exposed that mismatch. The canonical archive hash stays
unchanged, and the export does not modify local or global Git configuration.

`--disable-everything` disables components; it does not itself disable every
program or internal library. The recipe requests FFprobe, demuxers, parsers,
decoders and file/pipe/fd protocols, with external autodetection and network
disabled. Components with unavailable dependencies remain disabled. It does not
promise every format/decoder. The final configuration is checked for FFprobe,
avcodec/avformat/avutil, H.264/AAC decoding, exactly those three protocols, no
FFmpeg/FFplay program, no GPL/version3/nonfree, no shared FFmpeg libraries and no
avdevice/avfilter/swscale/swresample. Every external/hardware-library variable
from the pinned configure lists is checked, not just the command-line flags.
Linux also passes `--disable-iconv`: this pinned configure script still probes
libc iconv when autodetection is disabled. The first Ubuntu run correctly failed
the external-library audit on `CONFIG_ICONV=yes`; the audit remains strict.

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
than the MSYS compiler. It requests static compiler/runtime archives, disables PE linker timestamps
and refuses non-system DLL imports (including MSYS, libgcc and winpthread DLLs).
The second native run exposed an actual `libwinpthread-1.dll` import despite
FFmpeg pthreads being disabled and `-static-libgcc`. The corrected link adds
`-static`; the DLL allow-list remains unchanged. [GCC's link documentation](https://gcc.gnu.org/onlinedocs/gcc/Link-Options.html)
distinguishes static library selection from the libgcc-only option, and the
[UCRT64 winpthreads package](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-winpthreads)
contains both static and DLL import archives. Native rerun must prove the resulting
imports. Static runtime selection does not establish the licensing/source
requirements of those objects: inspect the first native link/toolchain evidence and
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
runs native validation and removes large scratch artifacts. By default it retains
only small build/log/configuration/package evidence. On Mac, it also stages and
verifies the packet-derived installed notices in the actual private package. Source acquisition and native
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
Source packets are not embedded in installers. The source-check path stages
NOTICE.source-build.txt as `resources/third-party/ffprobe/NOTICE.txt` and
COPYING.LGPLv2.1 as `resources/third-party/ffprobe/COPYING.LGPLv2.1`, together with
a small SOURCE.json. The checked-in LGPL text is byte-identical to the pinned
upstream text. The installed record binds the original helper and exact source
packet hashes to the helper after package signing. Evaluation source URLs remain
null; no nonexistent release URL is presented as published.
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

The first native source CI run at `afc8cae` reached Linux configuration and
Windows source export, but stopped at the guards described above. Those are
actual failed native attempts, not successful platform qualification. The
corrected recipes need a fresh native run before final runtime notices, source
packets and installed notice wiring can be accepted. Changing the recipe changes
the source-packet manifest/hash even when a platform's executable bytes are
unchanged; regenerate the packet from the reviewed recipe before distribution.


## Installed source/license records

`ffprobe-notices.js` checks the platform, exact upstream/source-archive identity,
input binary hash, packet name/hash and every installed notice checksum before
packaging. `after-pack.js` then records the final packaged helper hash after the
existing signing/audit steps. `verify-packaged-helpers.js --require-ffprobe-notices`
requires that mapping and the actual files. Wrong binaries, missing/altered licenses,
unsafe notice filenames and altered source mappings fail the check.

The evaluated Mac packet supplies these files through an explicit private-build
`CLIPLY_FFPROBE_NOTICE_RECORD` path. This is independent of supplier validation.
Windows/Linux installed notices are not staged yet: their compiler/runtime
material needs native review first. No production selection is implied.

For a future verified production platform, the published record must name
`distributions/<platform>/SOURCE.json` relative to this directory and pin its
`sourceRecordSha256`. That canonical JSON record identifies `evaluationOnly: false`,
the original published helper SHA256, source commit/archive SHA256, the verified
source packet's name/SHA256/asset ID/URL, and a `files` map of adjacent notice
filenames to SHA256. Its directory is checked into the reviewed source change;
after-pack copies only those verified files into resources. A real published
record must use the exact shared-release source URL. An evaluation record cannot
satisfy it. Installed SOURCE.json wraps the original record and its hash plus
the post-signing helper hash, preserving both identities. Production pins remain
empty until review and actual upload verification.

## Optional short-lived reviewer artifact

An authorized native CI run may set `ffprobe_retain_artifacts=true` together with
`ffprobe_source_check=true`; other mode inputs stay false. The default is false.
Locally the equivalent is `validate-ffprobe-source.js --evidence <new-absolute-dir>
--retain <new-absolute-review-dir>`. No script uploads a shared release.

Only after every required native/package/UI/recovery command passes, retention
checks the exact validated input hash and writes a new artifact atomically. It
contains the validated original helper, source/build records and checksum inventory,
plus the corresponding Mac source packet and installed notices when available.
For platforms whose packet/runtime review is incomplete, it retains the exact
source tar, standalone recipe/pins, upstream notices and native compiler/runtime
notice inputs instead. Those inputs are explicitly **not a finished distribution
packet**. Compiler/CRT notices are copied from the native toolchain installation;
their inventory records original paths/hashes and actual package metadata.
Windows collection includes GCC/libgcc, CRT/headers and winpthreads/libwinpthread;
static thread-runtime notices must not be omitted just because its DLL disappears.
No application installers, app bundles or user profiles are retained.

The `source-candidate-<platform>` CI artifact expires after two days and is
uploaded only on success with the explicit retention input. REVIEW.json always
says `publicationReady: false`, lists remaining gates and binds every retained
file by hash. A failed or incomplete validation creates no final review artifact.
Reviewers must download into owned scratch, verify all files and native evidence,
finish runtime/source/installed/minimum-OS review, and only then consider NEW
shared assets under the existing publication authority. Remove temporary remote
artifacts after verification and remove local downloads. Retention is not an app
release, automatic production activation or publication approval.
