// maps yt-dlp --dump-json output onto the response shapes the renderer renders,
// and picks the -o templates downloads are named by
// the simple-platform half is still ported from python/platforms/*.py

const crypto = require("crypto")
const path = require("path")

// yt-dlp's own default vcodec preference, best first. mirroring it is what
// makes the stream we describe the stream `-S res:<height>` actually picks
const VCODEC_PREFERENCE = ["av1", "vp9", "h265", "h264", "vp8"]

// the codec that decides whether a height can be handed over as real mp4:
// h264 caps at 1080p on youtube, so 1440p/2160p are av1/vp9 and must be mkv
const MP4_CODEC = "h264"

// `-t mp4` prepends `acodec:aac` to the sort, so an mp4 tier merges the best
// aac stream and never the higher-bitrate opus one
const MP4_ACODEC = "aac"

// yt-dlp's own default acodec preference, best first. it is what separates two
// streams of equal quality - opus wins over aac, which is why an mkv tier and
// an mp4 tier of the same video are sized against different audio
const ACODEC_PREFERENCE = ["opus", "vorbis", MP4_ACODEC, "mp3"]

// native output templates - yt-dlp sanitises, truncates on byte boundaries and
// knows the trim bounds, so none of that is ours to rebuild
const VIDEO_TEMPLATE = "%(title).120B_%(height)sp_%(epoch)s.%(ext)s"
const VIDEO_TRIM_TEMPLATE =
  "%(title).120B_%(height)sp_%(section_start)s-%(section_end)s_%(epoch)s.%(ext)s"
// audio has no height to report, so the word takes its place
const AUDIO_TEMPLATE = "%(title).120B_audio_%(epoch)s.%(ext)s"
const AUDIO_TRIM_TEMPLATE =
  "%(title).120B_audio_%(section_start)s-%(section_end)s_%(epoch)s.%(ext)s"

// the ceiling on any one link, for the listing, for the selection built out of
// it, and for the width the item numbers are padded to. a 5,283-item channel
// lists in 63 s and 3.8 MB; the first 100 list in about a second and cover
// nearly every real playlist, and anything bigger is shown honestly as "the
// first 100 of 5,283".
//
// it lives here rather than in the engine because the padding below has to be
// derived from it, and the engine may depend on this module while this module
// must not depend on the engine
const PLAYLIST_MAX_ITEMS = 100

// pad to the width of the cap, not to whatever yt-dlp picks.
//
// left to itself `%(playlist_index)s` pads to the digit width of the *largest
// selected index*, which is per-run rather than per-playlist. measured against
// 2026.08.19 on one 13-item playlist: `-I 1,3` gives `1`, `3`; `-I 7,11` gives
// `07`, `11`; `-I 1:13` gives `01`..`13`. each run is internally consistent,
// so nothing sorts wrongly *within* a run.
//
// the problem is that a playlist folder outlives one run. download items 1 and
// 3, come back and download 7 and 11, and the same folder holds `1 - ...`,
// `3 - ...`, `07 - ...` and `11 - ...` - four files at two widths, which no
// file manager sorts sensibly. a width pinned to the cap is the same in every
// run, and it follows the constant if the cap ever changes
const PLAYLIST_INDEX_WIDTH = String(PLAYLIST_MAX_ITEMS).length

