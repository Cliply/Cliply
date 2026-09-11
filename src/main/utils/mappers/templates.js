/**
 * output templates and the filename helpers around them
 *
 * the -o strings a download is named by, the sanitising the simple platforms
 * still need, and the resume archive path a playlist run is scoped to
 */

const crypto = require("crypto")
const path = require("path")

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

// a literal % in an output template would be read as a field spec by yt-dlp
function escapeTemplateLiteral(text) {
  return String(text).replace(/%/g, "%%")
}

// python used the low 5 digits of the epoch in ms
function filenameTimestamp(now = Date.now()) {
  return now % 100000
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
  sanitizeFilename,
  escapeTemplateLiteral,
  buildVideoOutputTemplate,
  buildAudioOutputTemplate,
  buildPlaylistOutputTemplate,
  buildPlaylistArchivePath,
  buildSimpleOutputTemplate,
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_INDEX_WIDTH,
  PLAYLIST_ARCHIVE_DIR
}
