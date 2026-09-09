import type { PlaylistEntry } from "@/lib/api"

/**
 * what one saved playlist file says about itself
 *
 * `index` is the video's true position in the playlist and `id` is its video
 * id: the output template writes both, and a row is only certified by a file
 * that agrees with it on both. `height` is null for a file that carries none -
 * an audio download, whose template has no height in it, or a merge yt-dlp
 * could not report a height for and rendered as `NA`. that is a row saved at a
 * height we do not know, which is a different thing from a row not saved.
 */
export interface DeliveredFile {
  index: number
  id: string
  height: number | null
}

// the whole shape the playlist output template writes, which is
// `%(playlist_index)03d - %(title).80B [%(id)s] %(height)sp.%(ext)s` for a
// video and the same without the height for audio:
//
//   the leading position, zero padded to the cap's digit width...
const POSITION = /^(\d+)\s+-\s+/
//   ...and the id as the last bracketed group, because the template puts it
//   after the title, so a title's own brackets are never the last ones
const NAMED = /\[([^[\]]+)\]([^[\]]*)$/
//   ...and the height in whatever was appended after that, which is
//   ` 1080p.mp4` for a video and `.mp3` for audio
const HEIGHT = /(?:^|\s)(\d{2,5})p\.[^.]*$/

// yt-dlp's in-progress and bookkeeping suffixes. the engine only reports
// verified after_move records, so one of these should never reach here - but
// a half-written file is the one thing that must never be read as a save
const UNFINISHED = /\.(part|ytdl|temp)$/i

/**
 * read the position, id and delivered height out of one saved file's name
 *
 * a playlist is downloaded under a ceiling, not at a height: `-S res:1080`
 * gives 1080p for one video and 720p for the next, and no event in the run
 * reports which. the filename is the only place the answer exists, which is
 * why the template was made to carry it.
 *
 * @param filePath - an absolute path, in either separator
 * @returns what the file certifies, or null for a name we did not write
 */
export function parseDeliveredFile(filePath: string): DeliveredFile | null {
  if (!filePath) return null

  const name = filePath.split(/[\\/]/).pop() || ""

  if (UNFINISHED.test(name)) return null

  const position = POSITION.exec(name)
  const named = NAMED.exec(name)

  if (!position || !named) return null

  const height = HEIGHT.exec(named[2])

  return {
    index: Number(position[1]),
    id: named[1],
    height: height ? Number(height[1]) : null
  }
}

/**
 * the rows a finished run put on disk, keyed by playlist position
 *
 * the join is on the position **and** the id, because a playlist can hold one
 * video at two positions and the template writes a separate file for each. one
 * file therefore certifies exactly one row: matching on the id alone would
 * mark the position whose own file never landed as saved, which overstates the
 * run and hides that row from the retry the summary offers.
 *
 * a present key means the row was saved; its value is the height, or null when
 * the name carried none.
 *
 * @param files - the terminal event's `files`
 * @param entries - the listing on screen
 */
export function deliveredByIndex(
  files: string[] | undefined,
  entries: PlaylistEntry[] | undefined
): Map<number, number | null> {
  const delivered = new Map<number, number | null>()

  if (!files || files.length === 0 || !entries || entries.length === 0) {
    return delivered
  }

  const byIndex = new Map<number, DeliveredFile>()

  for (const file of files) {
    const parsed = parseDeliveredFile(file)
    if (parsed) byIndex.set(parsed.index, parsed)
  }

  for (const entry of entries) {
    const file = byIndex.get(entry.index)

    if (file && entry.id && file.id === entry.id) {
      delivered.set(entry.index, file.height)
    }
  }

  return delivered
}