// a playlist follows yt-dlp's own recommended pattern instead of the flat
// single-video names above: a folder per playlist, then a name led by the
// item's true position in the list.
//
// the pair splits the same way VIDEO_TEMPLATE and AUDIO_TEMPLATE do, and for
// the same reason - the video name carries the height it really got, the audio
// name has no height to carry. that is not cosmetic here: the download archive
// is keyed by video id alone, so it is quality-blind, and a name that did not
// vary with the height would defeat the per-quality archive scoping one layer
// down. yt-dlp would find the file already there and skip it, and "download
// this playlist again in 4K" would quietly do nothing.
//
// the consequence is worth stating: a later run at a *lower* ceiling that
// lands on the same delivered height does hit yt-dlp's own "has already been
// downloaded" skip. that is the right outcome - the file on disk is the file
// that run asked for.
//
// two more details are deliberate:
//   - `[%(id)s]` is from yt-dlp's own guidance: titles are not unique and get
//     edited after the fact, ids never change
//   - no `%(epoch)s`, unlike the single-video templates: the id and the height
//     already make the name unique, so a timestamp would only add noise to a
//     hundred filenames
//
// the video title is capped at .80B rather than the .120B a single video gets,
// and that is a budget rather than a preference. `--trim-filenames 240` counts
// the whole *relative* path - the playlist folder included - and truncates the
// stem from the tail, so whatever sits at the end of the name is what it eats
// first. measured against 2026.08.19 with an artificially low trim:
//
//     trim 90: .../003 - Mark Lesek： A New⧸Old Prosthetic [V4DDt30.mp4
//     trim 70: .../003 - Mark Lesek： A New⧸Old.mp4
//     trim 30: .../Google Search Stories [PLBCF2D.mp4   <- the folder is gone
//
// the height goes first, then the id - which is precisely the pair that keeps
// two runs at different ceilings from colliding. an 80-byte playlist title, a
// 41-character `OLAK5uy_` album id and a .100B video title reach 251 and lose
// them; at .80B the worst case is 231, inside the budget. the test that pins
// this computes the number from the template rather than restating it
const PLAYLIST_DIR = `%(playlist_title).80B [%(playlist_id)s]`
const PLAYLIST_ITEM = `%(playlist_index)0${PLAYLIST_INDEX_WIDTH}d - %(title).80B [%(id)s]`
const PLAYLIST_VIDEO_TEMPLATE = `${PLAYLIST_DIR}/${PLAYLIST_ITEM} %(height)sp.%(ext)s`
const PLAYLIST_AUDIO_TEMPLATE = `${PLAYLIST_DIR}/${PLAYLIST_ITEM}.%(ext)s`

// resume archives live together under userData rather than beside the videos:
// they are our bookkeeping, and a stray .txt in the user's playlist folder is
// something they would reasonably delete
const PLAYLIST_ARCHIVE_DIR = "playlists"

// a playlist id and a quality both become path components, so they are
// stripped to the characters an id actually uses. youtube's are `PL...` /
// `UU...` / `RD...` and other extractors' are just as tame, but nothing
// arriving over ipc gets to write `../` into a path we then open for writing
const ARCHIVE_COMPONENT_PATTERN = /[^A-Za-z0-9_-]/g

/**
 * strip characters that are illegal in filenames (ported from shared_utils)
 * @param {string} filename - raw title
 * @returns {string} safe filename fragment
 */
function sanitizeFilename(filename) {
  let name = String(filename == null ? "" : filename)

  // basename: drop anything up to the last path separator
  name = name.split(/[\\/]/).pop()

  // eslint-disable-next-line no-control-regex
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
  name = name.replace(/\s+/g, " ").trim()
  name = name.slice(0, 200)

  // windows rejects trailing dots/spaces and treats them specially
  name = name.replace(/[. ]+$/, "")

  return name || "video"
}

/**
 * seconds -> "MM:SS" or "HH:MM:SS" (ported from shared_utils.format_duration)
 * @param {number} seconds - duration
 * @returns {string} formatted duration
 */
function formatDuration(seconds) {
  if (!seconds) {
    return "00:00"
  }

  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
  }

  return `${pad(minutes)}:${pad(secs)}`
}

function pad(value) {
  return String(value).padStart(2, "0")
}

// a literal % in an output template would be read as a field spec by yt-dlp
function escapeTemplateLiteral(text) {
  return String(text).replace(/%/g, "%%")
}

// python used the low 5 digits of the epoch in ms
function filenameTimestamp(now = Date.now()) {
  return now % 100000
}

// "avc1.4d4020" / "vp09.00.40.08" / "av01.0.09M.08" -> the family name we sort
// and label by
function codecFamily(vcodec) {
  const value = String(vcodec == null ? "" : vcodec)
    .toLowerCase()
    .trim()

  if (!value || value === "none") return "unknown"
  if (value.startsWith("av01") || value.startsWith("av1")) return "av1"
  if (value.startsWith("vp09") || value.startsWith("vp9")) return "vp9"
  if (value.startsWith("vp08") || value.startsWith("vp8")) return "vp8"
  if (
    value.startsWith("hev1") ||
    value.startsWith("hvc1") ||
    value.startsWith("h265")
  ) {
    return "h265"
  }
  if (value.startsWith("avc1") || value.startsWith("h264")) return MP4_CODEC

  return value.split(".")[0]
}

