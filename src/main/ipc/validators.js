// normalise and refuse an incoming request payload

const { PLAYLIST_MAX_ITEMS } = require("../services/ytdlp-engine")

// platforms served by the binary engine's single-video flows
const SUPPORTED_DOWNLOAD_PLATFORMS = ["youtube", "pinterest", "tiktok"]

/**
 * the audio modes a playlist may ask for
 *
 * the engine falls back to mp3 for anything it does not recognise, which is
 * the right answer for a download and the wrong one for the archive beside it:
 * the archive filename is scoped by the mode the *request* named, so an
 * unrecognised mode would file an mp3 run under its own name and no later run
 * would ever find it again. refused here, where the two still agree.
 */
const PLAYLIST_AUDIO_MODES = ["mp3", "m4a", "original"]

// a youtube video id. it becomes an archive lookup key, and an id that is not
// an id would simply never match one - which reads as "download this again"
// rather than as the malformed payload it is
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]+$/

// the highest ceiling the quality menu offers, with room above it. a height is
// not just passed through here the way the single-video flow passes one: it
// names the archive this run resumes from, so a NaN would scope every garbled
// request to one shared file
const PLAYLIST_MAX_HEIGHT = 4320

/**
 * treat an empty or zero-length selection as "no time range"
 *
 * the renderer only sends a range for a real segment now, but a stale client
 * (or the {start:0,end:0} the store starts with) must not turn a full download
 * into an ffmpeg section download, which costs granular progress and speed.
 *
 * @param {Object} range - {start, end} in seconds, or nothing
 * @returns {Object|undefined} the range, or undefined when it is not a segment
 */
function normalizeTimeRange(range) {
  if (!range) return undefined

  const start = Number(range.start) || 0
  const end = Number(range.end) || 0

  if (end <= start) return undefined

  return { start, end }
}

/**
 * playlists are a youtube feature, and this is where that is enforced
 *
 * an absent platform means youtube, which is the default every single-video
 * handler already applies to the same field. **this is not the check that
 * matters** - see isYouTubeRequestUrl, which reads the link rather than the
 * label.
 *
 * @param {*} platform - what the request named, if anything
 * @returns {boolean} whether a playlist request may proceed
 */
function isPlaylistPlatform(platform) {
  return (platform ? String(platform).toLowerCase() : "youtube") === "youtube"
}

/**
 * is this link actually youtube's?
 *
 * the request half of the two youtube predicates: it decides whether a request
 * is allowed to proceed, which is why it insists on a real http(s) link. The
 * engine's isYouTubeCookieHost answers a different question and is wider.
 *
 * the `platform` field is optional and arrives from the renderer, which does
 * not send it for a playlist at all - so a handler that only checks the label
 * checks nothing. the engine will not save us either: `normalizeUrl` asks for
 * an http(s) link and no more, so a vimeo url with the right shape around it
 * reached yt-dlp. the host is the only evidence here, so the host is what is
 * read.
 *
 * the test is anchored at the **end** of the hostname, for the reason the
 * renderer's PINTEREST_URL_REGEX comment spells out: the interesting part of a
 * hostname is where it ends, not whether our word appears somewhere in it, and
 * `youtube.com.evil.com` is somebody else's domain. any subdomain is fine
 * (`m.`, `music.`, `www.`), and `youtu.be` is admitted exactly, never as a
 * suffix - `myyoutu.be` is not ours.
 *
 * a link with no scheme does not parse and is refused. that is not new: the
 * engine's normalizeUrl already refuses one for every download there is, so
 * this only says so before anything spawns.
 *
 * @param {*} url - the link the request carried
 * @returns {boolean} whether it points at youtube
 */
function isYouTubeRequestUrl(url) {
  if (typeof url !== "string") return false

  let parsed

  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false
  }

  // URL lowercases the hostname for us, so this needs no folding of its own
  const host = parsed.hostname

  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be"
  )
}

/**
 * the selection, checked before anything can spawn on it
 *
 * this is untrusted input twice over. the indices become yt-dlp's `-I` spec,
 * and the ids are what the engine intersects with the download archive to work
 * out what it is allowed to skip - so both halves are checked for what they
 * are, never coerced into it.
 *
 * @param {Object[]} entries - [{index, id}] as the renderer read them off the
 *   listing it is showing
 * @returns {Object[]} the same entries, validated
 * @throws {Error} carrying the sentence the user is shown
 */
function normalizePlaylistEntries(entries) {
  // an empty selection is not an empty spec: `-I ""` is the *absence* of a
  // selection, which downloads the whole playlist. so "nothing was ticked" has
  // to be refused rather than left to become the largest download available
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Select at least one video to download.")
  }

  if (entries.length > PLAYLIST_MAX_ITEMS) {
    throw new Error(
      `Cliply downloads at most ${PLAYLIST_MAX_ITEMS} videos from a playlist at a time.`
    )
  }

  const seen = new Set()

  return entries.map((entry) => {
    const index = entry ? entry.index : null
    const id = entry ? entry.id : null

    // an integer and only an integer: coercing "3" or 3.5 into a position is
    // how a malformed payload gets laundered into something -I accepts
    if (!Number.isInteger(index) || index < 1 || index > PLAYLIST_MAX_ITEMS) {
      throw new Error("That selection isn't a list of playlist positions.")
    }

    if (typeof id !== "string" || !VIDEO_ID_PATTERN.test(id)) {
      throw new Error("That selection carries a video id we can't read.")
    }

    // the same position twice downloads once and is counted twice - once as
    // another item asked for, and again as another archive skip
    if (seen.has(index)) {
      throw new Error("That selection lists the same video twice.")
    }

    seen.add(index)
    return { index, id }
  })
}

/**
 * the quality ceiling for a playlist, as a number the archive can be named for
 * @param {*} height - whatever the request sent
 * @returns {number} the ceiling
 * @throws {Error} when it is not a height
 */
function normalizePlaylistHeight(height) {
  const value = Number(height)

  if (!Number.isInteger(value) || value < 1 || value > PLAYLIST_MAX_HEIGHT) {
    throw new Error("That isn't a quality we can download a playlist at.")
  }

  return value
}

/**
 * the audio mode for a playlist download
 * @param {*} audioMode - whatever the request sent
 * @returns {string} mp3 | m4a | original
 * @throws {Error} when it is none of them
 */
function normalizePlaylistAudioMode(audioMode) {
  const mode = String(audioMode || "").toLowerCase()

  if (!PLAYLIST_AUDIO_MODES.includes(mode)) {
    throw new Error("That isn't an audio format we can download a playlist as.")
  }

  return mode
}

module.exports = {
  SUPPORTED_DOWNLOAD_PLATFORMS,
  PLAYLIST_AUDIO_MODES,
  VIDEO_ID_PATTERN,
  PLAYLIST_MAX_HEIGHT,
  normalizeTimeRange,
  isPlaylistPlatform,
  isYouTubeRequestUrl,
  normalizePlaylistEntries,
  normalizePlaylistHeight,
  normalizePlaylistAudioMode
}
