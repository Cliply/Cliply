# transcripts

the Transcript tab downloads one subtitle track as a file. it is the youtube
flow's third tab, next to Video and Audio.

three formats:

| format | what it is |
| --- | --- |
| **SRT** | subtitles with timings. the format every player opens |
| **VTT** | WebVTT, for the web |
| **plain text** | the same words with the cue numbers and the timings taken out |

`txt` is not a subtitle format and yt-dlp cannot produce one. it is downloaded as
srt and stripped afterwards, in the main process
([`utils/transcript.js`](../src/main/utils/transcript.js)).

## which languages are offered

yt-dlp reports two separate stores, and they are very different sizes:

- `subtitles` — what the uploader wrote. usually none, sometimes a handful
- `automatic_captions` — one machine transcription, plus **roughly two hundred
  machine translations of it**

listing all of that is not a menu. so
[`extractTranscripts()`](../src/main/utils/ytdlp-mappers.js) keeps:

1. every human-written track
2. the machine transcript
3. nothing else

the translations are identified by `tlang=` in their timedtext urls — youtube's
own convention, and the only thing in the payload that separates the machine
transcript from the machine translations of it. a track with no urls at all is
not called a translation (unknown is not the same as excluded); a hard cap of 50
is what stops an extractor that does not follow the convention from flooding the
list.

a language present in both stores appears **once**, as the human one — that is
the better file and the one a download would get anyway.

two things are filtered out that look like languages and are not: `live_chat`
(the chat replay of a stream, filed under `subtitles`, served as json) and any
key that is not a bcp-47 tag.

## how one download runs

```
buildArgs("transcript", …)      --skip-download --write-subs --sub-langs <code>
                                --sub-format vtt/srt/best --convert-subs <fmt>
        ↓
yt-dlp writes  <stem>.<lang>.<ext>  into the download folder
        ↓
findTranscriptFiles()          locate it (see below)
        ↓
writePlainText()               only for txt
        ↓
removeLeftovers()              --convert-subs keeps what it converted from
```

### human vs automatic is a real switch

`--write-subs` and `--write-auto-subs` read different stores, and the difference
is visible to the user: one track was written by a person, the other was
transcribed by a machine and reads like it.

- a track the menu called **human** asks for `--write-subs` only. being handed
  machine text under a human label is the one outcome worth failing over.
- a track the menu called **automatic** asks for both. when yt-dlp finds a
  language in both stores the human one wins, and being handed the *better* track
  than the one you clicked is an upgrade, not a surprise.

### finding the file

this is the part with no obvious answer. `--skip-download` means there is no
`[download] Destination:` line and `after_move` never fires, so the engine's
usual destination parsing sees nothing — the file has to be found on disk.

two ways, because each fails where the other does not:

- **the stem.** the `-o` template is built here rather than left to yt-dlp's own
  fields, precisely so it is a name we can match against afterwards
  (`buildTranscriptStem()`). yt-dlp appends the language itself, so the match is
  on `<stem>.` — the dot is what stops a longer name from a different download
  matching. it can still be cut short by `--trim-filenames` on a very long title,
  which is why the stem caps the title at 120 characters.
- **a before/after diff.** taken around the run, filtered to subtitle extensions.
  it catches whatever the stem missed, but it would also catch a *different*
  download finishing into the same folder at that moment.

the stem wins whenever it matches anything; the diff is the fallback.

### leftovers

`--convert-subs` runs *after* the original is written and keeps it, so a request
for srt can leave the vtt it was made from sitting next to it. `removeLeftovers()`
deletes everything except the file the user asked for — best effort, because an
undeletable leftover is clutter and clutter is not a reason to report a finished
download as broken.

if the conversion failed entirely (ffmpeg refuses some sources), the unconverted
original is handed over instead. a transcript in the wrong format beats reporting
that there is none.

## no track, no file

yt-dlp treats a subtitle language it could not find as a *warning* and exits 0.
nothing downstream would call that a failure — but the user asked for a file and
there is no file, so it is one to them. that is
`TRANSCRIPT_UNAVAILABLE` in the taxonomy
([`utils/error-taxonomy.js`](../src/main/utils/error-taxonomy.js)), raised by
looking at what was written rather than by any stderr pattern.

## plain text, and its one known cost

`subtitleToPlainText()` drops timing lines, cue numbers, webvtt headers, inline
`<c>`/`<00:00:00.480>` tags and ass override blocks, decodes the handful of
entities caption tracks contain, and **drops consecutive duplicates**.

that last one is not tidying. youtube's automatic captions roll: each line is
emitted again as the next one scrolls in under it, so keeping them would triple
the file. non-consecutive repeats are left alone — a chorus is meant to be there
twice.

the known cost: a caption whose entire content is a number ("1999") is
indistinguishable from the cue index above it and is dropped. it is asserted in
[`tests/transcript.test.js`](../tests/transcript.test.js) so it stays a known
cost rather than a surprise.

## which files this feature touches

useful as a worked example of an end-to-end change:

| file | what it gained |
| --- | --- |
| [`utils/transcript.js`](../src/main/utils/transcript.js) | the format vocabulary, file discovery, plain-text conversion |
| [`utils/ytdlp-mappers.js`](../src/main/utils/ytdlp-mappers.js) | `extractTranscripts()`, the stem and the output template |
| [`services/ytdlp-engine.js`](../src/main/services/ytdlp-engine.js) | the `transcript` operation, its two whitelists, `downloadTranscript()` |
| [`services/download-runner.js`](../src/main/services/download-runner.js) | the `resolveFile` hook, so a completion can name a file the engine could not |
| [`ipc-handlers.js`](../src/main/ipc-handlers.js) | `handleDownloadTranscript` |
| [`utils/constants.js`](../src/main/utils/constants.js) + [`preload.js`](../src/preload/preload.js) | the channel |
| [`services/analytics.js`](../src/main/services/analytics.js) | `media_type: transcript`, the `transcript_format` property |
| renderer | `TranscriptLanguageDropdown`, `TranscriptFormatDropdown`, `TranscriptDownloadButton`, the store fields, the api types |

## limitations, deliberate ones

- **one track at a time.** `--sub-langs` takes a list, and the whitelist allows
  exactly one tag. a list from the renderer would be list syntax reaching a
  command line.
- **no trimming.** yt-dlp writes a subtitle track whole. trimming one is a text
  edit, not a download, and the Transcript tab has no time range for that reason.
- **youtube only.** tiktok and pinterest have no caption tracks to offer.