// filesize is exact when yt-dlp knows it and approximate otherwise; either
// beats showing nothing, but a zero or a missing value must stay unknown
function formatSize(format) {
  for (const value of [format.filesize, format.filesize_approx]) {
    const size = Number(value)
    if (Number.isFinite(size) && size > 0) {
      return size
    }
  }

  return null
}

function audioRate(format) {
  return Number(format.abr) || Number(format.tbr) || 0
}

function audioOnlyFormats(formats) {
  return formats.filter(
    (format) =>
      format &&
      format.vcodec === "none" &&
      format.acodec &&
      format.acodec !== "none"
  )
}

// "mp4a.40.2" / "aac" -> aac; opus and vorbis stay themselves
function audioCodecFamily(acodec) {
  const value = String(acodec == null ? "" : acodec)
    .toLowerCase()
    .trim()

  if (!value || value === "none") return "unknown"
  if (value.startsWith("mp4a") || value.startsWith("aac")) return MP4_ACODEC

  return value.split(".")[0]
}

// lower sorts better, compared left to right - the fields yt-dlp's own sort
// applies to an audio stream (lang, quality, acodec, size, br), plus the
// `acodec:aac` that -t mp4 puts in front of them
function audioRank(format, container) {
  const family = audioCodecFamily(format.acodec)
  const preference = ACODEC_PREFERENCE.indexOf(family)

  return [
    // `lang` is the first field yt-dlp compares, and it puts the track the
    // video was recorded in ahead of every dub - so a 22-language upload is
    // sized against its original, not against whichever dub encoded loudest
    isOriginalTrack(format) ? 0 : 1,
    -(Number(format.quality) || 0),
    container === "mp4" && family !== MP4_ACODEC ? 1 : 0,
    preference === -1 ? ACODEC_PREFERENCE.length : preference,
    -(formatSize(format) || 0),
    -audioRate(format)
  ]
}

/**
 * the audio stream a merge really pulls in - its bytes belong in the tier size
 *
 * getting this wrong is a visible lie, and the two ways to get it wrong are
 * both real. verified against 2026.08.19 on a 22-language upload:
 *
 * - `-t mp4 -S res:1080` merges the original-language **aac** stream, not the
 *   opus one that tops the bitrate list (3.3 MB apart)
 * - `-t mkv` merges the original-language **opus** stream, not the loudest dub
 *   (4.4 MB apart)
 *
 * @param {Object[]} formats - the whole format list
 * @param {string} container - mp4 | mkv
 * @returns {Object|null} the format whose bytes to add, or null when there is none
 */
function pickBestAudio(formats, container) {
  const audioOnly = audioOnlyFormats(formats)

  if (audioOnly.length === 0) {
    return null
  }

  return audioOnly.reduce((best, format) =>
    isBetterRank(audioRank(format, container), audioRank(best, container))
      ? format
      : best
  )
}

// true when `a` sorts ahead of `b`; equal ranks keep whichever came first
function isBetterRank(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i]
    }
  }

  return false
}

// the track youtube recorded in, which is the one a download gets when nobody
// asks for anything. `language_preference: 10` is how yt-dlp marks it - the
// `format_note` says "English original (default)", but that string is a label
// in the video's own wording and not something to parse
const ORIGINAL_LANGUAGE_PREFERENCE = 10

function isOriginalTrack(format) {
  return Number(format.language_preference) === ORIGINAL_LANGUAGE_PREFERENCE
}

// yt-dlp reports no language at all on a video that was never dubbed, and a
// language of "none" on some extractors - neither is a code we can ask for
function trackLanguage(format) {
  const code = String(format.language == null ? "" : format.language).trim()

  return code && code.toLowerCase() !== "none" ? code : null
}

// the https formats carry a filesize and win yt-dlp's own `proto` sort; the
// m3u8 duplicates of the same height carry neither
function isProgressive(format) {
  return !String(format.protocol || "").includes("m3u8")
}

