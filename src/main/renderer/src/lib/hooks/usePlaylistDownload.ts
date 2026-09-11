import { audioQuality, track, videoQuality } from "@/lib/analytics"
import {
  DownloadError,
  downloadApi,
  playlistApi,
  systemApi,
  type AudioMode,
  type DownloadProgress,
  type PlaylistDownloadRequest,
  type PlaylistInfoResponse
} from "@/lib/api"
import { isTerminalReason, terminalReason } from "@/lib/downloadOutcome"
import { localizeError, t } from "@/lib/i18n"
import { deliveredByIndex } from "@/lib/playlistFiles"
import {
  isSelectableEntry,
  usePlaylistStore,
  type PlaylistTab
} from "@/lib/playlistStore"
import { reportActions } from "@/lib/reportStore"
import { showDownloadErrorToast } from "@/lib/toast-utils"
import { ensureHttpScheme } from "@/lib/validation"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

export interface PlaylistDownloadState {
  downloadId?: string
  status:
    | "idle"
    | "starting"
    | "downloading"
    | "completed"
    | "failed"
    | "cancelled"
  // the whole run's bar, 0-100
  progress: number
  speed?: string
  eta?: string
  message?: string
  error?: string
  // a failure that carries its own advice rather than the generic retry prompt
  suggestion?: string
  // the taxonomy name main gave the failure. kept because it is what decides
  // whether the two sentences above have a russian version to be read in
  category?: string
  // ...and the name of the specific wording, when main knew one. see
  // `failureSentence` for why the category alone is not enough
  wordingCode?: string

  // the second level: where inside the run we are. `itemIndex` is the queue
  // position and `playlistIndex` the video's true position in the playlist,
  // which differ for any selection with a gap in it
  itemProgress?: number
  itemIndex?: number
  itemsCompleted?: number
  itemsTotal?: number
  playlistIndex?: number | null
  videoId?: string | null

  // what the finished run did. `itemsReused` is the archive's doing and is
  // never a save this run made, so it stays its own number
  files?: string[]
  itemsSaved?: number
  itemsReused?: number
  itemsSkipped?: number
}

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

const countsOf = (data: DownloadProgress): PlaylistItemCounts => ({
  saved: data.items_saved,
  reused: data.items_reused,
  skipped: data.items_skipped,
  total: data.items_total
})

/**
 * follow a playlist download to its terminal state
 *
 * built on the same contract as `useVideoDownload`, which is where the hard
 * parts already live: the renderer mints the `download_id` before the ipc call
 * so the listener can filter from the moment it subscribes, a terminal event
 * settles the mutation, and an unmount stops listening but deliberately does
 * **not** cancel the engine download.
 *
 * what a playlist adds is the second level. a progress event names one row by
 * its playlist position, and that row's badge is written into the playlist
 * store as the run walks the selection.
 */
