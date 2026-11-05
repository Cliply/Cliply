# Source-built FFprobe

The source-built path is selected by [published.json](published.json), with verified
executables and matching source archives in Cliply’s shared `binaries` release.
The alternative supplier pins in `candidates.json` remain evaluation-only. Existing
FFmpeg, Deno and yt-dlp are unchanged. No runtime helper downloader is introduced.

[Native qualification 41893450459](https://github.com/Cliply/Cliply/actions/runs/41893450459)
passed at `48cf479` for n8.1.3 on macOS 26 ARM64, Windows Server 2025 x64 and
Ubuntu 24.04 x64. All 13 required package/media/UI/download commands passed; Windows
also passed its DLL-inspector discovery check. Publication independently rechecked
all retained source/build/runtime/notice inputs and re-downloaded all six uploaded
assets before generating the production records. Earlier runs below describe the
historical n8.1 baseline. Minimum-OS execution remains separate from these hosts.

Build/packet records retain their original evaluation markers: producing a candidate
is not publication. The separate production SOURCE.json records identify the exact
source assets and their verified promotion. Source packets include the complete
unmodified FFmpeg source and build recipe, plus runtime notices and provenance;
they do not claim to include complete compiler/toolchain source archives.

## Exact source and build design

The [source pin](source-build.json) records FFmpeg n8.1.3 commit
`1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7`, the SHA256 of its complete Git tar
export, and hashes of the upstream license files and three IJG-derived files.
The builder accepts either that Git checkout or the exact tar export. It checks
the archive before extracting and does not patch upstream source.
The patch update from n8.1 follows FFmpeg's maintained 8.1 release branch,
including fixes made after the original baseline. Its canonical tar SHA256 is
`801838344d51651d45ab3ce6502a2627da7746492475711ff2adfb723aeaf7b6`.
All eight upstream license/IJG file hashes are unchanged. Earlier native results
below qualify the previous n8.1 baseline. The patch update is qualified by the
current run linked above.

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
| macOS ARM64 | Apple clang; all commands through `/usr/bin/arch -arm64`; target macOS 13 | All 13 required commands and installed notices passed for n8.1.3 in run 41893450459; macOS 13 remains untested |
| Ubuntu 24.04 x64 | `/usr/bin/gcc-13`, NASM, `--arch=x86_64 --target-os=linux`, baseline x86-64 | All 13 required commands and installed notices passed for n8.1.3 in run 41893450459 |
| Windows x64 | MSYS2 UCRT64 GCC/NASM, `--arch=x86_64 --target-os=mingw32`, native Win32 threads | All 13 required commands, DLL discovery and installed notices passed for n8.1.3 in run 41893450459; Windows 10 remains untested |

Windows uses an explicitly supplied MSYS2 root and its UCRT64 compiler rather
than the MSYS compiler. It requests static compiler/runtime archives, disables PE linker timestamps
and refuses non-system DLL imports (including MSYS, libgcc and winpthread DLLs).
The second native run exposed an actual `libwinpthread-1.dll` import despite
FFmpeg pthreads being disabled and `-static-libgcc`. The corrected link adds
`-static`; the DLL allow-list remains unchanged. [GCC's link documentation](https://gcc.gnu.org/onlinedocs/gcc/Link-Options.html)
distinguishes static library selection from the libgcc-only option, and the
[UCRT64 winpthreads package](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-winpthreads)
contains both static and DLL import archives. The strict DLL gate, backend media, packaged UI, normal startup and installed
notice checks passed in the current qualification. Static runtime selection does not establish the licensing/source
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
builds, prepares the target draft source packet twice, checks packet determinism,
runs native validation and removes large scratch artifacts. By default it retains
only small build/log/configuration/package evidence. On reviewed targets, it also stages and
verifies the packet-derived installed notices in the actual private package. Source acquisition and native
build failures remain failures; no supplier or platform fallback exists.

After separate push/CI authorization, use existing **CI** on the reviewed ref,
`ffprobe_source_check=true`, all other inputs false. It calls the reusable
`validate-ffprobe-source.yml` at that same commit. Supplier mode retains priority
if both flags are accidentally set. Both validation modes exclude ordinary app
and helper-publication jobs. Validation and publication are separate workflow/command operations.

## Corresponding-source packet specification

Mac, reviewed Linux and Windows draft assets use existing developer tooling:

```sh
node scripts/package-ffprobe-source.js --build <absolute-verified-build> --output <new-owned-packet-directory>
```

For Linux and Windows, also pass `--runtime-notices <absolute-native-notice-directory>`.
Name: `ffprobe-source-<commit12>-<platform>-<unsigned-executable-sha12>-<packet-sha12>.tar.gz`.
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

The historical n8.1 packets and installed mappings passed native checks in
run 41513771327 at `07b3e9e`. The current n8.1.3 qualification and verified
publication are recorded above. Minimum-OS execution, installed-app acceptance
and storage coverage remain separate from source qualification. Archive size is
source-distribution overhead, not installer growth. Source-packet repeatability
does not imply deterministic executable rebuilds.

The first native source CI run at `afc8cae` reached Linux configuration and
Windows source export, but stopped at the guards described above. Those are
actual failed native attempts, not successful platform qualification. The
corrected recipes subsequently passed native qualification, including runtime
notices, source packets and installed notice wiring. Changing the recipe changes
the source-packet manifest/hash even when a platform's executable bytes are
unchanged; regenerate the packet from the reviewed recipe before distribution.


## Installed source/license records

`ffprobe-notices.js` checks the platform, exact upstream/source-archive identity,
input binary hash, packet name/hash and every installed notice checksum before
packaging. `after-pack.js` then records the final packaged helper hash after the
existing signing/audit steps. `verify-packaged-helpers.js --require-ffprobe-notices`
requires that mapping and the actual files. Wrong binaries, missing/altered licenses,
unsafe notice filenames and altered source mappings fail the check.

The evaluated target packets supply these files through an explicit
private-build `CLIPLY_FFPROBE_NOTICE_RECORD` path, independent of supplier validation.
Linux additionally requires the exact GCC runtime and glibc notices plus the
full GPLv3 text; dropping or altering them fails installed-record verification.
Windows additionally requires the captured GCC exception, MinGW and winpthreads
notices and the full GPLv2 text referenced by the broader toolchain notices.
No production selection is implied.

For each selected production platform, the published record must name
`distributions/<platform>/SOURCE.json` relative to this directory and pin its
`sourceRecordSha256`. That canonical JSON record identifies `evaluationOnly: false`,
the original published helper SHA256, source commit/archive SHA256, the verified
source packet's name/SHA256/asset ID/URL, and a `files` map of adjacent notice
filenames to SHA256. Its directory is checked into the reviewed source change;
after-pack copies only those verified files into resources. A real published
record must use the exact shared-release source URL. An evaluation record cannot
satisfy it. Installed SOURCE.json wraps the original record and its hash plus
the post-signing helper hash, preserving both identities. Production pins identify only reviewed, uploaded and re-downloaded assets.

## Optional short-lived reviewer artifact

An authorized native CI run may set `ffprobe_retain_artifacts=true` together with
`ffprobe_source_check=true`; other mode inputs stay false. The default is false.
Locally the equivalent is `validate-ffprobe-source.js --evidence <new-absolute-dir>
--retain <new-absolute-review-dir>`. Validation and retention do not upload a shared release; explicit promotion uses
`publish-ffprobe.js`.

Only after every required native/package/UI/recovery command passes, retention
checks the exact validated input hash and writes a new artifact atomically. It
contains the validated original helper, source/build records and checksum inventory,
plus the corresponding target source packet and installed notices when available.
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

## Linux runtime review and retained-input assembly

Run [41503566940](https://github.com/Cliply/Cliply/actions/runs/41503566940)
passed all 12 native commands on Ubuntu 24.04, including the sandboxed UI. Its
12,892,520-byte FFprobe SHA256 is
`65e92c06ffb12a455a229a2cff419721f2ff2897b52a9122cd638452777875c7`; imports are
only `libc.so.6` and `libm.so.6`. That run predates the installed Linux notice
extension; run 41507047367 subsequently passed all 12 native commands with the
installed runtime notices and source mapping verified.

[runtime-notices.json](runtime-notices.json) freezes the observed package versions,
GCC/NASM/linker hashes, imports and three complete Ubuntu copyright files. Changed
inputs fail packet assembly and require review. GCC 13.3.0-6ubuntu2~24.04.1 and
glibc 2.39-0ubuntu8.9 source-package locations are recorded there. The two GCC
copyright files have identical bytes and are deduplicated only in the installed
notices. Their GCC Runtime Library Exception 3.1 and the full GPLv3 text accompany
the installed helper. The glibc copyright file's historical 2.23 heading is
preserved verbatim; actual package identity comes from the recorded dpkg output.
No compiler/glibc source archive or shared OS library is copied into the packet.
The complete pinned FFmpeg source and original per-file notices remain included.

Source-only assembly on a different host may pass
`--validation <absolute-native-validation-directory>` with the retained native
`commands.json` and `artifact.json`. Every required command must have passed
exactly once, and platform/helper identity must match. All source/recipe/config/
helper/runtime checks still apply. Reconstruct the build tree from the retained
exact source tar, raw helper, prototype record and config.mak before using it.
This does not execute a foreign binary or replace native installed-notice tests.
Normal build/validation still requires the matching native host.

Small runtime notices are now collected immediately after a successful source
build into the evidence directory, even if a later native UI check fails. Such
evidence is not a retained candidate: failed validation still cannot retain the
helper or report a successful source packet. The Windows inspection assertion
now records the safe IPC error code/message, trusted-main-frame result and
synthetic fixture existence to distinguish the observed failure on its rerun.
No production security or lifecycle check is bypassed.

## Windows runtime inputs

The first captured runtime set is from native run
[41507047367](https://github.com/Cliply/Cliply/actions/runs/41507047367). Its source
build and backend checks passed, but packaged UI failed because the legacy
renderer loader and strict authorization used different URL encodings. Reviewing
its runtime material does not turn that failed run into a successful candidate.
Foreign-host source assembly and retained-candidate creation still require every
native validation command to pass against the exact helper.

Windows source packets, installed notices and all 12 required native commands
passed in [run 41513771327](https://github.com/Cliply/Cliply/actions/runs/41513771327).
Bounded lock handling preserves the replacement gate and rollback; see
[engine swap behavior](../../docs/architecture.md#binary-and-update-boundaries).
Smoke checks reject shutdown diagnostics even at exit zero and report copied-app
cleanup failures without masking the primary failure. The audited Windows source
packet is 17,218,854 bytes; installed notices including their source record total
111,734 bytes. These are source/notice measurements, not installer growth.

The Windows entry in runtime-notices.json freezes the observed complete package
list, GCC/NASM/linker hashes, system-only imports and 13 complete package notice
files. Seven unique notice contents are retained without edits. Installed notices
deduplicate identical copies; the GCC COPYING3 bytes match the already pinned
upstream GPLv3 text. The MinGW runtime text preserves its historical Cephes FIXME
and all third-party notices verbatim; no new claim about individual object
licensing is inferred from the top-level package label. GPLv2 accompanies the
optional profiling-code reference in the broader MinGW toolchain notice; this
does not enable profiling or GPL components in FFprobe. The source packet also
includes the actual runtime inventory and checks the static libwinpthread.a
hash and exact pacman owner/version. An unexpected library, package, compiler,
notice or thread archive fails the existing gates rather than being accepted.

Official [GCC](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-gcc),
[CRT](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-crt),
[headers](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-headers) and
[winpthreads](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-winpthreads)
records checked 3 November 2026 matched the initial GCC 16.2.0-6 and MinGW
14.0.0.r569.g34eeafb7d-1 versions and packager runs. The reviewed update below
advances only the four MinGW runtime packages. Exact versioned source URLs and
whether each source archive was downloaded/hash-checked are recorded in
runtime-notices.json. Compiler/runtime source archives are not embedded in the
packet; it contains the complete exact FFmpeg source used for the executable.
No MSYS2/compiler executable, runtime archive or system DLL is redistributed.

Windows installed-notice validation has passed on the recorded native host.
Minimum Windows 10 and clean installed/offline acceptance remain separate
from the completed source qualification and helper publication. No deterministic
Windows executable rebuild is inferred merely from fixed tool versions; native
artifact hashes identify the particular build validated by each run.

### Runtime update reviewed 4 November 2026

[Run 41817035809](https://github.com/Cliply/Cliply/actions/runs/41817035809)
stopped before Windows package validation because CRT, headers, libwinpthread
and winpthreads advanced to `14.0.0.r598.ge3d18511f-1`. That failed build supplies
review inputs, not a successful candidate. The accepted inventory and exact
archive-owner version now reflect the reviewed packages; verifier code is
unchanged. All 13 notice hashes, GCC/NASM/linker hashes, system DLL imports and
the static `libwinpthread.a` hash retain their previous values.

The four downloaded UCRT64 package archives match the SHA256 values on their
official MSYS2 package records. Their `.BUILDINFO` recipe hashes match
[MSYS2 recipe commit 07f00a4d](https://github.com/msys2/MINGW-packages/commit/07f00a4d37082cdeaeefc366ff939b9975cf83fd).
All nine notices from those packages and the static thread archive match the
captured native files. Archive URLs, hashes and recipe identities are retained
in `runtime-notices.json` under `reviewedUpdate`.

The [29 upstream commits](https://github.com/mingw-w64/mingw-w64/compare/34eeafb7d0e5b037b4644c17defc4f4131ad85cc...e3d18511f9759d455cae20c34703eea4a0723cf3)
include allocation-overflow handling, CRT math/symbol selection and winpthreads
header changes. Build flags and notice-installation recipes are unchanged.
The optional VCRuntime import library requires explicit selection; the existing
system-only DLL gate remains mandatory. The captured FFprobe executable hash
changed despite matching size, configuration and imported DLL/symbol sets, so
previous native success cannot qualify this build.

CRT and headers source-only archives were downloaded and hashed. Their recipes
match the pinned MSYS2 commit; the CRT archive's Git tree contains both reviewed
revisions and exports the exact source checksum in the recipes. The five upstream
notice files are unchanged across those revisions. The separate winpthreads and
GCC source-only archives were not downloaded; the winpthreads recipe and shared
source revision were checked. This review makes no new distribution-license claim.

Current qualification completed native builds, repeated source-packet assembly,
installed-notice verification and all media/UI/startup/download checks. Future
runtime changes require fresh qualification. Results are recorded in
[PR #77](https://github.com/Cliply/Cliply/pull/77). Rolling package acquisition
remains guarded by exact inventory/content checks; further drift requires review.
Minimum-OS acceptance remains separate from verified helper publication.