// lower sorts better, compared left to right - the same order yt-dlp applies
function streamRank(format) {
  const index = VCODEC_PREFERENCE.indexOf(codecFamily(format.vcodec))

  return [
    index === -1 ? VCODEC_PREFERENCE.length : index,
    isProgressive(format) ? 0 : 1,
    -(Number(format.tbr) || 0)
  ]
}

// ties keep `a`, which is the accumulator when this reduces a group
function betterStream(a, b) {
  return isBetterRank(streamRank(b), streamRank(a)) ? b : a
}

/**
 * the real quality ladder, straight out of the format list yt-dlp already gave us
 *
 * dropping `vcodec === "none"` is the whole of the curation: it takes the
 * storyboard entries (sb0-sb3, which report heights like 27 and 45) and the
 * audio-only formats with it, and what is left is a clean 144->2160 ladder.
 *
 * @param {Object} info - parsed --dump-json payload
 * @returns {Object[]} [{height, container, filesize, fps}], highest first
 */
function extractQualityTiers(info) {
  const formats = Array.isArray(info && info.formats) ? info.formats : []

  const videoFormats = formats.filter(
    (format) =>
      format &&
      format.vcodec &&
      format.vcodec !== "none" &&
      Number.isFinite(Number(format.height)) &&
      Number(format.height) > 0
  )

  // one pick per container, not one overall: which stream a merge really adds
  // depends on the container the tier promises. no audio stream at all means a
  // merge adds nothing (0); one whose size yt-dlp never reported means it adds
  // an unknown number of bytes (null)
  const audioSizeFor = new Map(
    ["mp4", "mkv"].map((container) => {
      const audio = pickBestAudio(formats, container)

      return [container, audio ? formatSize(audio) : 0]
    })
  )

  const byHeight = new Map()
  for (const format of videoFormats) {
    const height = Math.round(Number(format.height))
    const group = byHeight.get(height)
    if (group) {
      group.push(format)
    } else {
      byHeight.set(height, [format])
    }
  }

  const tiers = []

  for (const [height, group] of byHeight) {
    // container is data-driven: mp4 only where an h264 stream really exists
    const h264 = group.filter((format) => codecFamily(format.vcodec) === MP4_CODEC)
    const container = h264.length > 0 ? "mp4" : "mkv"
    const chosen = (h264.length > 0 ? h264 : group).reduce(betterStream)

    const videoSize = formatSize(chosen)
    const muxed = Boolean(chosen.acodec && chosen.acodec !== "none")
    // a pre-muxed stream already carries its audio, so nothing is added to it
    const audioSize = muxed ? 0 : audioSizeFor.get(container)
    const fps = Math.round(Number(chosen.fps))

    tiers.push({
      height,
      container,
      // either half unknown makes the total unknown. adding a missing audio
      // size as 0 would dress a video-only figure up as the download's cost,
      // and a confident wrong number is worse than no number at all
      filesize:
        videoSize === null || audioSize === null ? null : videoSize + audioSize,
      fps: Number.isFinite(fps) && fps > 0 ? fps : null
    })
  }

  // the menu reads top down, best first
  return tiers.sort((a, b) => b.height - a.height)
}

/**
 * the dubbed audio languages this video carries, if it carries more than one
 *
 * a dubbed video returns one audio track per language - 22 of them on a MrBeast
 * upload - and handing the user whichever one yt-dlp picks is not a preference,
 * it is the wrong file. so the languages come out of the format list the same
 * way the quality ladder does.
 *
 * **an empty array means "there is no choice here"**, not "we found nothing":
 * a video with one language (or none, which is what an undubbed video reports)
 * has nothing to pick between, and that is nearly every video. the renderer
 * shows no picker at all in that case and the download args are untouched.
 *
 * @param {Object} info - parsed --dump-json payload
 * @returns {Object[]} [{code, is_original}], original first, or [] when there
 *   are fewer than two languages
 */