export const usePlaylistDownload = () => {
  const [downloadState, setDownloadState] = useState<PlaylistDownloadState>({
    status: "idle",
    progress: 0
  })

  const progressCleanupRef = useRef<(() => void) | null>(null)
  const lastUrlRef = useRef<string | undefined>(undefined)
  const lastTypeRef = useRef<"video" | "audio">("video")
  const settleRef = useRef<{
    resolve: (value: { downloadId: string }) => void
    reject: (error: Error) => void
  } | null>(null)

  /**
   * whether a run owns this hook right now.
   *
   * raised synchronously, before the first await, because that is what makes it
   * a guard: the settlement and cleanup refs above are per-hook, and two
   * overlapping runs sharing them cross-settle - the first run's completion
   * resolves the second one's promise, and the second one's cleanup drops the
   * first one's listener and leaves it pending forever.
   */
  const runningRef = useRef(false)
  // the id of the run in flight, readable without waiting for a re-render
  const downloadIdRef = useRef<string | null>(null)
  // whether main has acknowledged the start, which is when the id is reserved
  const ackedRef = useRef(false)
  // a cancel main was not yet in a position to take, to be asked again
  const cancelIntentRef = useRef(false)
  // whether this run already reached a terminal state, whatever it was
  const outcomeSettledRef = useRef(false)

  /**
   * which view the hook is answering to, and which one a run belongs to.
   *
   * `reset` detaches this screen from whatever it was following - a different
   * playlist has been loaded over it, and the run it was watching is left to
   * the engine. but a mutation already in flight keeps its own callbacks: an
   * ipc start that rejects a moment later still runs `onError`, and that wrote
   * the abandoned run's failure over the playlist now on screen.
   *
   * so the generation counts resets, a run records the one it started under,
   * and every asynchronous write checks the two still agree. the alternative,
   * one hook instance per playlist, would need the layout to remount it, which
   * would also throw away a run the user can still see.
   */
  const generationRef = useRef(0)
  const runGenerationRef = useRef(0)
  const isCurrentRun = () => runGenerationRef.current === generationRef.current

  // on unmount we stop listening but the engine keeps downloading, which is
  // what people expect when a view is swapped out. the pending mutation is
  // settled so nothing awaits forever
  useEffect(() => {
    return () => {
      settleRef.current?.reject(
        terminalReason("abandoned", "Download view closed")
      )
      settleRef.current = null
      cancelIntentRef.current = false

      if (progressCleanupRef.current) {
        progressCleanupRef.current()
        progressCleanupRef.current = null
      }
    }
  }, [])

  /**
   * ask main to stop the run, and show it if the ask took
   *
   * **the acknowledgement is not the outcome.** all a `true` here means is that
   * main found the id and asked the process to stop; the run's own terminal
   * event follows, and it is the only thing carrying what was saved, what the
   * archive had already accounted for and the heights each file came down at.
   * settling the mutation here would drop the progress listener in the
   * mutation's `finally` before any of that arrived, leaving a video the user
   * already has drawn as "not saved" and the summary with nothing to count.
   *
   * so this moves the screen to cancelled for the user, who asked for it and
   * should see it immediately, and leaves the bookkeeping to the terminal
   * handler. the rows in flight are settled there too, for the same reason.
   *
   * @returns whether main had something to cancel
   */
  const requestCancel = async (downloadId: string): Promise<boolean> => {
    const cancelled = await downloadApi.cancelDownload(downloadId)

    if (!cancelled) return false

    // no more cancels against this run, and no queued intent to issue: it is
    // stopping. the mutation stays open until the run says how it ended
    outcomeSettledRef.current = true

    setDownloadState((prev) => ({
      ...prev,
      status: "cancelled",
      message: t("playlist.cancelled")
    }))

    toast.info(t("playlist.cancelled"), {
      description: t("playlist.cancelledToast")
    })

    return true
  }

  const mutation = useMutation({
    mutationFn: async (options: PlaylistDownloadOptions = {}) => {
      // the admission guard, and it has to be the first thing here: everything
      // from this line to the start ipc below runs without yielding, so a
      // second call cannot slip past it into the shared refs
      if (runningRef.current) {
        throw new PlaylistBusyError(t("playlist.errorBusy"))
      }

      // throws before anything is started or subscribed to, so a selection that
      // cannot be sent costs nothing
      const request = buildPlaylistDownloadRequest(
        usePlaylistStore.getState(),
        options
      )

      runningRef.current = true
      ackedRef.current = false
      cancelIntentRef.current = false
      outcomeSettledRef.current = false
      // the view this run belongs to. everything below that lands after an
      // await checks it is still the one on screen
      runGenerationRef.current = generationRef.current

      lastUrlRef.current = request.url
      lastTypeRef.current = request.type === "audio" ? "audio" : "video"

      const store = usePlaylistStore.getState()
      store.setIsDownloading(true)
      // the badges of the previous run describe files that are already on disk
      store.clearItemStatus()

      setDownloadState({
        status: "starting",
        progress: 0,
        itemsTotal: request.entries.length,
        message: t("playlist.starting")
      })

      // correlate on an id we generate here, so the listener can filter from
      // the moment it subscribes
      const downloadId = crypto.randomUUID()
      downloadIdRef.current = downloadId
      setDownloadState((prev) => ({ ...prev, downloadId }))

      const finished = new Promise<{ downloadId: string }>(
        (resolve, reject) => {
          settleRef.current = { resolve, reject }
        }
      )

      // nothing awaits this until the start ipc below resolves, so an unmount
      // in that window would reject a promise with no handler attached
      finished.catch(() => {})

      const cleanup = downloadApi.onProgress((data: DownloadProgress) => {
        if (data.downloadId !== downloadId) return

        // `reset` already unsubscribed this listener, so reaching here would
        // take an event delivered in the same batch as the reset. it is still
        // this run's event and this screen is no longer following this run
        if (!isCurrentRun()) return

        setDownloadState((prev) => ({
          ...prev,
          downloadId,
          status: data.status as PlaylistDownloadState["status"],
          // a terminal failure and a cancel both report 0, and a run that got
          // six videos in did not un-download them: the bar keeps what it read
          progress: data.progress || prev.progress,
          speed: data.speed,
          eta: data.eta,
          itemProgress: data.item_progress ?? prev.itemProgress,
          itemIndex: data.item_index ?? prev.itemIndex,
          itemsCompleted: data.items_completed ?? prev.itemsCompleted,
          itemsTotal: data.items_total ?? prev.itemsTotal,
          playlistIndex: data.playlist_index ?? prev.playlistIndex,
          videoId: data.video_id ?? prev.videoId,
          files: data.files ?? prev.files,
          itemsSaved: data.items_saved ?? prev.itemsSaved,
          itemsReused: data.items_reused ?? prev.itemsReused,
          itemsSkipped: data.items_skipped ?? prev.itemsSkipped,
          message: data.error || undefined,
          error: data.error,
          suggestion: data.suggestion,
          category: data.category,
          wordingCode: data.wordingCode
        }))

        if (data.status === "downloading") {
          applyItemStatus(data)
          return
        }

        // whatever else happens now, this run reached an end of its own: a
        // cancel still waiting on the start ack must not be issued against it
        outcomeSettledRef.current = true

        // the two things only the end of a run knows: which rows the archive
        // had already accounted for, and the height each saved file really
        // came down at. both are read before the settle below, so a row a file
        // vouches for is never settled as skipped
        applyRunOutcome(data)

        // ...and a terminal event never names the row that was in flight, so
        // whatever is still running when it arrives is settled here
        usePlaylistStore
          .getState()
          .settleInFlightItems(
            data.status === "cancelled" ? "pending" : "skipped"
          )

        if (data.status === "completed") {
          toast.success(t("playlist.completed"), {
            description: summarizePlaylistItems(countsOf(data)),
            action: {
              label: t("toast.openFolder"),
              onClick: () => systemApi.openDownloadFolder()
            }
          })

          settleRef.current?.resolve({ downloadId })
        }

        if (data.status === "failed") {
          reportActions.stage({
            // english on purpose, like every other line of a report: the
            // maintainer reading the issue is not the user who filed it
            shortMessage: data.error || "Playlist download failed",
            details: data.details,
            category: data.category,
            platform: "youtube",
            downloadType: lastTypeRef.current,
            videoUrl: lastUrlRef.current
          })

          // the suggestion travels with the failure that carried it: a run that
          // could not write its own record is not fixed by trying again.
          // the category and the platform go with it too, because they are
          // what decides which action the toast offers: a youtube refusal gets
          // "fix with cookies", everything else gets "report"
          showDownloadErrorToast(
            t("playlist.failed"),
            failureSentence(data),
            data.category,
            "youtube"
          )

          // already surfaced here; onError must not report it twice
          settleRef.current?.reject(
            terminalReason("failed", data.error || "Playlist download failed")
          )
        }

        // not a failure, and nobody should report it
        if (data.status === "cancelled") {
          settleRef.current?.reject(
            terminalReason("cancelled", "Playlist download cancelled")
          )
        }
      })

      progressCleanupRef.current = cleanup

      /**
       * one download of n videos, reported as the event a single video already
       * sends.
       *
       * the same properties mean the same things, so the two funnels compare:
       * `quality` is what was asked for, which for a playlist is the ceiling
       * yt-dlp applies per video - a 480p video under a 1080p ceiling comes down
       * at 480p, and reporting that would be several answers to a question with
       * one. what a playlist adds is that it is one and how many videos were
       * ticked; what the run made of them is main's to report, because only main
       * sees the end of it.
       *
       * `is_trimmed` is false by construction rather than by choice: the
       * playlist operation does not accept a time range at all, and there is no
       * control to hide.
       *
       * playlists are youtube's, and this hook only ever serves them.
       */
      track("download_started", {
        platform: "youtube",
        is_playlist: true,
        item_count: request.entries.length,
        is_trimmed: false,
        ...(request.type === "audio" && request.audio_mode
          ? {
              media_type: "audio",
              quality: audioQuality(request.audio_mode),
              audio_format: request.audio_mode
            }
          : {
              media_type: "video",
              quality: videoQuality(request.height)
            })
      })

      try {
        // resolves once the process is running; the run itself is followed
        // through the progress events above
        await playlistApi.download({ ...request, download_id: downloadId })

        // the id is reserved from here on, so a cancel now has something to
        // find. main reserves it only after preparing the download directory,
        // which is the window the retry below exists for
        ackedRef.current = true

        if (
          isCurrentRun() &&
          cancelIntentRef.current &&
          !outcomeSettledRef.current
        ) {
          cancelIntentRef.current = false
          await requestCancel(downloadId)
        }

        return await finished
      } catch (error) {
        // a start failure means no terminal event is ever coming
        if (isCurrentRun()) {
          outcomeSettledRef.current = true
          settleRef.current?.reject(error as Error)
        }

        throw error
      } finally {
        // the admission guard comes off however this ended, or the hook is
        // busy for the rest of its life. everything else here is this run's
        // share of state the next one also uses, so an abandoned run must not
        // touch it: that is the cross-settle the guard exists to prevent,
        // arriving one reset later
        runningRef.current = false

        if (isCurrentRun()) {
          settleRef.current = null
          cancelIntentRef.current = false
          usePlaylistStore.getState().setIsDownloading(false)

          if (progressCleanupRef.current) {
            progressCleanupRef.current()
            progressCleanupRef.current = null
          }
        }
      }
    },
    onError: (error: Error) => {
      // nothing was started: a sentence about the selection, or about the run
      // already going. neither is a failure anyone should be asked to report
      if (error instanceof PlaylistStartRefused) {
        toast.error(error.message)
        return
      }

      /**
       * the run this failure belongs to is no longer the one on screen.
       *
       * a start ipc that rejects after the view moved on still gets its
       * callbacks, and writing "Playlist download failed" here would put the
       * abandoned playlist's failure over the picker of the one now loaded.
       */
      if (!isCurrentRun()) {
        return
      }

      // terminal outcomes are owned by the progress-event path above, which has
      // already updated state, toasted and staged the report
      if (isTerminalReason(error)) {
        return
      }

      setDownloadState((prev) => ({
        ...prev,
        status: "failed",
        error: error.message,
        category: error instanceof DownloadError ? error.category : undefined,
        wordingCode:
          error instanceof DownloadError ? error.wordingCode : undefined,
        message: t("download.startFailed", { message: error.message })
      }))

      reportActions.stage({
        shortMessage: error.message,
        details: error instanceof DownloadError ? error.details : undefined,
        category: error instanceof DownloadError ? error.category : undefined,
        platform: "youtube",
        downloadType: lastTypeRef.current,
        videoUrl: lastUrlRef.current
      })
      showDownloadErrorToast(
        t("playlist.failed"),
        failureSentence({
          error: error.message,
          category: error instanceof DownloadError ? error.category : undefined,
          wordingCode:
            error instanceof DownloadError ? error.wordingCode : undefined
        }),
        error instanceof DownloadError ? error.category : undefined,
        "youtube"
      )
    }
  })

  /**
   * what the user's Cancel does once main is in a position to take it
   *
   * the id is only cancellable once main has reserved it, and main reserves it
   * after preparing the download directory - so this is also what the retry
   * after the start ack calls.
   *
   * @returns whether main had something to cancel
   */
  const cancelDownload = async () => {
    const downloadId = downloadIdRef.current

    // nothing was ever started, or it has already ended on its own terms
    if (!downloadId || outcomeSettledRef.current) return

    try {
      // read before asking: the ack can land while we wait for the answer, and
      // "main had nothing to cancel" means something different on each side of
      // it - before, the id is not reserved yet; after, the run just finished
      const wasAcked = ackedRef.current

      if (await requestCancel(downloadId)) return

      if (wasAcked) {
        // the run finished as we asked. settling anyway would show "cancelled"
        // over a completed download and discard the terminal event in flight
        return
      }

      // main is still preparing and has not reserved the id, so there was
      // nothing for it to find. remember the intent rather than dropping it
      cancelIntentRef.current = true

      // ...and if the ack landed while we were waiting for that answer, the
      // check that reads this intent has already been and gone
      if (ackedRef.current && !outcomeSettledRef.current) {
        cancelIntentRef.current = false
        await requestCancel(downloadId)
      }
    } catch (error) {
      console.error("Failed to cancel playlist download:", error)
    }
  }

  const reset = () => {
    /**
     * the generation moves first, so nothing below can be undone by a callback
     * that was already in flight. from here on, the run this view was watching
     * cannot write to it again: not through its listener, which goes below,
     * and not through its mutation's own `onError`, `catch` or `finally`,
     * which the mutation keeps whatever we do here.
     */
    generationRef.current += 1

    settleRef.current?.reject(terminalReason("abandoned", "Download reset"))
    settleRef.current = null
    // the engine is not cancelled by a reset, so an intent left over from one
    // is an instruction nobody asked for by the time the next run starts. the
    // id goes with it: a reset view has no run of its own to cancel any more
    cancelIntentRef.current = false
    downloadIdRef.current = null

    if (progressCleanupRef.current) {
      progressCleanupRef.current()
      progressCleanupRef.current = null
    }

    // the abandoned run's `finally` will not do this now, and this screen has
    // no run of its own any more
    usePlaylistStore.getState().setIsDownloading(false)

    setDownloadState({ status: "idle", progress: 0 })
  }

  return {
    ...mutation,
    downloadState,
    cancelDownload,
    reset,
    isDownloading:
      downloadState.status === "downloading" ||
      downloadState.status === "starting",
    isCompleted: downloadState.status === "completed",
    isFailed: downloadState.status === "failed",
    isCancelled: downloadState.status === "cancelled"
  }
}

