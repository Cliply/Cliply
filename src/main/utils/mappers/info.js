/**
 * the info dict yt-dlp dumps, mapped onto the response shapes the renderer
 * renders
 *
 * one function per payload: a youtube video, a flat playlist listing, and the
 * simpler shape tiktok and pinterest share
 */

const { extractAudioTracks, extractQualityTiers } = require("./formats")

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

module.exports = {
  formatDuration,
  mapVideoInfo,
  mapPlaylistInfo,
  mapSimpleInfo,
  hasPlayableVideo
}
