/**
 * transcript plumbing
 *
 * a transcript download is a yt-dlp run with `--skip-download`, so nothing in
 * the engine's progress or destination parsing sees the file it wrote: there
 * is no `[download] Destination:` line for a subtitle and `after_move` never
 * fires. what it writes is found on disk instead, which is what most of this
 * module is for.
 *
 * the other half is `txt`. it is not a subtitle format and yt-dlp cannot
 * convert to it - it is the srt with the cue numbers and the timing lines
 * taken out, which is the shape people actually paste into a document.
 */

const fs = require("fs")
const path = require("path")

/**
 * every extension yt-dlp may leave behind for a subtitle track
 *
 * the app only ever asks for srt or vtt, but `--convert-subs` runs *after* the
 * original is written and a conversion that failed leaves the source next to
 * nothing else. so the whole list is here: an unconverted track is still a
 * transcript, and handing the user the file that exists beats reporting that
 * the one we wanted does not.
 */
const SUBTITLE_EXTENSIONS = new Set([
  ".srt",
  ".vtt",
  ".ass",
  ".ssa",
  ".lrc",
  ".ttml",
  ".srv1",
  ".srv2",
  ".srv3",
  ".json3"
])

/**
 * the formats the transcript flow offers, and the subtitle format each one is
 * downloaded as
 *
 * `txt` maps to srt because that is what it is made from - one cue per block,
 * already converted out of whatever the extractor served, which is far less
 * work to strip than webvtt's inline timing tags.
 */
const TRANSCRIPT_FORMATS = { srt: "srt", vtt: "vtt", txt: "srt" }

// the extension a finished transcript carries, per requested format
const TRANSCRIPT_EXTENSIONS = { srt: ".srt", vtt: ".vtt", txt: ".txt" }

/**
 * the formats the srt half of a `txt` request may arrive as
 *
 * `--convert-subs srt` is a best effort: ffmpeg refuses some sources (json3
 * among them), and when it does the original is what is on disk. plain text
 * can still be made out of a vtt, so both are accepted.
 */
const PLAIN_TEXT_SOURCES = new Set([".srt", ".vtt"])

// cue numbers in an srt block: a line that is nothing but digits
const CUE_INDEX_PATTERN = /^\d+$/

// an srt or vtt timing line - the arrow is what makes it one
const TIMING_PATTERN = /-->/

// webvtt's own block headers, which carry no words of the transcript
const VTT_HEADER_PATTERN = /^(WEBVTT|Kind:|Language:|NOTE\b|STYLE\b|REGION\b)/

// `<c>`, `</c>`, `<00:00:00.480>` and `<i>` - webvtt's inline karaoke timing
// and styling, all of which look like markup and none of which is spoken
const INLINE_TAG_PATTERN = /<[^>]*>/g

// `{\an8}` and friends - ass/ssa override blocks that survive a conversion
const OVERRIDE_BLOCK_PATTERN = /\{\\[^}]*\}/g

// the handful of entities a caption track actually contains
const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " "
}

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39|apos|nbsp);/g

/**
 * the file names a directory holds right now
 *
 * a transcript download is located by diffing this before and after, so a
 * directory that cannot be read has to come back as "nothing was there" rather
 * than throwing - the download itself may still have succeeded, and the prefix
 * match is the other way of finding it.
 *
 * @param {string} directory - where downloads land
 * @returns {Set<string>} file names, or an empty set when it cannot be read
 */
function listDirectory(directory) {
  try {
    return new Set(fs.readdirSync(directory))
  } catch {
    return new Set()
  }
}

/**
 * a path's extension, lowercased and with its dot
 * @param {string} filePath - a file name or path
 * @returns {string} the extension, or "" when there is none
 */
function extensionOf(filePath) {
  return path.extname(String(filePath == null ? "" : filePath)).toLowerCase()
}

/**
 * is this a file yt-dlp wrote for a subtitle track?
 * @param {string} name - a file name
 * @returns {boolean} whether its extension is a subtitle one
 */
function isSubtitleFile(name) {
  return SUBTITLE_EXTENSIONS.has(extensionOf(name))
}

/**
 * the files one transcript download wrote
 *
 * two ways of finding them, because each one fails somewhere the other does
 * not. the prefix is the output template's own stem, which is exact but can be
 * cut short by `--trim-filenames` on a very long title; the before/after diff
 * catches whatever the prefix missed but would also catch a *different*
 * download finishing into the same folder at the same moment. so the prefix
 * wins whenever it matches anything, and the diff is the fallback.
 *
 * @param {string} directory - the output directory
 * @param {Object} options - {stem, before} - before is listDirectory()'s
 *   snapshot from just before the run
 * @returns {string[]} absolute paths, newest-looking order not guaranteed
 */
