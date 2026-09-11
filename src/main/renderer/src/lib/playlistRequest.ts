// building a playlist download request, and saying what a run made of it

import type {
  AudioMode,
  DownloadProgress,
  PlaylistDownloadRequest,
  PlaylistInfoResponse
} from "@/lib/api"
import { localizeError, t } from "@/lib/i18n"
import { isSelectableEntry, type PlaylistTab } from "@/lib/playlistStore"
import { ensureHttpScheme } from "@/lib/validation"

export interface PlaylistDownloadOptions {
  // "download everything again", for a user who deleted the files the archive
  // still remembers. only a literal true reaches main
  ignoreArchive?: boolean
}

/**
 * the start was refused before anything ran
 *
 * not a download failure: nothing was started, nothing broke, and there is
 * nothing for an issue report to say. these are told to the user and dropped.
 */
export class PlaylistStartRefused extends Error {}

/** the request cannot be built from what the user has picked */
export class PlaylistSelectionError extends PlaylistStartRefused {
  constructor(message: string) {
    super(message)
    this.name = "PlaylistSelectionError"
  }
}

/** one playlist job at a time from this screen: see the admission guard */
export class PlaylistBusyError extends PlaylistStartRefused {
  constructor(message: string) {
    super(message)
    this.name = "PlaylistBusyError"
  }
}

export interface PlaylistSelection {
  url: string
  playlistInfo: PlaylistInfoResponse | null
  selectedIndices: Set<number>
  selectedCeiling: number
  selectedAudioMode: AudioMode
  activeTab: PlaylistTab
}

/**
 * the ticked positions, joined against the listing that is on screen
 *
 * the store keeps positions and the request needs `{index, id}` pairs: main
 * derives yt-dlp's selection from the indices and works out what the resume
 * archive already holds from the ids, so both halves have to travel. the join
 * happens here rather than in the store so there is one copy of the listing and
 * a selection can never describe a playlist that is no longer loaded.
 *
 * @throws {PlaylistSelectionError} with the sentence the user is shown
 */
export function buildPlaylistDownloadRequest(
  selection: PlaylistSelection,
  options: PlaylistDownloadOptions = {}
): PlaylistDownloadRequest {
  const { playlistInfo } = selection

  if (!playlistInfo) {
    throw new PlaylistSelectionError(t("playlist.errorNoPlaylist"))
  }

  // required rather than defaulted: it names the archive this run resumes from,
  // and main refuses a request without one
  if (!playlistInfo.playlist_id) {
    throw new PlaylistSelectionError(t("playlist.errorNoId"))
  }

  const entries = playlistInfo.entries
    .filter(
      (entry) =>
        selection.selectedIndices.has(entry.index) && isSelectableEntry(entry)
    )
    .sort((a, b) => a.index - b.index)
    .map((entry) => ({ index: entry.index, id: entry.id as string }))

  // an empty selection is not an empty spec: yt-dlp reads the absence of one as
  // "the whole playlist", which is the largest download available
  if (entries.length === 0) {
    throw new PlaylistSelectionError(t("playlist.errorNoSelection"))
  }

  const audioOnly = selection.activeTab === "audio"

  return {
    // main refuses a link with no scheme, as the engine always has
    url: ensureHttpScheme(selection.url),
    playlist_id: playlistInfo.playlist_id,
    entries,
    title: playlistInfo.title,
    ...(audioOnly
      ? { type: "audio" as const, audio_mode: selection.selectedAudioMode }
      : { type: "video" as const, height: selection.selectedCeiling }),
    ...(options.ignoreArchive === true ? { ignore_archive: true } : {})
  }
}

export interface PlaylistItemCounts {
  saved?: number
  reused?: number
  skipped?: number
  total?: number
}

/**
 * what the run did, as one sentence
 *
 * the partial case is the one that has to be honest: a run that saved eight of
 * nine is a success, and saying so without saying what happened to the ninth is
 * how "Download completed" ends up in front of somebody missing a video. an
 * archive reuse is reported as itself and never added into the saves, because
 * the file it refers to was written by an earlier run.
 *
 * no em-dashes: Cliply's own copy uses commas and periods.
 *
 * each clause is translated whole, and only the comma between them is shared:
 * russian puts the verb first in all three, so a sentence assembled from a
 * number and a translated word would come out in english order.
 */
export function summarizePlaylistItems(
  counts: PlaylistItemCounts
): string | undefined {
  const { saved, total } = counts

  /**
   * both numbers, or no sentence at all.
   *
   * the denominator is known from the moment the run starts, and only a
   * terminal event carries what was saved. defaulting the missing half to zero
   * put "0 of 3 videos saved" in front of a user the instant they pressed
   * Cancel, before the run had said a word about what it had written.
   */
  if (typeof total !== "number" || typeof saved !== "number") {
    return undefined
  }

  const parts = [t("playlist.summarySaved", { saved, n: total })]

  if (counts.reused) {
    parts.push(t("playlist.summaryReused", { n: counts.reused }))
  }

  if (counts.skipped) {
    parts.push(t("playlist.summarySkipped", { n: counts.skipped }))
  }

  return `${parts.join(", ")}.`
}

/**
 * what a failed run says under its title, in the reader's language
 *
 * main's own wording, which is english by design - it is what the logs, the
 * analytics and the issue bodies carry - swapped for the russian one where the
 * category names it, exactly as the single-video hooks do. a failure that
 * arrived with no sentence at all gets ours.
 *
 * the suggestion is only ever shown when main sent one: `localizeError` swaps
 * the pair, and printing its advice under an error that had none would be
 * putting words in main's mouth.
 *
 * **the wording code wins over the category.** a run that cannot write its
 * record of the download fails as a PERMISSION_ERROR, the same category as a
 * download folder we cannot write to, and the category's russian advice is
 * "pick another download folder" - which cannot fix a folder inside Cliply's
 * own app data. main names that refusal `RECORDS_UNWRITABLE`, and translating
 * the name rather than the category is what keeps the diagnosis it made.
 *
 * exported because the summary card says the same thing about the same
 * failure, and the two reading from one function is what keeps them agreeing.
 */
export function failureSentence(data: {
  error?: string
  suggestion?: string
  category?: string
  wordingCode?: string
}): string {
  if (!data.error) return t("download.wentWrong")

  const shown = localizeError({
    message: data.error,
    suggestion: data.suggestion,
    category: data.wordingCode ?? data.category
  })

  return [shown.message, data.suggestion && shown.suggestion]
    .filter(Boolean)
    .join(" ")
}

export const countsOf = (data: DownloadProgress): PlaylistItemCounts => ({
  saved: data.items_saved,
  reused: data.items_reused,
  skipped: data.items_skipped,
  total: data.items_total
})