function extractAudioTracks(info) {
  const formats = Array.isArray(info && info.formats) ? info.formats : []

  const byCode = new Map()

  for (const format of audioOnlyFormats(formats)) {
    const code = trackLanguage(format)
    if (!code) continue

    // one language has several formats (low/medium, drc and not) and the
    // original marker only has to appear on one of them
    const existing = byCode.get(code)
    if (existing) {
      existing.is_original = existing.is_original || isOriginalTrack(format)
    } else {
      byCode.set(code, { code, is_original: isOriginalTrack(format) })
    }
  }

  if (byCode.size < 2) {
    return []
  }

  const tracks = [...byCode.values()]

  // the original is what the user gets today, so it heads the list and is what
  // the picker opens on; the rest keep the order the extractor listed them in
  return [
    ...tracks.filter((track) => track.is_original),
    ...tracks.filter((track) => !track.is_original)
  ]
}

/**
 * youtube video info -> the VideoInfoResponse shape the renderer renders
 *
 * the quality menu is `quality_tiers` and nothing else: no preset list, and no
 * special case for shorts, which have real heights like any other video
 *
 * @param {Object} info - parsed --dump-json payload
 * @returns {Object} response body
 */
function mapVideoInfo(info) {
  return {
    title: info.title || "Unknown",
    duration: Math.floor(info.duration || 0),
    duration_string: formatDuration(info.duration || 0),
    thumbnail: info.thumbnail || null,
    uploader: info.uploader || "Unknown",
    quality_tiers: extractQualityTiers(info),
    audio_tracks: extractAudioTracks(info)
  }
}

/**
 * the thumbnail for one playlist row
 *
 * a flat entry carries a `thumbnails[]` array rather than the single
 * `thumbnail` field mapVideoInfo reads, ordered worst first the way yt-dlp
 * orders every thumbnail list - so the last usable one is its own best pick.
 * on youtube that is 336x188, which is the right size for a list row anyway.
 *
 * @param {Object[]} thumbnails - the entry's thumbnails
 * @returns {string|null} url, or null when there is none
 */
function pickEntryThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails)) {
    return null
  }

  for (let index = thumbnails.length - 1; index >= 0; index -= 1) {
    const url = thumbnails[index] && thumbnails[index].url

    if (typeof url === "string" && url.trim()) {
      return url.trim()
    }
  }

  return null
}

/**
 * can the user actually download this entry?
 *
 * a deleted or private video still appears in the listing, and getting this
 * wrong is expensive: an entry we call downloadable is one the user ticks,
 * which then errors and spends one of the five --skip-playlist-after-errors
 * failures. five private videos in a row would end the whole run.
 *
 * so it is worth being exact about what such an entry looks like. measured
 * against 2026.08.19 on a 19-item playlist holding 5 private videos:
 *
 *     { id: "mt7rGhAm2CY", title: null, duration: null, view_count: null,
 *       live_status: null, availability: null,
 *       thumbnails: [4 placeholders],
 *       url: "https://www.youtube.com/watch?v=mt7rGhAm2CY" }
 *
 * two things that sound like the signal are not. there is no `[Private video]`
 * title to match - the title is **null**, and were it there it would be
 * localised anyway. and the url is *always* present: yt-dlp synthesises it
 * from the video id for every entry it sees, dead or alive, so "has no url"
 * is never true for a youtube listing.
 *
 * what is left is no duration and no title, and both halves are needed: a live
 * stream also reports no duration, and what it has is a title.
 *
 * @param {Object} entry - one flat playlist entry
 * @param {number|null} duration - the duration already read off it
 * @returns {boolean} true when there is nothing here to download
 */
function isUnavailableEntry(entry, duration) {
  if (duration !== null) {
    return false
  }

  return !String(entry.title == null ? "" : entry.title).trim()
}

/**
 * one flat playlist entry -> one row
 * @param {Object} entry - the entry, or null where yt-dlp emitted nothing
 * @param {number} index - its 1-based position in the playlist
 * @returns {Object} row
 */
function mapPlaylistEntry(entry, index) {
  const source = entry || {}
  const seconds = Number(source.duration)
  const duration =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null

  return {
    index,
    id: source.id || null,
    title: source.title || "Unknown",
    duration,
    // null rather than formatDuration's "00:00": a row with no duration has
    // nothing to show, and a zero would read as a video of zero length
    duration_string: duration === null ? null : formatDuration(duration),
    thumbnail: pickEntryThumbnail(source.thumbnails),
    unavailable: isUnavailableEntry(source, duration)
  }
}

