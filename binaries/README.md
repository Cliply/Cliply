# ffmpeg binaries go here

so this app needs ffmpeg to work properly. we can't include the actual ffmpeg files in git because they're huge, so you'll need to grab them yourself.

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

## building the app

the build scripts handle ffmpeg automatically:

- `npm run prepare:full` - sets everything up
- `npm run dist` - creates the final app package

## if something breaks

- make sure you got the right architecture (usually x64)
- the app will tell you if ffmpeg is missing when downloads fail
- any recent ffmpeg version should work fine
