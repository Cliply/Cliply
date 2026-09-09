import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import { t, useLocale } from "@/lib/i18n"
import type { PlaylistItemStatus } from "@/lib/playlistStore"

/**
 * the sentences and rules the playlist screens are drawn from
 *
 * kept out of the components so each one can be checked as what it is: the
 * rule that decides which copy a user sees, and the shape the copy is built
 * into. nothing here renders anything.
 *
 * the words themselves live in `en.ts` and `ru.ts`; this module reads them
 * through `t`, the way `toast-utils` does, because none of it is a component.
 * which means every one of these is called during a render, and the component
 * that calls it uses `useT` so the locale toggle reaches it.
 */

// =============================================================================
// the link the hint hands out
// =============================================================================

/**
 * a real playlist, for somebody who has never pasted one
 *
 * the helper line under the box can say playlists work, and saying so still
 * leaves the reader to go and find a playlist link before they can see it. this
 * is that link, one click away: TED-Ed's "Top 10 most popular animations of the
 * year", ten videos of about five minutes.
 *
 * small and famous on purpose. a channel-sized list would demonstrate the
 * hundred-row cap rather than the feature, and a stranger's private-ish
 * playlist is one deletion away from a new user's first try being an error.
 * this one was public and listing without cookies on 2026-09-09.
 *
 * swapping it is a release rather than a config change: it is baked into the
 * build, so a link that dies stays dead in every copy already installed until
 * the next one ships.
 */
export const DEMO_PLAYLIST_URL =
  "https://www.youtube.com/playlist?list=PLJicmE8fK0EhjQU9p9XUcJslo_hs5oBKk"

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
  /** the limit on its own: a height, and the same one in every language */
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
  { height: 2160, limit: "4K" },
  { height: 1440, limit: "1440p" },
  { height: 1080, limit: "1080p" },
  { height: 720, limit: "720p" },
  { height: 480, limit: "480p" },
  { height: 360, limit: "360p" }
]

export const ceilingFor = (height: number): PlaylistCeiling | null =>
  PLAYLIST_CEILINGS.find((option) => option.height === height) || null

/**
 * one row of the menu, and the same words in the line under it
 *
 * built rather than stored, because the rows are made once at module load and
 * the locale can change after that
 */
export const ceilingLabel = (limit: string) =>
  t("playlist.ceilingLabel", { limit })

/**
 * one line under the picker, saying what a run does
 *
 * "up to N" rather than "never above N", because `-S res:N` is a preference
 * rather than a hard ceiling: it takes the largest stream at or below N, and
 * the smallest one there is when the video has nothing that small. nothing is
 * ever skipped for lacking the height, which is the property that matters, and
 * the filename carries the height each video really came down at for anyone
 * who goes looking.
 */
export const ceilingHelperText = (limit: string) =>
  t("playlist.ceilingHelper", { limit })

/**
 * the same line for the audio tab
 *
 * "whole" is the trim answer and "the format picked above" is the one-format
 * answer, both said as what happens rather than as controls that are missing.
 */
export const playlistAudioNote = () => t("playlist.audioNote")

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
 * only the rows the run was asked for get a badge at all. a row nobody ticked
 * is not in the run and never was, so it keeps its duration the way it does
 * while picking: eight untouched rows reading "not saved" under a two-video
 * run is eight failures that never happened.
 *
 * a *selected* row the run never reached reads as queued while the run is
 * going and as "not saved" once it has ended, because after the end there is
 * nothing left for it to be waiting for.
 */
