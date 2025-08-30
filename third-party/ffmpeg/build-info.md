# ffmpeg build information

## binaries included

### macos binary

- version: n-119840-gd9797544b4-tessus
- full commit: d9797544b45a6f2fbd334dd41194b95026555297
- source: https://evermeet.cx/ffmpeg/
- built: june 7, 2025

### windows & linux binaries

- version: various builds from btbn/ffmpeg-builds
- source: https://github.com/BtbN/FFmpeg-Builds
- based on: official ffmpeg repository (same codebase as macos)
- all compiled with --enable-gpl flag

## source code

- full commit hash: d9797544b45a6f2fbd334dd41194b95026555297
- short commit: d9797544b4
- repository: https://github.com/FFmpeg/FFmpeg
- source archive: ffmpeg-d9797544b45a6f2fbd334dd41194b95026555297.zip (included)

**note:** all platform binaries (macos, windows, linux) are built from the same official ffmpeg repository. the macos source provided here represents the core ffmpeg codebase used across all platforms.

## build configuration

built with apple clang version 17.0.0 with the following configuration:

--cc=/usr/bin/clang --prefix=/opt/ffmpeg --extra-version=tessus --enable-avisynth --enable-fontconfig --enable-gpl --enable-libaom --enable-libass --enable-libbluray --enable-libdav1d --enable-libfreetype --enable-libgsm --enable-libharfbuzz --enable-libmodplug --enable-libmp3lame --enable-libmysofa --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenh264 --enable-libopenjpeg --enable-libopus --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvmaf --enable-libvo-amrwbenc --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx264 --enable-libx265 --enable-libxavs --enable-libxml2 --enable-libxvid --enable-libzimg --enable-libzmq --enable-libzvbi --enable-version3 --pkg-config-flags=--static --disable-ffplay

**key gpl components:** libx264, libx265, and other gpl-licensed codecs

## license

all ffmpeg binaries are licensed under gplv3 due to --enable-gpl flag.
complete source code provided as required by gpl license terms.

project license: see license file in project root  
more info: https://ffmpeg.org/legal.html
