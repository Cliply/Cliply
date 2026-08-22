# privacy

_last updated: august 23, 2026_

hey. quick note on what cliply does (and doesn't) know about you.

cliply started as a weekend project. it's free, open source, and we built it because we wanted a clean little app to grab videos without ads, bloat, or shady sites. that same idea carries over to privacy: we collect as little as possible, we tell you exactly what it is, and nothing is ever sold or shared.

## the short version

- no logins. no accounts. no email. no ads.
- we don't see the urls you paste, the names of the videos you download, or anything in your folders.
- your downloads go **directly** from the source (youtube, pinterest, tiktok) to your disk. nothing passes through our servers. we don't even run one.
- we do send a small amount of anonymous usage data, so we can spot bugs and keep the app working. one click turns it off. details below.

## how the sending works

there is exactly one place in the app that can send anything: [`src/main/services/analytics.js`](src/main/services/analytics.js). everything goes through it, including the events the interface raises.

that file holds a list of every event name, and for each name every property it is allowed to carry. anything not on the list is thrown away on your machine, before it goes anywhere — not filtered later, not filtered on a server. each property is then checked against the kind of value it is meant to be: a yes/no, a number, a name from a fixed list, a version number, or a pre-computed range like `1-5 min`. a value that doesn't fit is dropped and the event goes without it.

that's what makes the list below a complete list rather than a summary of one. adding anything to it takes a deliberate edit to that file.

## what rides on every event

- **a random install id** — a dice roll made on first launch, not derived from you or your machine. it lives in a settings file in your home folder (`~/.config/app-data-7c4f/settings.json`). it survives app updates, and it's gone the moment you delete that file.
- the app version
- your operating system, its version, and your cpu type (`darwin`, `25.5.0`, `arm64`)
- your system language (`en-GB`)
- the version of yt-dlp the app is running
- **country, region and city, worked out from your ip address.** the app never sends the address itself — posthog reads it off the connection, resolves the location, and the project is configured to discard the address rather than store it.

## what we send, event by event

**the app started** (`app_launched`)

- whether this was the very first launch
- which app version you were on before, if you've run it before

**you pasted a link** (`url_submitted`)

- which site — one of `youtube`, `tiktok`, `pinterest`, `instagram`, or `unsupported` for anything else
- the _shape_ of the link: `video`, `shorts`, `playlist`, `short-link` or `embed`. **never the link.**

**the app looked the media up** (`media_info_loaded`, `media_info_failed`)

- which site
- roughly how long the video is, as a range (`1-5 min`)
- how many formats were on offer, as a count
- if it failed: what kind of error it was, which step it happened at, and the error text — see [the one free-text field](#the-one-free-text-field)

**a download started, finished, failed or was cancelled** (`download_started`, `download_completed`, `download_failed`, `download_cancelled`)

- which site
- video or audio, and for audio which mode (`mp3`, `m4a`, `original`)
- the quality you picked (`1080p`, `128kbps`, `best_available`)
- whether you trimmed it
- on finish: the file size in mb, roughly how long it took and roughly how fast it ran — the last two as ranges, never exact times
- on failure or cancel: how far it had got, as a percentage
- on failure: what kind of error, which step, and the error text — see below

**the download engine looked after itself** (`engine_seeded`, `engine_updated`, `engine_update_failed`)

- yt-dlp version numbers, before and after
- a short reason code for what it did or didn't do — `busy`, `up-to-date`, `checksum-mismatch`, and about twenty others
- if an update failed: the error text — see below

**you imported cookies** (`cookies_imported`)

- whether the import worked, and whether the file turned out to have youtube cookies in it

that's the whole list. there is nothing else.

## the one free-text field

three of those events can carry `error_message`: the raw text from yt-dlp, ffmpeg or node when something breaks. it's there because a failure nobody can read is a failure nobody can fix.

it's the only thing the app sends that isn't a number, a yes/no or a value from a fixed list, so it's treated as suspect. before it can leave your machine it is stripped of:

- urls, of any scheme
- file paths — your home folder, windows drive letters, network shares
- filenames, including ones written in non-latin scripts
- email addresses
- ip addresses and mac addresses
- anything that looks like a token, api key, password or cookie value
- anything the message itself put in quotes, which is usually the name of the thing that went wrong

and then it is checked a second time. if anything path-shaped, address-shaped or identity-shaped is _still_ standing after all that, the whole message is thrown away and the literal text `[redacted]` is sent in its place.

**the honest limit.** the scrubbing works on shapes, and a plain run of words has no shape. `~/My Holiday Video` comes out the other side as `[path] Holiday Video` — the path went, the words next to it didn't. nothing in cliply today puts a bare name into an error message (yt-dlp, ffmpeg and node all name a full path, and a full path is taken whole), but the scrubber can't rule it out for good.

so, stated exactly rather than rounded up: **no event has a field for a video title, and the one free-text field is scrubbed of every shape we can name and refused outright if anything is left — we can't promise a stray word never rides along inside it.** that floor is pinned as a test in [`tests/analytics-pii-guard.test.js`](tests/analytics-pii-guard.test.js) so it stays visible instead of quietly drifting.

## what we do NOT collect

- your name, email, or anything that identifies you
- the urls you paste
- video titles — no event has a property for one, and one can't be added without editing the allow-list on purpose
- filenames, or anything about the contents of your downloads folder
- your ip address as a stored field
- any browsing activity outside of cliply

## opting out

open the **Tools** menu and untick **"Send anonymous usage data"**. sending stops the moment you click, and the choice is remembered for next time. if the preference can't be written to disk for some reason, the app says so rather than quietly letting it come back on.

cliply is open source, so if you'd rather the telemetry weren't in the binary at all, flip `ANALYTICS_CONFIG.ENABLED` to `false` in [`src/main/utils/constants.js`](src/main/utils/constants.js) and build your own copy:

```bash
npm run dist:mac
# or dist:win / dist:linux
```

## where your downloads go

straight from the video platform to your computer. we don't proxy, cache, or touch the file. the app is just a friendly wrapper around yt-dlp and ffmpeg, both of which run locally.

## where the analytics data lives

with [posthog](https://posthog.com), on their **united states** cloud (`us.i.posthog.com`). their own privacy policy is at <https://posthog.com/privacy>. we keep no copy anywhere else, and nothing is ever sold or shared.

how long events are kept is a retention setting on that posthog project rather than something the app decides.

## your rights

we don't collect anything tied to you, so there is nothing we could look up, export or delete even if you asked. the closest thing to a handle on you is the random install id, and it's a dice roll with nothing on the other end of it. if you want it gone, delete `~/.config/app-data-7c4f/settings.json` — the app rolls a new one and the old one becomes an orphan nobody can join to anything.

## changes to this page

if we ever change what the app collects, we'll update this file and bump the date at the top. cliply's open source, so every change is visible in the commit history too.

## say hi

questions, worries, or just want to say hello? open an issue on [github](https://github.com/cliply/cliply) or drop a line at [cliply.space/hey](https://cliply.space/hey).

thanks for using cliply.