/**
 * playlist info -> the shape the playlist list renders
 *
 * the entries come from `--flat-playlist`, which carries no formats at all -
 * so there is no quality ladder and no byte size here, and there cannot be.
 * that is the whole reason a playlist's quality menu is a fixed ceiling rather
 * than one derived from what the video really offers.
 *
 * @param {Object} info - parsed --dump-single-json payload
 * @returns {Object} response body
 */
function mapPlaylistInfo(info) {
  const source = info || {}
  const entries = Array.isArray(source.entries) ? source.entries : []

  // the playlist's *true* size. a `list=PL...` playlist reports it even when
  // the listing was bounded (183 reported, 100 returned - measured); a channel
  // feed paginates lazily and reports nothing at all. that null is passed on
  // rather than papered over with the number we happened to fetch, because the
  // two mean different things to the header
  //
  // Number(null) is 0, so the absent case has to be tested before the coercion
  // rather than after it - a channel feed would otherwise report a playlist of
  // zero videos while listing a hundred of them
  const total =
    source.playlist_count == null ? NaN : Number(source.playlist_count)
  const count = Number.isFinite(total) && total >= 0 ? Math.floor(total) : null

  return {
    playlist_id: source.id || null,
    title: source.title || "Unknown",
    uploader: source.uploader || source.channel || "Unknown",
    count,
    listed: entries.length,
    // "there is more of this than we are showing you", which is only something
    // we can claim when the true size is known
    truncated: count !== null && count > entries.length,
    // the position in the array *is* the playlist index: the listing is always
    // taken from item 1, and a flat entry carries no playlist_index field of
    // its own - verified against 2026.08.19. counting positions also keeps the
    // numbering aligned when yt-dlp emits a null entry, where reading a field
    // off the entry would not
    entries: entries.map((entry, position) => mapPlaylistEntry(entry, position + 1))
  }
}

/**
 * tiktok / pinterest info -> their simpler shared shape
 * @param {Object} info - parsed --dump-json payload
 * @param {string} fallbackTitle - used when the extractor has no title
 * @returns {Object} response body
 */
function mapSimpleInfo(info, fallbackTitle = "video") {
  return {
    title: info.title || fallbackTitle,
    duration: Math.floor(info.duration || 0),
    duration_string: formatDuration(info.duration || 0),
    thumbnail: info.thumbnail || null,
    // python fell back through uploader -> channel -> creator, in that order
    uploader: info.uploader || info.channel || info.creator || "Unknown"
  }
}

/**
 * does this extraction actually contain a playable video stream?
 * pinterest pins are often just images, which the python service rejected
 * @param {Object} info - parsed --dump-json payload
 * @returns {boolean} true when a video stream is present
 */
function hasPlayableVideo(info) {
  if (!info) return false

  const formats = Array.isArray(info.formats) ? info.formats : []

  // python inspected the format list and nothing else - metadata with no
  // formats (an image pin carrying a duration field) was never downloadable
  if (formats.length === 0) {
    return false
  }

  return formats.some(
    (format) => format && format.vcodec && format.vcodec !== "none"
  )
}

/**
 * output template for a combined video download
 *
 * the title, the sanitising and the byte-safe truncation are yt-dlp's own, and
 * the height is the one it really downloaded rather than the one we asked for
 *
 * @param {Object} params - {timeRange}
 * @returns {string} yt-dlp -o template
 */
function buildVideoOutputTemplate({ timeRange } = {}) {
  return timeRange ? VIDEO_TRIM_TEMPLATE : VIDEO_TEMPLATE
}

/**
 * output template for an audio download
 * @param {Object} params - {timeRange}
 * @returns {string} yt-dlp -o template
 */
function buildAudioOutputTemplate({ timeRange } = {}) {
  return timeRange ? AUDIO_TRIM_TEMPLATE : AUDIO_TEMPLATE
}

/**
 * output template for a playlist download
 *
 * both land in one folder per playlist; only the video name carries the
 * height, which is what keeps the per-quality download archive meaningful -
 * see the templates for why
 *
 * @param {Object} params - {audioOnly}
 * @returns {string} yt-dlp -o template
 */
