/**
 * playlist selection maths and the download archive - which positions a run
 * is about, which of them yt-dlp will skip, and what it proved it saved
 */

const fs = require("fs")
const path = require("path")

const {
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_ARCHIVE_DIR
} = require("../../utils/ytdlp-mappers")

// where those records live, under the engine's own state rather than the
// user's download folder
const PLAYLIST_RECORDS_DIR = "runs"

// the extractor half of a download-archive key. the playlist operations are
// youtube-only, so this is the only prefix an archive line may carry to be a
// record of something a selection of ours could be talking about
const PLAYLIST_ARCHIVE_EXTRACTOR = "youtube"

// the -I spec is written straight onto the command line, so it is whitelisted
// for the same reason TIER_CONTAINERS and AUDIO_LANGUAGE_PATTERN are: a list
// of indices arriving over ipc does not get to write yt-dlp option syntax
const PLAYLIST_ITEMS_PATTERN = /^[0-9,:]+$/

/**
 * validate a selection of 1-based playlist positions
 *
 * @param {number[]} indices - the positions the user ticked
 * @returns {number[]} the same positions, sorted and de-duplicated
 * @throws {Error} when the selection is empty, or holds anything that is not a
 *   position inside the cap
 */
function normalizePlaylistIndices(indices) {
  // an empty selection is not an empty spec. `-I ""` is not "download nothing",
  // it is the absence of a selection - which downloads the entire playlist. so
  // "nothing was ticked" has to fail here rather than quietly become the
  // largest possible download
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error("A playlist download needs at least one selected item.")
  }

  const seen = new Set()

  for (const value of indices) {
    // a position is an integer and only an integer: coercing "3" or 3.5 into
    // one would launder a malformed payload into something the spec accepts
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`Not a playlist position: ${JSON.stringify(value)}`)
    }

    if (value < 1 || value > PLAYLIST_MAX_ITEMS) {
      throw new Error(`Playlist position out of range: ${value}`)
    }

    seen.add(value)
  }

  return [...seen].sort((a, b) => a - b)
}

/**
 * turn a selection into yt-dlp's -I syntax, compressing runs
 *
 * `[1,2,4,5,6,7,8,9]` becomes `"1,2,4:9"`. yt-dlp reads `a:b` as an inclusive
 * range, so a run of three or more is worth collapsing; a pair is left alone
 * because "4,5" is the same length as "4:5" and reads as what it is.
 *
 * @param {number[]} indices - the positions the user ticked
 * @returns {string} the -I spec
 * @throws {Error} for anything normalizePlaylistIndices rejects
 */
function buildPlaylistItemsSpec(indices) {
  const positions = normalizePlaylistIndices(indices)
  const parts = []

  let runStart = positions[0]
  let runEnd = positions[0]

  const flush = () => {
    if (runEnd - runStart >= 2) {
      parts.push(`${runStart}:${runEnd}`)
      return
    }

    for (let position = runStart; position <= runEnd; position += 1) {
      parts.push(String(position))
    }
  }

  for (const position of positions.slice(1)) {
    if (position === runEnd + 1) {
      runEnd = position
      continue
    }

    flush()
    runStart = position
    runEnd = position
  }

  flush()

  const spec = parts.join(",")

  // the loop above can only emit digits, commas and colons - this is what
  // keeps that true the next time somebody edits it
  if (!PLAYLIST_ITEMS_PATTERN.test(spec)) {
    throw new Error("Refusing to hand yt-dlp a malformed playlist selection.")
  }

  return spec
}

/**
 * the positions this run will download
 *
 * a caller may send bare positions or `[{index, id}]` entries. the ids are
 * what lets the engine work out how many items the archive will skip without
 * reading yt-dlp's English back off stdout, so entries are preferred - but
 * the selection itself is the indices either way
 *
 * @param {Object} params - {playlistIndices, playlistEntries}
 * @returns {number[]} the 1-based positions
 */
function playlistSelection({ playlistIndices, playlistEntries } = {}) {
  if (Array.isArray(playlistEntries) && playlistEntries.length > 0) {
    return playlistEntries.map((entry) => (entry ? entry.index : entry))
  }

  return playlistIndices
}

/**
 * where a run's save records live
 *
 * engine-owned state, beside the archives and well away from the user's
 * download folder: nothing but yt-dlp's own after_move hook may append here
 *
 * @param {Object} options - {userDataPath, operationId}
 * @returns {string|null} absolute path, or null without a userData path
 */
function buildPlaylistRecordsPath({ userDataPath, operationId } = {}) {
  if (!userDataPath) {
    return null
  }

  // the id reaches a filename, and an id is one of the few things a caller
  // hands us verbatim - so it is whitelisted rather than trusted
  const name = String(operationId || "").replace(/[^A-Za-z0-9._-]/g, "") || "run"

  return path.join(userDataPath, PLAYLIST_ARCHIVE_DIR, PLAYLIST_RECORDS_DIR, `${name}.records`)
}

