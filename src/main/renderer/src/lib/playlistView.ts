import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import type { PlaylistItemStatus } from "@/lib/playlistStore"

/**
 * the sentences and rules the playlist screens are drawn from
 *
 * kept out of the components so each one can be checked as what it is: the
 * copy a user reads and the rule that decides which of it they see. nothing
 * here renders anything.
 */

// =============================================================================
// which of the three screens
// =============================================================================

/** where the list is in the run, which is what a badge means by "queued" */
export type PlaylistPhase = "picking" | "running" | "finished"

/**
 * `starting` counts as running: the job is the user's from the moment they
 * press the button, and leaving the checkboxes live for the second before the
 * engine answers invites a change the run will not honour.
 */
export function phaseOf(status: string): PlaylistPhase {
  if (status === "starting" || status === "downloading") return "running"
  if (status === "idle") return "picking"

  return "finished"
}

// =============================================================================
// the quality ceiling
// =============================================================================

export interface PlaylistCeiling {
  height: number
  label: string
  /** the limit on its own, for a sentence that already says "up to" */
  limit: string
}

/**
 * the six rows, and why there are exactly six of them
 *
 * the single-video menu is **derived** from that video's own format list, so
 * it can show real heights at real sizes. a playlist listing is flat and
 * carries no formats at all, so there is nothing to derive from: probing the
 * first video would only promise the rest of the playlist whatever that one
 * happened to offer.
 *
 * so this is a ceiling instead, which is what `-S res:N` actually is. no
 * sizes, no fps, no per-video rows: the same six entries for every playlist,
 * rendered with no extra request.
 */
export const PLAYLIST_CEILINGS: PlaylistCeiling[] = [
  { height: 2160, label: "Up to 4K", limit: "4K" },
  { height: 1440, label: "Up to 1440p", limit: "1440p" },
  { height: 1080, label: "Up to 1080p", limit: "1080p" },
  { height: 720, label: "Up to 720p", limit: "720p" },
  { height: 480, label: "Up to 480p", limit: "480p" },
  { height: 360, label: "Up to 360p", limit: "360p" }
]

export const ceilingFor = (height: number): PlaylistCeiling | null =>
  PLAYLIST_CEILINGS.find((option) => option.height === height) || null

/**
 * what "up to N" really promises, and what it does not
 *
 * `-S res:N` is a preference rather than a hard ceiling: it takes the largest
 * stream at or below N, and the smallest one there is when the video has
 * nothing that small. nothing is ever skipped for lacking the height, which is
 * the property that matters, but "never above N" would be a promise it does
 * not keep. so the copy says what happens instead, and points at the filename,
 * which carries the height each video really came down at.
 */
export const ceilingHelperText = (limit: string) =>
  `Each video is saved at its best quality, up to ${limit}. A video with nothing that small is saved at its smallest. The filename shows the height each one really came down at.`

/**
 * three controls a playlist does not get, each said out loud
 *
 * a control that is simply missing reads as a bug, or as something the user
 * failed to find. these are not omissions, they are consequences of what a
 * playlist is, so each one says which.
 */
export const PLAYLIST_ABSENT = {
  trim: "No trimming. One time range cannot describe videos of different lengths, so the whole of each video is saved.",
  dub: "No language picker. The dubs on offer differ from video to video, so each one is saved with its own original audio.",
  container: "Every video is saved as MP4, whatever height it comes down at."
}

// =============================================================================
// one row's badge
// =============================================================================

export interface PlaylistRowBadge {
  text: string
  tone: "neutral" | "running" | "done" | "gone"
}

/**
 * what this row is doing, said in one word
 *
 * "already downloaded" is its own badge rather than a kind of save: the
 * archive records that a download once succeeded, not that a file is on disk
 * now, and calling it saved would claim a file this run did not write.
 *
 * a row the run never reached reads as queued while the run is going and as
 * "not saved" once it has ended, because after the end there is nothing left
 * for it to be waiting for.
 */
