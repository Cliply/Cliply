# privacy

_last updated: april 22, 2026_

hey. quick note on what cliply does (and doesn't) know about you.

cliply started as a weekend project. it's free, open source, and we built it because we wanted a clean little app to grab videos without ads, bloat, or shady sites. that same idea carries over to privacy: we collect as little as possible, we tell you exactly what it is, and nothing is ever sold or shared.

## the short version

- no logins. no accounts. no email. no ads.
- we don't see the urls you paste, the videos you download, or anything in your folders.
- your downloads go **directly** from the source (youtube, pinterest, tiktok, etc) to your disk. nothing passes through our servers. we don't even run one.
- we do send a tiny bit of anonymous stats so we can spot bugs and keep the app working. details below.

## what we send

the app uses [aptabase](https://aptabase.com) — an open source, privacy-friendly analytics service hosted in the eu. it's the only thing that phones home. here's every single field it sends:

**when a download finishes** (`download_completed`)
- type of download (`combined`, `audio`)
- platform (`youtube`, `pinterest`, `tiktok`)
- video title (from the public metadata of the video you downloaded)
- quality you picked (e.g. `1080p`)
- final file size in mb

**when a download fails** (`download_failed`)
- same stuff as above, plus
- the raw error from yt-dlp or ffmpeg, so we can actually fix the bug you just hit. your user folder (the one with your name in it) is stripped out before it leaves your machine — `C:\Users\Jane Smith\...` becomes `C:\Users\~\...`. always.

**stuff aptabase adds automatically**
- app version (like `1.4.2`)
- os and version (like `macOS 14.5`)
- system locale (like `en-IN`)
- an anonymous session id that resets every few hours
- country, figured out from your ip. **your ip itself is never stored.**

that's it. that's the whole list.

## what we do NOT collect

- your name, email, or anything that identifies you
- the urls you paste
- the contents of your downloads folder
- your ip address
- any browsing activity outside of cliply

## where your downloads go

straight from the video platform to your computer. we don't proxy, cache, or touch the file. the app is just a friendly wrapper around yt-dlp and ffmpeg — both of which run locally.

## where the analytics data lives

with aptabase, in the eu. they're gdpr-compliant and don't use cookies or cross-site tracking. their own privacy page is at <https://aptabase.com/legal/privacy>. events are kept for up to 12 months and then deleted.

## opting out

cliply is open source, so if you'd like zero telemetry, flip `ANALYTICS_CONFIG.ENABLED` to `false` in [`src/main/utils/constants.js`](src/main/utils/constants.js) and build your own copy:

```bash
npm run dist:mac
# or dist:win / dist:linux
```

we're working on a simple toggle in the settings so you won't have to rebuild. it's on the list.

## your rights

since we don't collect anything tied to you, there's nothing we could look up, export, or delete even if you asked. still, if something's on your mind, just ping us.

## changes to this page

if we ever change what the app collects, we'll update this file and bump the date at the top. cliply's open source, so every change is visible in the commit history too.

## say hi

questions, worries, or just want to say hello? open an issue on [github](https://github.com/cliply/cliply) or drop a line at [cliply.space/hey](https://cliply.space/hey).

thanks for using cliply.