/**
 * decide whether a recorded path really is a file in the download folder
 *
 * two questions: is it inside the folder we asked yt-dlp to write to, and is
 * it a file. *which run wrote it* is not one of them, and deliberately so -
 * the record file already answers that. it is created per run, cleared before
 * the spawn and deleted on settle, so a line in it was appended by this run's
 * after_move hook whatever the file's own age. measured: a re-run over files
 * that are already on disk fires after_move for each of them and leaves their
 * mtimes untouched, so an "is this newer than the run" test throws away every
 * item of a legitimate second download.
 *
 * containment goes through realpath on both sides. path.resolve collapses
 * ".." but does not follow links, while statSync does - so a symlink inside
 * the destination pointing out of it satisfied a resolve-and-stat pair while
 * naming a file somewhere else entirely. resolving the root too keeps a
 * download folder that is itself a symlink working, which plenty are.
 *
 * @param {string} filePath - the recorded path
 * @param {string} outputDir - the folder the run was given
 * @returns {string|null} the resolved path, or null when it proves nothing
 */
function verifySavedFile(filePath, outputDir) {
  if (!filePath || !outputDir) {
    return null
  }

  try {
    const root = fs.realpathSync(outputDir)
    const resolved = fs.realpathSync(filePath)

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return null
    }

    return fs.statSync(resolved).isFile() ? resolved : null
  } catch {
    // realpath throws for anything that is not there, which is its own answer
    return null
  }
}

/**
 * the ids a download archive already holds
 *
 * yt-dlp's archive key is the **pair** `<extractor> <id>`, and the pair is
 * what it skips on. keeping only the id made a `vimeo aaaaaaaaaaa` line vouch
 * for a youtube video that happens to share those eleven characters, so a run
 * that downloaded nothing at all reported an item as already had. these
 * operations are youtube-only and the shipped binary writes exactly
 * `youtube <id>` for them (measured on the archives our own captures left
 * behind), so nothing else is an archive record as far as this is concerned.
 *
 * a missing file is an empty set rather than an error: that is the first run
 *
 * @param {string|null} archiveFile - path to the archive, if there is one
 * @returns {Set<string>} the ids recorded in it for our own extractor
 */
function readArchivedIds(archiveFile) {
  const ids = new Set()

  if (!archiveFile) {
    return ids
  }

  let contents
  try {
    contents = fs.readFileSync(archiveFile, "utf8")
  } catch {
    return ids
  }

  for (const line of contents.split(/\r?\n/)) {
    // exactly two fields, and the first is ours. a line carrying anything
    // else is a record of something this selection cannot be talking about
    const parts = line.trim().split(/\s+/)

    if (parts.length === 2 && parts[0] === PLAYLIST_ARCHIVE_EXTRACTOR && parts[1]) {
      ids.add(parts[1])
    }
  }

  return ids
}

/**
 * which of the selected positions this archive will make yt-dlp skip
 *
 * counted per **position**, not per id: a playlist can hold one video three
 * times, and the denominator counts positions. no entries means the caller
 * sent positions without ids, so there is nothing to match on and the honest
 * answer is none - which undercounts rather than inventing reuse.
 *
 * the positions themselves, and not only how many there are, because an
 * archive-skipped video is never announced on stdout at all: without this the
 * ui has no way to tell those rows from the ones the run never reached, and
 * would settle a video the user already has as skipped.
 *
 * @param {Array|null} entries - [{index, id}] for the selected positions
 * @param {Set<string>} archivedIds - what the archive already holds
 * @returns {number[]} the positions already recorded, in the order given
 */
function archivedSelectionIndices(entries, archivedIds) {
  if (!Array.isArray(entries) || archivedIds.size === 0) {
    return []
  }

  return entries
    .filter((entry) => entry && archivedIds.has(entry.id))
    .map((entry) => entry.index)
}

/**
 * how many of the selected positions this archive will make yt-dlp skip
 *
 * @param {Array|null} entries - [{index, id}] for the selected positions
 * @param {Set<string>} archivedIds - what the archive already holds
 * @returns {number} how many selected positions are already recorded
 */
function countArchivedSelections(entries, archivedIds) {
  return archivedSelectionIndices(entries, archivedIds).length
}

/**
 * how many items a playlist run is about to walk
 *
 * **the denominator, for the bar and for every count the run reports.** it is
 * the selection the user made, and nothing yt-dlp prints revises it: an item
 * that left the playlist between the listing and the download is one of the
 * skipped rather than a reason to shrink the job to fit.
 *
 * @param {string} operation - the operation about to run
 * @param {Object} params - operation parameters
 * @returns {number|null} the selection size, or null for a non-playlist run
 */
function expectedItemCount(operation, params = {}) {
  if (operation !== "playlist-combined" && operation !== "playlist-audio") {
    return null
  }

  try {
    return normalizePlaylistIndices(playlistSelection(params)).length
  } catch {
    // a selection this malformed never reaches a spawn: buildArgs throws on it
    // first. answering null here keeps the two from racing to report it
    return null
  }
}

module.exports = {
  normalizePlaylistIndices,
  buildPlaylistItemsSpec,
  playlistSelection,
  buildPlaylistRecordsPath,
  verifySavedFile,
  readArchivedIds,
  archivedSelectionIndices,
  countArchivedSelections,
  expectedItemCount
}