export function rowBadge(
  entry: PlaylistEntry,
  phase: PlaylistPhase,
  selected: boolean,
  status?: PlaylistItemStatus
): PlaylistRowBadge | null {
  if (entry.unavailable) {
    return { text: t("playlist.rowUnavailable"), tone: "gone" }
  }

  if (phase === "picking" || !selected) return null

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
        ? { text: t("playlist.rowStopping"), tone: "neutral" }
        : { text: `${Math.round(status.progress)}%`, tone: "running" }
    case "saved":
      return {
        text: status.height
          ? t("playlist.rowSavedAt", { height: status.height })
          : t("playlist.rowSaved"),
        tone: "done"
      }
    case "reused":
      return { text: t("playlist.rowReused"), tone: "done" }
    case "skipped":
      return { text: t("playlist.rowNotSaved"), tone: "gone" }
    default:
      return phase === "running"
        ? { text: t("playlist.rowQueued"), tone: "neutral" }
        : { text: t("playlist.rowNotSaved"), tone: "gone" }
  }
}

/**
 * "3 done · 1 downloading", built from the badges themselves
 *
 * each half is a sentence of its own rather than a number with a word after
 * it: russian puts the verb first, and the middle dot between them is
 * punctuation both languages share
 */
export function summarizeBadges(
  itemStatus: Map<number, PlaylistItemStatus>
): string {
  let done = 0
  let running = 0

  for (const status of itemStatus.values()) {
    if (status.state === "saved" || status.state === "reused") done += 1
    if (status.state === "downloading") running += 1
  }

  const parts = [t("playlist.badgeDone", { n: done })]
  if (running) parts.push(t("playlist.badgeDownloading", { n: running }))

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
    ? t("playlist.totalHours", {
        hours,
        minutes: String(minutes).padStart(2, "0")
      })
    : t("playlist.totalMinutes", { minutes })
}

/**
 * a thousands separator the reader's language uses, not the machine's
 *
 * bare `toLocaleString()` follows the host locale, so a russian app on an
 * english machine printed "5,283" in the middle of a russian sentence. the
 * language the sentence is in is the one that decides how its numbers look.
 */
const groupDigits = (value: number): string =>
  value.toLocaleString(useLocale.getState().locale)

/**
 * how many videos this is, and how many there really are
 *
 * a link can hold five thousand videos and we list the first hundred of them.
 * saying "100 videos" over that is the kind of small lie somebody finds out
 * about later, so a truncated listing says so in the same breath.
 */
export function countLine(info: PlaylistInfoResponse): string {
  if (info.truncated && typeof info.count === "number") {
    return t("playlist.showingFirst", {
      listed: groupDigits(info.listed),
      count: groupDigits(info.count)
    })
  }

  // no `toLocaleString` on this one: the listing is capped at a hundred rows,
  // so there is never a separator to place, and the number has to reach the
  // plural rule as a number
  return t("playlist.videoCount", { n: info.listed })
}

// =============================================================================
// the ambiguous link
// =============================================================================

/**
 * the playlist half of what a `watch?v=…&list=…` link could mean
 *
 * the video half is a fixed sentence and sits in the dictionary with the rest
 * of the prompt, because it is one video however big the playlist is. this
 * half has to carry the number: "All videos in the playlist" is not something
 * anybody can decide about, which is the only reason the listing is fetched
 * before the question rather than after it.
 *
 * a truncated listing says "the first 100" rather than "all 100". we list a
 * hundred rows out of a link that may hold five thousand, and "all" over that
 * is a promise the download will not keep.
 */
export function mixedLinkPlaylistChoice(info: PlaylistInfoResponse): string {
  if (info.truncated) {
    return t("mixedLink.playlistFirst", { n: info.listed })
  }

  return t("mixedLink.playlistChoice", { n: info.listed })
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

/**
 * `"One", "Two" and 3 more`
 *
 * the quotes are a dictionary value too: russian quotes with «» rather than
 * with ", and the word before the last name is not "and" there either
 */
export function nameList(entries: PlaylistEntry[]): string {
  const shown = entries
    .slice(0, NAMES_SHOWN)
    .map((entry) => t("playlist.quotedName", { title: entry.title }))
  const rest = entries.length - shown.length

  if (rest > 0) {
    shown.push(t("playlist.andMore", { n: rest }))
  }

  if (shown.length === 1) return shown[0]

  return t("playlist.listJoin", {
    items: shown.slice(0, -1).join(", "),
    last: shown[shown.length - 1]
  })
}