/**
 * write one row's badge from the event that named it
 *
 * the row is keyed on `playlist_index`, the video's true position, because that
 * is what the listing on screen is numbered by. there is no title on the event
 * and there cannot be: main never sees one.
 *
 * "saved" is claimed only when the run says the item's file landed, which is
 * what `items_completed >= item_index` means - the engine counts an item
 * completed the moment its file lands and stops adding the item in flight on
 * top once it has. anything less is a row still downloading. this follows the
 * engine's own rule of undercounting a save rather than overcounting one.
 */
/**
 * write the rows a finished run accounts for
 *
 * a cancelled run gets this too: the videos it had already saved are on disk
 * and are just as real as a completed run's, and the archive rows it skipped
 * were never this run's to lose.
 */
function applyRunOutcome(data: DownloadProgress): void {
  const store = usePlaylistStore.getState()

  store.applyRunOutcome({
    delivered: deliveredByIndex(data.files, store.playlistInfo?.entries),
    reusedIndices: data.reused_indices
  })
}

function applyItemStatus(data: DownloadProgress): void {
  const index = data.playlist_index

  if (typeof index !== "number") return

  const landed =
    typeof data.items_completed === "number" &&
    typeof data.item_index === "number" &&
    data.items_completed >= data.item_index

  usePlaylistStore
    .getState()
    .setItemStatus(
      index,
      landed
        ? { state: "saved", progress: 100 }
        : { state: "downloading", progress: data.item_progress ?? 0 }
    )
}
