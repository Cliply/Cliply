# binaries go here

this app needs ffmpeg and deno to work properly. we can't include the actual binary files in git because they're huge, so you'll need to grab them yourself.

## what you need

```
binaries/
├── deno/
│   ├── linux/deno
│   ├── macos/deno
│   └── windows/deno.exe
├── ffmpeg
├── linux/ffmpeg
├── macos/ffmpeg
└── windows/ffmpeg.exe
```

## ffmpeg setup

for complete installation details, check out the [yt-dlp documentation](https://github.com/yt-dlp/yt-dlp/wiki/Installation) which covers everything in detail.

## what you need to do

grab ffmpeg for your system and drop it in the right folder:

```
binaries/
├── linux/ffmpeg
├── macos/ffmpeg
└── windows/ffmpeg.exe
```

## getting ffmpeg

**linux & windows**

yt-dlp has optimized builds that work best with this app:

- visit: https://github.com/yt-dlp/FFmpeg-Builds/releases/latest
- download for your system:
  - linux: `ffmpeg-master-latest-linux64-gpl.tar.xz`
  - windows: `ffmpeg-master-latest-win64-gpl.zip`
- extract and copy the ffmpeg binary here

**macos**

yt-dlp doesn't provide mac builds, so use homebrew:

```bash
brew install ffmpeg
cp /opt/homebrew/bin/ffmpeg binaries/macos/
```

if you're on intel mac, try `/usr/local/bin/ffmpeg` instead.

**already have ffmpeg?**

just copy it over:

```bash
which ffmpeg
# then copy to the right binaries/ folder
```

## make it work

linux and mac need execute permissions:

```bash
chmod +x binaries/linux/ffmpeg
chmod +x binaries/macos/ffmpeg
```

## deno setup

yt-dlp 2025.11.12+ requires deno for javascript runtime support (needed for youtube downloads).

### download deno

**macos arm64** (for apple silicon macs):

```bash
cd binaries/deno/macos
curl -L -o deno.zip "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip"
unzip deno.zip && chmod +x deno && rm deno.zip
```

**windows x64**:

```bash
cd binaries/deno/windows
curl -L -o deno.zip "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"
tar -xf deno.zip && rm deno.zip
```

**linux x64**:

```bash
cd binaries/deno/linux
curl -L -o deno.zip "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip"
tar -xf deno.zip && chmod +x deno && rm deno.zip
```

### make deno executable

linux and macos need execute permissions:

```bash
chmod +x binaries/deno/linux/deno
chmod +x binaries/deno/macos/deno
```

## building the app

the build scripts handle binaries automatically:

- `npm run prepare:full` - sets everything up
- `npm run dist` - creates the final app package

## if something breaks

- make sure you got the right architecture (usually x64)
- the app will tell you if ffmpeg or deno is missing when downloads fail
- any recent ffmpeg/deno version should work fine
