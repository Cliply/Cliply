# ffmpeg — what it does here, and what its license asks of us

cliply ships a copy of ffmpeg. this page is the whole story: what the app uses it
for, which build each platform gets, what the license requires, and how to
satisfy that requirement if you fork or redistribute cliply.

the short version: **the bundled ffmpeg is GPLv3, so cliply is GPLv3**, and the
complete source for the bundled ffmpeg is in this repository at
[`third-party/ffmpeg/`](../third-party/ffmpeg/).

## what cliply uses it for

nothing in the app calls ffmpeg directly. yt-dlp does, and cliply tells it where
to find one with `--ffmpeg-location`
([`buildCommonArgs`](../src/main/services/ytdlp-engine.js)). four things need it:

| feature | why ffmpeg |
| --- | --- |
| video downloads above 360p | youtube serves video and audio as separate streams; the merge into one mp4/mkv is ffmpeg's |
| trimming (`--download-sections`) | the cut and the re-mux are ffmpeg's, and `--force-keyframes-at-cuts` re-encodes around the boundary |
| audio downloads as mp3 / m4a | `-t mp3` and `-t aac` extract and re-encode through ffmpeg |
| transcripts as srt or vtt | `--convert-subs` converts whatever the extractor served |

a download that needs none of those — a pre-muxed 360p file, an "original" audio
download, a tiktok video — runs without ffmpeg ever being spawned. that is why a
missing ffmpeg shows up as a failure on *some* downloads and not others; the
error taxonomy has `FFMPEG_MISSING` for exactly this
([`utils/error-taxonomy.js`](../src/main/utils/error-taxonomy.js)).

## where it lives

not in git — the binaries are 70–110 MB each and `.gitignore` excludes them.

```
binaries/
├── linux/ffmpeg
├── macos/ffmpeg
└── windows/ffmpeg.exe
```

`package.json`'s `build.extraResources` copies the one matching the target
platform into `resources/binaries/` of the packaged app, and
[`YtdlpEngine.getFfmpegPath()`](../src/main/services/ytdlp-engine.js) resolves it
from there at runtime, falling back to the development layout above.

for a development checkout, [`binaries/README.md`](../binaries/README.md) has the
download commands. the release workflow does the same thing for CI
([`.github/workflows/build-release.yml`](../.github/workflows/build-release.yml)).

## which build each platform gets

| platform | source | notes |
| --- | --- | --- |
| macOS (arm64) | [evermeet.cx](https://evermeet.cx/ffmpeg/) | arm64 only, which is why cliply refuses to start on an Intel Mac |
| windows (x64) | [yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds/releases/latest), `ffmpeg-master-latest-win64-gpl.zip` | |
| linux (x64) | [yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds/releases/latest), `ffmpeg-master-latest-linux64-gpl.tar.xz` | |

all three are **`--enable-gpl` builds**. that is deliberate and it is what makes
them useful: libx264 and libx265 are GPL-only, and without them there is no h264
encode for a precise cut.

the exact build metadata for the version whose source is vendored here — commit
hash, configure line, compiler — is in
[`third-party/ffmpeg/build-info.md`](../third-party/ffmpeg/build-info.md).

## the license

ffmpeg is LGPLv2.1+ by default. two configure flags change that, and the bundled
builds pass both:

- `--enable-gpl` pulls in the GPL-licensed components (x264, x265, and others),
  which makes the result **GPLv2 or later** rather than LGPL
- `--enable-version3` upgrades the LGPL/GPL parts to their v3 forms, which makes
  the result **GPLv3 or later**

ffmpeg's own statement of this is in
[`third-party/ffmpeg/LICENSE.md`](../third-party/ffmpeg/LICENSE.md); the license
text itself is [`third-party/ffmpeg/COPYING.GPLv3`](../third-party/ffmpeg/COPYING.GPLv3).

### what that means for cliply

cliply distributes that binary inside its installers, so cliply is distributed
under the GPL as well — [`LICENSE`](../LICENSE) at the repository root is the
GPLv3, and `package.json` declares `GPL-3.0-or-later`.

the practical obligations, and how each one is met:

| the GPL asks for | where it is |
| --- | --- |
| the license text, conveyed with the binary | [`LICENSE`](../LICENSE), plus [`third-party/ffmpeg/COPYING.GPLv3`](../third-party/ffmpeg/COPYING.GPLv3) |
| the complete corresponding source for the GPL work | [`third-party/ffmpeg/FFmpeg-*.zip`](../third-party/ffmpeg/) — the full tree at the commit the binaries were built from |
| the scripts used to control compilation | the configure line in [`build-info.md`](../third-party/ffmpeg/build-info.md) |
| a written offer, *or* the source alongside | the source is alongside, in this repository, which is the simpler of the two |
| notice of the license to the user | Help → Third-Party Licenses in the app menu, and [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) |

> [!IMPORTANT]
> if you fork cliply and ship your own installers, **the source obligation
> travels with the binary you ship**, not with the one this repository built. if
> you swap in a different ffmpeg build, replace the archive in
> `third-party/ffmpeg/` and update `build-info.md` to match. shipping a GPL
> binary with the source of a *different* build does not satisfy the license.

### if you want a non-GPL cliply

build ffmpeg without `--enable-gpl`. an LGPL build cannot encode h264 or h265,
so precise cuts lose their re-encode path and mp3/aac extraction has to run
through the LGPL encoders (`libmp3lame` is LGPL-compatible, so mp3 survives).
nothing in cliply's own code depends on the GPL components; the dependency is
entirely in which ffmpeg you drop into `binaries/`.

## getting and rebuilding the source

the vendored archive is a plain zip of the ffmpeg tree at
`d9797544b45a6f2fbd334dd41194b95026555297`:

```bash
cd third-party/ffmpeg
unzip FFmpeg-d9797544b45a6f2fbd334dd41194b95026555297.zip
cd FFmpeg-d9797544b45a6f2fbd334dd41194b95026555297
```

the same tree is on ffmpeg's own git, if you would rather fetch it:

```bash
git clone https://github.com/FFmpeg/FFmpeg.git
cd FFmpeg
git checkout d9797544b45a6f2fbd334dd41194b95026555297
```

then configure with the line recorded in
[`build-info.md`](../third-party/ffmpeg/build-info.md). that line is the macOS
build's; the windows and linux binaries come from yt-dlp/FFmpeg-Builds, whose
own build scripts are public in
[that repository](https://github.com/yt-dlp/FFmpeg-Builds).

## checking what you have

```bash
# which build, and what it was configured with
binaries/macos/ffmpeg -version

# does this build have the GPL encoders
binaries/macos/ffmpeg -hide_banner -encoders | grep -E 'libx264|libx265'
```

the first line of `-version` names the build; the `configuration:` line under it
is the ground truth for whether `--enable-gpl` and `--enable-version3` are in
this particular copy.

## related

- [`third-party/README.md`](../third-party/README.md) — why the source is vendored at all
- [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) — every third-party component, not just this one
- [`binaries/README.md`](../binaries/README.md) — how to get the binaries for a development checkout
- <https://ffmpeg.org/legal.html> — ffmpeg's own page on all of this