function buildPlaylistOutputTemplate({ audioOnly } = {}) {
  return audioOnly ? PLAYLIST_AUDIO_TEMPLATE : PLAYLIST_VIDEO_TEMPLATE
}

/**
 * where the resume archive for one playlist run lives
 *
 * the archive is keyed by video id and nothing else, which makes it
 * quality-blind: a single `archive.txt` per playlist would make "download this
 * one again in 4K" silently do nothing at all. scoping the *filename* by the
 * quality as well gives resume where the user wants it - an interrupted run
 * continues - and a fresh run when they change their mind.
 *
 * @param {Object} params - {userDataPath, playlistId, mode} - mode names the
 *   quality the run asked for, "1080p-mp4" or "mp3"
 * @returns {string} absolute path to the archive file
 * @throws {Error} when there is no userData path, or no mode to scope by
 */
function buildPlaylistArchivePath({ userDataPath, playlistId, mode, outputDir } = {}) {
  if (!userDataPath) {
    throw new Error("A playlist archive needs a userData path.")
  }

  // the mode is the whole point of this function, so a missing one is refused
  // rather than defaulted. a default would be one shared filename that two
  // careless callers at different qualities both land on - which is exactly
  // the quality-blind archive the scoping exists to avoid
  if (!mode) {
    throw new Error("A playlist archive needs the quality it is scoped to.")
  }

  // ...and the destination for the same reason one layer out. an archive
  // records that a download once succeeded, not that a file is on disk now:
  // download to one folder, pick another, run again, and a destination-blind
  // archive skips the lot and reports a finished run over an empty folder.
  // scoping by folder does not make the archive a claim about the filesystem -
  // nothing can, which is why an archive skip is reported as `itemsReused`
  // rather than as a save - but it does stop the commonest way of being wrong
  if (!outputDir) {
    throw new Error("A playlist archive needs to know where the files go.")
  }

  // the folder is hashed rather than sanitised into the name: a full path is
  // far longer than the component limit, and squeezing it would collide two
  // different folders under one archive. resolved first so `a/sub/..` and `a`
  // are one scope
  const destination = crypto
    .createHash("sha256")
    .update(path.resolve(outputDir))
    .digest("hex")
    .slice(0, 8)

  const name =
    `${archiveComponent(playlistId, "playlist")}__` +
    `${archiveComponent(mode, "any")}__${destination}`

  return path.join(userDataPath, PLAYLIST_ARCHIVE_DIR, `${name}.txt`)
}

// one half of an archive filename, reduced to characters that cannot mean
// anything to a filesystem. the length cap is the same 255-byte component
// limit --trim-filenames exists for
function archiveComponent(value, fallback) {
  const cleaned = String(value == null ? "" : value)
    .replace(ARCHIVE_COMPONENT_PATTERN, "")
    .slice(0, 100)

  return cleaned || fallback
}

/**
 * output template for a simple platform download (tiktok / pinterest)
 * @param {Object} params - {title, platform, now}
 * @returns {string} yt-dlp -o template
 */
function buildSimpleOutputTemplate({ title, platform, now }) {
  const safeTitle = sanitizeFilename(title || `${platform}_video`)
  const timestamp = filenameTimestamp(now)

  return `${escapeTemplateLiteral(`${safeTitle}_${platform}_${timestamp}`)}.%(ext)s`
}

module.exports = {
  hasPlayableVideo,
  sanitizeFilename,
  formatDuration,
  escapeTemplateLiteral,
  filenameTimestamp,
  extractQualityTiers,
  extractAudioTracks,
  mapVideoInfo,
  mapSimpleInfo,
  mapPlaylistInfo,
  buildVideoOutputTemplate,
  buildAudioOutputTemplate,
  buildPlaylistOutputTemplate,
  buildPlaylistArchivePath,
  buildSimpleOutputTemplate,
  // the engine builds `-I 1:<cap>` and bounds the selection against the same
  // number - this module owns it because the index padding is derived from it
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_INDEX_WIDTH,
  PLAYLIST_ARCHIVE_DIR
}