function findTranscriptFiles(directory, { stem, before = new Set() } = {}) {
  const now = [...listDirectory(directory)].filter(isSubtitleFile)

  const byPrefix = stem ? now.filter((name) => name.startsWith(`${stem}.`)) : []

  const found = byPrefix.length > 0 ? byPrefix : now.filter((name) => !before.has(name))

  return found.map((name) => path.join(directory, name))
}

/**
 * the one file to hand back when a track wrote several
 *
 * `--convert-subs` leaves the original behind when it converts, so a request
 * for srt can end up next to the vtt it was made from. the requested extension
 * is what the user asked for and what the response should name.
 *
 * @param {string[]} files - what findTranscriptFiles returned
 * @param {string} extension - the extension to prefer, with its dot
 * @returns {string|null} the best match, or null when there were no files
 */
function preferExtension(files, extension) {
  if (!Array.isArray(files) || files.length === 0) {
    return null
  }

  const wanted = String(extension || "").toLowerCase()
  const match = files.find((file) => extensionOf(file) === wanted)

  return match || files[0]
}

/**
 * an srt or vtt turned into the words in it
 *
 * consecutive duplicates are dropped, and that is not tidying: youtube's
 * automatic captions roll, so the same sentence is emitted two or three times
 * as the next one scrolls in under it. keeping them would triple the file and
 * make it unreadable. non-consecutive repeats are left alone - a chorus is
 * meant to be there twice.
 *
 * @param {string} text - the subtitle file's contents
 * @returns {string} one line per caption, blank lines and timings gone
 */
function subtitleToPlainText(text) {
  const source = String(text == null ? "" : text).replace(/\r\n?/g, "\n")

  const lines = []
  let previous = null

  for (const raw of source.split("\n")) {
    const line = raw.trim()

    if (!line) continue
    if (TIMING_PATTERN.test(line)) continue
    if (CUE_INDEX_PATTERN.test(line)) continue
    if (VTT_HEADER_PATTERN.test(line)) continue

    const cleaned = line
      .replace(INLINE_TAG_PATTERN, "")
      .replace(OVERRIDE_BLOCK_PATTERN, "")
      .replace(ENTITY_PATTERN, (entity) => ENTITIES[entity] || entity)
      .replace(/\s+/g, " ")
      .trim()

    if (!cleaned) continue
    if (cleaned === previous) continue

    lines.push(cleaned)
    previous = cleaned
  }

  return lines.join("\n")
}

/**
 * write the plain-text version of a subtitle file next to it
 *
 * the source is removed once the text is on disk: the user asked for a
 * transcript and got one file, not one file and the intermediate it was made
 * from. a removal that fails is not worth failing the download over - the text
 * is already written, which is what was asked for.
 *
 * @param {string} filePath - the srt (or vtt) yt-dlp wrote
 * @returns {string} the path of the .txt file
 * @throws {Error} when the source cannot be read or the text cannot be written
 */
function writePlainText(filePath) {
  const source = fs.readFileSync(filePath, "utf8")
  const target = replaceExtension(filePath, ".txt")

  fs.writeFileSync(target, `${subtitleToPlainText(source)}\n`, "utf8")

  if (path.resolve(target) !== path.resolve(filePath)) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      // the transcript exists either way, which is the thing that mattered
    }
  }

  return target
}

/**
 * swap a path's extension, keeping the language suffix yt-dlp appended
 * ("clip.en.srt" -> "clip.en.txt", never "clip.txt")
 * @param {string} filePath - the path to rewrite
 * @param {string} extension - the new extension, with its dot
 * @returns {string} the rewritten path
 */
function replaceExtension(filePath, extension) {
  const directory = path.dirname(filePath)
  const base = path.basename(filePath, path.extname(filePath))

  return path.join(directory, `${base}${extension}`)
}

/**
 * delete the files a transcript download left behind that nobody asked for
 *
 * `--convert-subs` keeps the original, so a folder can end up with the vtt the
 * srt was converted from. best effort by design: an undeletable leftover is
 * clutter, and clutter is not a reason to report a finished download as broken.
 *
 * @param {string[]} files - every file the download wrote
 * @param {string} keep - the one to leave alone
 */
function removeLeftovers(files, keep) {
  const kept = keep ? path.resolve(keep) : null

  for (const file of files) {
    if (kept && path.resolve(file) === kept) continue

    try {
      fs.unlinkSync(file)
    } catch {
      // see the doc comment - nothing here is worth a failure
    }
  }
}

module.exports = {
  SUBTITLE_EXTENSIONS,
  TRANSCRIPT_FORMATS,
  TRANSCRIPT_EXTENSIONS,
  PLAIN_TEXT_SOURCES,
  listDirectory,
  extensionOf,
  isSubtitleFile,
  findTranscriptFiles,
  preferExtension,
  subtitleToPlainText,
  writePlainText,
  replaceExtension,
  removeLeftovers
}