export function rowBadge(
  entry: PlaylistEntry,
  phase: PlaylistPhase,
  status?: PlaylistItemStatus
): PlaylistRowBadge | null {
  if (entry.unavailable) {
    return { text: "unavailable", tone: "gone" }
  }

  if (phase === "picking") return null

  switch (status?.state) {
    case "downloading":
      /**
       * a row still in flight after the run has ended is the window between
       * main accepting a Cancel and the run reporting how it ended. every
       * other ending settles its in-flight rows on the terminal event, so this
       * is only ever a video being stopped, and a frozen percentage would
       * read as one still going.
       */
      return phase === "finished"
        ? { text: "stopping", tone: "neutral" }
        : { text: `${Math.round(status.progress)}%`, tone: "running" }
    case "saved":
      return {
        text: status.height ? `saved · ${status.height}p` : "saved",
        tone: "done"
      }
    case "reused":
      return { text: "already downloaded", tone: "done" }
    case "skipped":
      return { text: "not saved", tone: "gone" }
    default:
      return phase === "running"
        ? { text: "queued", tone: "neutral" }
        : { text: "not saved", tone: "gone" }
  }
}

/** "3 done · 1 downloading", built from the badges themselves */
export function summarizeBadges(
  itemStatus: Map<number, PlaylistItemStatus>
): string {
  let done = 0
  let running = 0

  for (const status of itemStatus.values()) {
    if (status.state === "saved" || status.state === "reused") done += 1
    if (status.state === "downloading") running += 1
  }

  const parts = [`${done} done`]
  if (running) parts.push(`${running} downloading`)

  return parts.join(" · ")
}

// =============================================================================
// the header
// =============================================================================

/**
 * the total length of what is on screen
 *
 * only when every listed row reported one. a playlist with a live stream or a
 * deleted video in it has rows with no duration at all, and adding up the rest
 * would print a total that is quietly short of the truth.
 */
export function totalDuration(
  entries: { duration: number | null }[]
): string | null {
  if (entries.length === 0 || entries.some((entry) => entry.duration === null)) {
    return null
  }

  const seconds = entries.reduce((sum, entry) => sum + (entry.duration ?? 0), 0)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)

  return hours > 0
    ? `${hours} h ${String(minutes).padStart(2, "0")} m total`
    : `${minutes} m total`
}

/**
 * how many videos this is, and how many there really are
 *
 * a link can hold five thousand videos and we list the first hundred of them.
 * saying "100 videos" over that is the kind of small lie somebody finds out
 * about later, so a truncated listing says so in the same breath.
 */
export function countLine(info: PlaylistInfoResponse): string {
  if (info.truncated && typeof info.count === "number") {
    return `Showing the first ${info.listed.toLocaleString()} of ${info.count.toLocaleString()} videos`
  }

  return `${info.listed.toLocaleString()} ${info.listed === 1 ? "video" : "videos"}`
}

// =============================================================================
// the finish
// =============================================================================

// three is enough to recognise which videos are meant without turning the card
// into a second copy of the list, which is right there on the left
const NAMES_SHOWN = 3

/**
 * the rows the run did not save, named
 *
 * "1 skipped" on its own leaves the user to diff a folder against a playlist.
 * the selection is what the run was asked for, so anything in it that did not
 * end as saved or already-downloaded is what went missing.
 */
export function unsavedEntries(
  entries: PlaylistEntry[],
  selectedIndices: Set<number>,
  itemStatus: Map<number, PlaylistItemStatus>
): PlaylistEntry[] {
  return entries.filter((entry) => {
    if (!selectedIndices.has(entry.index)) return false

    const state = itemStatus.get(entry.index)?.state

    return state !== "saved" && state !== "reused"
  })
}

/** `"One", "Two" and 3 more` */
export function nameList(entries: PlaylistEntry[]): string {
  const shown = entries.slice(0, NAMES_SHOWN).map((entry) => `"${entry.title}"`)
  const rest = entries.length - shown.length

  if (rest > 0) {
    shown.push(`${rest} more`)
  }

  if (shown.length === 1) return shown[0]

  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
}
