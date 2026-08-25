# third-party source code

this directory holds the source for the third-party components cliply ships as
binaries, because their licenses require it. it is not build input - nothing
here is compiled by `npm run dist` - it is what the license asks us to convey
alongside the binary.

## ffmpeg

- **license:** GPLv3 or later (`--enable-gpl --enable-version3`)
- **used for:** merging video and audio, trimming, audio conversion, subtitle
  conversion
- **license text:** [`ffmpeg/COPYING.GPLv3`](ffmpeg/COPYING.GPLv3), with
  ffmpeg's own summary in [`ffmpeg/LICENSE.md`](ffmpeg/LICENSE.md)
- **complete corresponding source:** the zip in [`ffmpeg/`](ffmpeg/), which is
  the whole tree at the commit the binaries were built from
- **build configuration:** [`ffmpeg/build-info.md`](ffmpeg/build-info.md)

the full explanation - what ffmpeg is used for, which build each platform gets,
what the GPL asks of a fork - is in [`docs/ffmpeg.md`](../docs/ffmpeg.md).

## everything else

nothing else cliply ships needs its source vendored: yt-dlp is public domain,
deno and electron are MIT. they are all listed, with their licenses, in
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).

## if you fork cliply

the source obligation travels with the binary **you** ship, not the one this
repository built. swap the ffmpeg binary and you have to swap the archive here
and update `build-info.md` to match it - shipping one build's binary with
another build's source does not satisfy the GPL.
