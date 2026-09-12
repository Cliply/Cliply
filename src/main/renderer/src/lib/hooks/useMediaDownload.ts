import {
  audioQuality,
  isTrimmedRange,
  track,
  videoQuality,
  type AnalyticsProperties
} from "@/lib/analytics"
import {
  DownloadError,
  downloadApi,
  videoApi,
  type AudioDownloadRequest,
  type VideoDownloadRequest
} from "@/lib/api"
import { DOWNLOAD_WORDING, videoLabel } from "@/lib/downloadKinds"
import { localizeError, t } from "@/lib/i18n"
import {
  downloadsActions,
  isLiveRow,
  useDownloadRow
} from "@/lib/stores/downloadsStore"
import { reportActions } from "@/lib/stores/reportStore"
import { showDownloadErrorToast } from "@/lib/toast-utils"
import { useMutation } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

export type MediaKind = "video" | "audio"

/**
 * the request each kind starts a download with
 *
 * keyed by kind rather than unioned so the table below stays correlated: an
 * entry only ever sees the request its own api takes, and `mutateAsync` keeps
 * the exact type the call site was passing before.
 */
export interface MediaDownloadRequests {
  video: VideoDownloadRequest
  audio: AudioDownloadRequest
}

interface MediaSpec<K extends MediaKind> {
  /** what the api call is, once the correlation id has been folded in */
  start: (
    request: MediaDownloadRequests[K] & { download_id: string }
  ) => Promise<{ downloadId: string }>
  /**
   * the part of `download_started` that is not the platform or the trim, in the
   * order it has always been sent in
   */
  trackFields: (request: MediaDownloadRequests[K]) => AnalyticsProperties
  /** the words that go beside the title in the panel */
  label: (request: MediaDownloadRequests[K]) => string
}

const MEDIA: { [K in MediaKind]: MediaSpec<K> } = {
  video: {
    start: (request) => videoApi.downloadVideo(request),
    trackFields: (request) => ({ quality: videoQuality(request.height) }),
    // the container the menu row displayed, so the label can never disagree
    // with the file that lands
    label: (request) => videoLabel(request.height, request.container)
  },
  audio: {
    start: (request) => videoApi.downloadAudio(request),
    // audio_format is the mode itself; quality is the same mode in the words
    // main's later events for this download will use
    trackFields: (request) => ({
      quality: audioQuality(request.audio_mode),
      audio_format: request.audio_mode
    }),
    // the mode is the whole choice an audio download offers
    label: (request) => request.audio_mode
  }
}

/**
 * start one download, of whichever kind the caller asked for
 *
 * this used to follow the download too: it subscribed to `download:progress`,
 * held the promise open until a terminal event arrived, and owned the toasts.
 * All of that now belongs to `DownloadEvents`, which is mounted once and
 * outlives every screen - so what is left here is "build the request, put a row
 * in the store, call main" and a view onto that row.
 *
 * the mutation resolves at main's acknowledgement rather than at the end of the
 * download, which is what lets the button come back for a second link while the
 * first one is still running.
 *
 * video and audio differ only in the entries of MEDIA above; `useVideoDownload`
 * and `useAudioDownload` are the two names this is reached by.
 */
