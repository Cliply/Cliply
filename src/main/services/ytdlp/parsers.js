/**
 * what yt-dlp prints, and how to read it back
 *
 * the --print / --progress-template strings the engine asks for, and the
 * parsers written against them: one stdout line in, one fact out
 */

// stdout is machine-readable only: --print implies --quiet, so the only lines
// yt-dlp writes are our two prefixed templates (verified against 2026.08.19)
const PROGRESS_PREFIX = "CLIPLY|"
const FILE_PREFIX = "CLIPLY_FILE|"
const STREAM_PREFIX = "CLIPLY_STREAM|"
const PROGRESS_TEMPLATE = `download:${PROGRESS_PREFIX}%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.eta)s`
const FILE_TEMPLATE = `after_move:${FILE_PREFIX}%(filepath)s`
// fires once before the download starts, carrying the format actually chosen
// ("160+139" for a merge, "18" for a pre-muxed file) - that is how many 0-100%
// sweeps the progress lines will make
const STREAM_TEMPLATE = `before_dl:${STREAM_PREFIX}%(format_id)s`

// the playlist half of the same three prints. a parallel set rather than three
// fields bolted onto the templates above, because a single-video run has no
// playlist context at all: %(info.playlist_autonumber)s renders as `NA` there,
// and every parser that reads these lines today would have to learn to ignore
// it. an operation picks one set or the other and the two never meet.
//
// PROGRESS carries **playlist_autonumber, never playlist_index**. autonumber
// is the item's position in the download *queue*: measured with `-I "1,5,9"`
// it reads 1, 2, 3 while playlist_index reads 1, 5, 9, so a bar built from the
// index would render "video 9 of 3". STREAM carries both, because the index is
// what names the file and what the per-row ui maps onto.
//
// there is no n_entries, which yt-dlp would happily supply. **the denominator
// is the selection the user made**, which the engine already knows and which
// nothing on this channel is allowed to contradict: an item that left the
// playlist between the listing and the download is one of the skipped, not a
// reason to quietly redefine the job as the smaller one that turned out to be
// possible. it is also the last number here that a forged line could move
const PLAYLIST_PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}%(progress._percent_str)s|%(progress._speed_str)s|` +
  `%(progress._eta_str)s|%(progress.eta)s|%(info.playlist_autonumber)s`
const PLAYLIST_STREAM_TEMPLATE =
  `before_dl:${STREAM_PREFIX}%(playlist_autonumber)s|%(playlist_index)s|%(id)s|%(format_id)s`
// ...and FILE carries the path as **json**, not as a bare string. yt-dlp
// sanitises the parts of a name it derives from a title, but it does not touch
// the -P the user chose: a legal directory holding a newline splits a bare
// print across two lines, and the engine would record the truncation as the
// file it saved (measured on 2026.08.19 with a directory named "nl\ndir").
// the `j` conversion escapes the newline, and escapes non-ascii while it is
// there, so one marker is always exactly one line
const PLAYLIST_FILE_TEMPLATE =
  `after_move:${FILE_PREFIX}%(playlist_autonumber)s|%(filepath)j`

// ...and the same fact again, on a channel nothing else can write to.
//
// stdout is a **mixed** channel: --no-quiet puts yt-dlp's own log on it, and
// some of that log is metadata we did not author. a playlist title carrying a
// newline and a well-formed CLIPLY_FILE line after it is printed verbatim, so
// a marker on stdout is not evidence that anything was saved - and no amount
// of checking the path it names can fix that, because it can name a real file
// in the real download folder. measured: an unrelated mp4 seeded in the
// destination was reported as the saved item of a run whose only download
// failed.
//
// --print-to-file appends this template to a file only we know the name of,
// and only yt-dlp's own after_move hook appends to it. the template prints no
// free text, so nothing that reaches the file came from anywhere else. that
// file is the single source of truth for what was saved; the stdout marker
// above is kept for live per-row progress and decides nothing
const PLAYLIST_RECORD_TEMPLATE = "after_move:%(playlist_autonumber)s|%(filepath)j"

// strip terminal colour codes - yt-dlp adds them to _percent_str on some hosts
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

function stripAnsi(value) {
  return String(value == null ? "" : value).replace(ANSI_PATTERN, "")
}

// values yt-dlp prints when it simply doesn't know yet
function isUnknownValue(value) {
  const normalized = stripAnsi(value).trim().toLowerCase()
  return (
    normalized === "" ||
    normalized === "na" ||
    normalized === "n/a" ||
    normalized === "none" ||
    normalized.includes("unknown")
  )
}

/**
 * parse one CLIPLY| progress line
 * @param {string} line - raw stdout line
 * @returns {Object|null} {progress, speed, eta, etaSeconds} or null when not a progress line
 */
function parseProgressLine(line) {
  const text = stripAnsi(line).trim()

  if (!text.startsWith(PROGRESS_PREFIX)) {
    return null
  }

  const parts = text.slice(PROGRESS_PREFIX.length).split("|")
  const percent = parseFloat(stripAnsi(parts[0]).replace("%", "").trim())

  if (!Number.isFinite(percent)) {
    return null
  }

  const speed = isUnknownValue(parts[1]) ? null : stripAnsi(parts[1]).trim()
  const eta = isUnknownValue(parts[2]) ? null : stripAnsi(parts[2]).trim()
  const etaSecondsRaw = isUnknownValue(parts[3])
    ? NaN
    : parseFloat(stripAnsi(parts[3]).trim())

  return {
    progress: Math.min(100, Math.max(0, percent)),
    speed,
    eta,
    etaSeconds: Number.isFinite(etaSecondsRaw) ? Math.round(etaSecondsRaw) : null
  }
}

/**
 * parse the final destination out of a stdout line
 * @param {string} line - raw stdout line
 * @returns {string|null} absolute file path or null
 */
function parseDestinationLine(line) {
  const text = stripAnsi(line).trim()

  if (text.startsWith(FILE_PREFIX)) {
    const filePath = text.slice(FILE_PREFIX.length).trim()
    return filePath || null
  }

  // fallbacks for the non-quiet output shape, in case --print ever stops firing
  const destination = text.match(
    /^\[(?:download|ExtractAudio|VideoConvertor)\]\s+Destination:\s+(.+)$/
  )
  if (destination) {
    return destination[1].trim()
  }

  const merged = text.match(/^\[Merger\]\s+Merging formats into\s+"(.+)"$/)
  if (merged) {
    return merged[1].trim()
  }

  const alreadyThere = text.match(/^\[download\]\s+(.+) has already been downloaded$/)
  if (alreadyThere) {
    return alreadyThere[1].trim()
  }

  return null
}

/**
 * read how many streams a download will fetch from the before_dl marker
 * @param {string} line - raw stdout line
 * @returns {number|null} stream count, or null when not a marker line
 */
function parseStreamCountLine(line) {
  const text = stripAnsi(line).trim()

  if (!text.startsWith(STREAM_PREFIX)) {
    return null
  }

  const formatId = text.slice(STREAM_PREFIX.length).trim()
  if (!formatId) {
    return null
  }

  return formatId.split("+").filter(Boolean).length || 1
}

// the archive skip: an item recorded in --download-archive is never announced,
// never extracted and never downloaded - yt-dlp prints this one line and moves
// to the next item (measured against 2026.08.19). the id is the only handle we
// get on it, which is why this pattern captures it: it is what keeps two skips
// of the same run from collapsing into one count
// the title is optional because yt-dlp builds this line with
// format_field(info, "title", "%s "), which renders as empty for a null title -
// exactly what a video that was archived while public and has gone private
// since now reports. the id is always there, and the id is all we need
const ARCHIVE_SKIP_PATTERN =
  /^\[download\]\s+([^\s:]+):\s(?:.*\s)?has already been recorded in the archive$/

/**
 * parse one line of the record file yt-dlp appended to
 *
 * the same `<autonumber>|<json path>` shape the stdout marker carries, minus
 * the prefix - this file holds nothing else, so there is nothing to recognise
 *
 * @param {string} line - one line of the record file
 * @returns {Object|null} {itemIndex, filePath}, or null for anything else
 */
function parsePlaylistRecordLine(line) {
  const text = stripAnsi(line).trim()
  const separator = text.indexOf("|")

  if (separator === -1) {
    return null
  }

  let filePath
  try {
    filePath = JSON.parse(text.slice(separator + 1))
  } catch {
    return null
  }

  if (typeof filePath !== "string" || !filePath) {
    return null
  }

  return { itemIndex: parsePlaylistCounter(text.slice(0, separator)), filePath }
}

// there is deliberately no parser for `[download] <path> has already been
// downloaded` here. yt-dlp prints that sentence for the *input* to a
// postprocessor as readily as for a finished output: a cancelled mp3
// conversion leaves a complete .webm behind, and the retry announces that
// source and then fails the conversion, so the file the user asked for never
// exists. a merge intermediate does the same with an .f134.mp4. no test on
// the filename can tell an unfinished input from a finished output, so the
// line is not evidence and only after_move counts. the shipped binary fires
// after_move for a genuinely finished existing output, so nothing is lost;
// a future binary that stopped would undercount, which is the safe direction