export const useMediaDownload = <K extends MediaKind>(kind: K) => {
  const media = MEDIA[kind]

  // the row this screen started, which is not "the row that is live": a second
  // download from another screen must not move this one's bar
  const [lastId, setLastId] = useState<string | undefined>(undefined)
  const row = useDownloadRow(lastId)

  // what a staged report says this failure was about. a ref because `onError`
  // closes over the render the mutation was called from, which is one render
  // behind the id that call site just minted
  const lastUrlRef = useRef<string | undefined>(undefined)

  const mutation = useMutation({
    mutationFn: async (request: MediaDownloadRequests[K]) => {
      const label = media.label(request)
      lastUrlRef.current = request.url

      /**
       * the same download, asked for twice.
       *
       * two yt-dlp processes writing one `.part` file corrupt each other, so
       * the second click goes to the first download rather than beside it: the
       * panel opens on it and the row is highlighted. nothing is sent to main,
       * and the row this hook follows becomes that one - it is, after all, the
       * download that was just asked for.
       */
      const existing = downloadsActions.findLive({ kind, label, request })

      if (existing) {
        setLastId(existing.downloadId)
        downloadsActions.setHighlighted(existing.downloadId)
        downloadsActions.setPanelOpen(true)

        return { downloadId: existing.downloadId, duplicate: true }
      }

      // correlate on an id we generate here: the row exists under it before
      // main has answered, so a cancel or a progress event has something to
      // find from the first moment
      const downloadId = crypto.randomUUID()
      setLastId(downloadId)

      downloadsActions.add({
        downloadId,
        kind,
        // this hook only ever serves youtube - the other platforms have their
        // own components and never reach it
        platform: "youtube",
        title: request.title || "",
        label,
        // main never sends this one: it is the gap between the click and the
        // first event, and a row with no status at all cannot be drawn
        status: "starting",
        progress: 0,
        startedAt: Date.now(),
        request
      })

      track("download_started", {
        platform: "youtube",
        media_type: kind,
        ...media.trackFields(request),
        is_trimmed: isTrimmedRange(request.time_range)
      })

      try {
        // resolves once the download is accepted; everything after that arrives
        // on download:progress, which DownloadEvents is listening to
        await media.start({ ...request, download_id: downloadId })
      } catch (error) {
        /**
         * no event will ever come for this row, so the row has to be settled
         * here. by id and not by "the row this hook is following": a start that
         * rejects after the view was reset is exactly the case, and writing to
         * whatever the hook points at now would mark somebody else's download
         * failed.
         */
        failRow(downloadId, error)
        throw error
      }

      return { downloadId, duplicate: false }
    },
    onError: (error: Error) => {
      // the only rejection left is a start main refused: a bad url, a folder it
      // cannot write to, an id it already has. everything that happens after the
      // acknowledgement is DownloadEvents' to report
      reportActions.stage({
        shortMessage: error.message,
        details: error instanceof DownloadError ? error.details : undefined,
        category: error instanceof DownloadError ? error.category : undefined,
        platform: "youtube",
        downloadType: kind,
        videoUrl: lastUrlRef.current
      })
      showDownloadErrorToast(
        t(DOWNLOAD_WORDING[kind].failed),
        localizeError({
          message: error.message,
          category: error instanceof DownloadError ? error.category : undefined
        }).message,
        error instanceof DownloadError ? error.category : undefined,
        "youtube"
      )
    }
  })

  /**
   * ask main to stop this screen's download
   *
   * the `cancelled` event is what actually settles the row; this only says so
   * to the user, who asked for it and should not have to wait to hear it. main
   * reporting false means it had nothing to cancel - usually because the
   * download just finished - and toasting then would put "cancelled" over a
   * download that completed.
   */
  const cancelDownload = async () => {
    if (!lastId) return

    try {
      const cancelled = await downloadApi.cancelDownload(lastId)

      if (!cancelled) return

      toast.info(t(DOWNLOAD_WORDING[kind].cancelled))
    } catch (error) {
      console.error("Failed to cancel download:", error)
    }
  }

  /**
   * stop following the row this screen started
   *
   * the download itself is untouched, here as on unmount: it keeps running, it
   * keeps its row in the panel, and its outcome is still announced. all this
   * clears is which row the inline bar is drawing.
   */
  const reset = () => setLastId(undefined)

  return {
    ...mutation,
    row,
    cancelDownload,
    reset,
    isDownloading: isLiveRow(row),
    isCompleted: row?.status === "completed",
    isFailed: row?.status === "failed",
    isCancelled: row?.status === "cancelled"
  }
}

/** mark one row as a download that never started */
function failRow(downloadId: string, error: unknown): void {
  const message =
    error instanceof Error ? error.message : "Failed to start download"

  downloadsActions.applyEvent({
    downloadId,
    status: "failed",
    progress: 0,
    error: message,
    category: error instanceof DownloadError ? error.category : undefined
  })
}