/**
 * read one of the playlist counter fields
 *
 * yt-dlp renders these as `NA` whenever it has no playlist context to fill
 * them from, so "absent" is a normal reading rather than a malformed line
 *
 * @param {string} value - one raw field
 * @returns {number|null} a 1-based position or count, or null
 */
function parsePlaylistCounter(value) {
  if (isUnknownValue(value)) {
    return null
  }

  const parsed = parseInt(stripAnsi(value).trim(), 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * parse one playlist CLIPLY| progress line
 *
 * @param {string} line - raw stdout line
 * @returns {Object|null} {progress, speed, eta, etaSeconds, itemIndex, totalItems}
 */
function parsePlaylistProgressLine(line) {
  // the first four fields are the single-video template's, read by the single
  // video parser: the two templates share that prefix on purpose, and this is
  // what stops them drifting into two opinions about a percentage or an eta
  const parsed = parseProgressLine(line)

  if (!parsed) {
    return null
  }

  const parts = stripAnsi(line).trim().slice(PROGRESS_PREFIX.length).split("|")

  return {
    ...parsed,
    // playlist_autonumber, not playlist_index - see PLAYLIST_PROGRESS_TEMPLATE
    // for why the other one would render "video 9 of 3".
    //
    // and only this one field: anything past it is ignored rather than read.
    // n_entries used to sit at parts[5], and a fixture or a binary we have not
    // met may still print it there - it must not become a denominator by the
    // back door now that the selection owns that number
    itemIndex: parsePlaylistCounter(parts[4])
  }
}

/**
 * parse the playlist before_dl marker: a new item is starting
 *
 * @param {string} line - raw stdout line
 * @returns {Object|null} {itemIndex, playlistIndex, videoId, streams}
 */
function parsePlaylistStreamLine(line) {
  const text = stripAnsi(line).trim()

  if (!text.startsWith(STREAM_PREFIX)) {
    return null
  }

  const parts = text.slice(STREAM_PREFIX.length).split("|")
  const formatId = stripAnsi(parts[3] || "").trim()

  if (!formatId) {
    return null
  }

  return {
    itemIndex: parsePlaylistCounter(parts[0]),
    playlistIndex: parsePlaylistCounter(parts[1]),
    videoId: isUnknownValue(parts[2]) ? null : stripAnsi(parts[2]).trim(),
    // the same arithmetic parseStreamCountLine does: "134+140" is a merge, so
    // this item will sweep 0-100 twice
    streams: formatId.split("+").filter(Boolean).length || 1
  }
}

/**
 * parse the playlist after_move print: an item landed on disk
 *
 * @param {string} line - raw stdout line
 * @returns {Object|null} {itemIndex, filePath}
 */
function parsePlaylistFileLine(line) {
  const text = stripAnsi(line).trim()

  if (!text.startsWith(FILE_PREFIX)) {
    return null
  }

  const rest = text.slice(FILE_PREFIX.length)
  const separator = rest.indexOf("|")

  if (separator === -1) {
    return null
  }

  // split on the *first* separator only, then decode. the tail is json (see
  // PLAYLIST_FILE_TEMPLATE), which is what makes both of those safe: a "|" or
  // a newline inside the path is escaped, so it can neither be mistaken for a
  // separator nor cut the marker in half
  let filePath
  try {
    filePath = JSON.parse(rest.slice(separator + 1).trim())
  } catch {
    return null
  }

  if (typeof filePath !== "string" || !filePath) {
    return null
  }

  return { itemIndex: parsePlaylistCounter(rest.slice(0, separator)), filePath }
}

/**
 * parse an archive skip - an item we already have, that will never download
 *
 * @param {string} line - raw stdout line
 * @returns {string|null} the video id, or null when this is not an archive skip
 */
function parseArchiveSkipLine(line) {
  const match = stripAnsi(line).trim().match(ARCHIVE_SKIP_PATTERN)

  return match ? match[1] : null
}

module.exports = {
  FILE_PREFIX,
  PROGRESS_TEMPLATE,
  FILE_TEMPLATE,
  STREAM_TEMPLATE,
  PLAYLIST_PROGRESS_TEMPLATE,
  PLAYLIST_STREAM_TEMPLATE,
  PLAYLIST_FILE_TEMPLATE,
  PLAYLIST_RECORD_TEMPLATE,
  stripAnsi,
  parseProgressLine,
  parseDestinationLine,
  parseStreamCountLine,
  parsePlaylistProgressLine,
  parsePlaylistStreamLine,
  parsePlaylistFileLine,
  parsePlaylistRecordLine,
  parseArchiveSkipLine
}
