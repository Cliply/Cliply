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
  systemApi,
  videoApi,
  type AudioDownloadRequest,
  type DownloadProgress,
  type VideoDownloadRequest
} from "@/lib/api"
import { isTerminalReason, terminalReason } from "@/lib/downloadOutcome"
import { localizeError, t, type Key } from "@/lib/i18n"
import { reportActions } from "@/lib/reportStore"
import { showDownloadErrorToast } from "@/lib/toast-utils"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
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

export interface MediaDownloadState {
  downloadId?: string
  status:
    | "idle"
    | "starting"
    | "downloading"
    | "completed"
    | "failed"
    | "cancelled"
  progress: number
  speed?: string
  eta?: string
  message?: string
  outputFile?: string
  fileSize?: number
  error?: string
  // trimmed downloads report a single sweep, so there is no live percentage
  indeterminate?: boolean
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
  /** the five strings that name the kind to the user */
  keys: {
    starting: Key
    progress: Key
    completed: Key
    failed: Key
    cancelled: Key
  }
}

const MEDIA: { [K in MediaKind]: MediaSpec<K> } = {
  video: {
    start: (request) => videoApi.downloadVideo(request),
    trackFields: (request) => ({ quality: videoQuality(request.height) }),
    keys: {
      starting: "download.startingVideo",
      progress: "download.videoProgress",
      completed: "download.videoCompleted",
      failed: "download.videoFailed",
      cancelled: "download.videoCancelled"
    }
  },
  audio: {
    start: (request) => videoApi.downloadAudio(request),
    // audio_format is the mode itself; quality is the same mode in the words
    // main's later events for this download will use
    trackFields: (request) => ({
      quality: audioQuality(request.audio_mode),
      audio_format: request.audio_mode
    }),
    keys: {
      starting: "download.startingAudio",
      progress: "download.audioProgress",
      completed: "download.audioCompleted",
      failed: "download.audioFailed",
      cancelled: "download.audioCancelled"
    }
  }
}

/**
 * one download, of whichever kind the caller asked for
 *
 * video and audio differ only in the entries of MEDIA above: the api they
 * start, the fields they name themselves by in telemetry and in a staged
 * report, and the five strings they say to the user. Everything else - the
 * correlation id, the promise the progress events settle, the cleanup - is one
 * behaviour, and `useVideoDownload` / `useAudioDownload` are the two names it
 * is reached by.
 */
export const useMediaDownload = <K extends MediaKind>(kind: K) => {
  const media = MEDIA[kind]

  const [downloadState, setDownloadState] = useState<MediaDownloadState>({
    status: "idle",
    progress: 0
  })

  const progressCleanupRef = useRef<(() => void) | null>(null)
  const lastUrlRef = useRef<string | undefined>(undefined)
  const settleRef = useRef<{
    resolve: (value: { downloadId: string }) => void
    reject: (error: Error) => void
  } | null>(null)

  // Cleanup progress listener on unmount
  // On unmount we stop listening but deliberately do NOT cancel the engine
  // download - it keeps running, which is what users expect when a view is
  // swapped out. The pending mutation is settled so nothing awaits forever.
  useEffect(() => {
    return () => {
      settleRef.current?.reject(
        terminalReason("abandoned", "Download view closed")
      )
      settleRef.current = null

      if (progressCleanupRef.current) {
        progressCleanupRef.current()
        progressCleanupRef.current = null
      }
    }
  }, [])

  const mutation = useMutation({
    mutationFn: async (request: MediaDownloadRequests[K]) => {
      lastUrlRef.current = request.url
      setDownloadState({
        status: "starting",
        progress: 0,
        message: t(media.keys.starting)
      })

      // Correlate on an id we generate here: the listener can then filter from
      // the moment it subscribes, so a concurrent download's events can never
      // settle this mutation.
      const downloadId = crypto.randomUUID()
      setDownloadState((prev) => ({ ...prev, downloadId }))

      // settles when a terminal event arrives, which is what keeps the caller's
      // await (and the button's pending state) tied to the real download
      const finished = new Promise<{ downloadId: string }>(
        (resolve, reject) => {
          settleRef.current = { resolve, reject }
        }
      )

      // nothing awaits `finished` until the start ipc below resolves, so an
      // unmount or reset in that window would reject a promise with no handler
      // attached - which surfaces as an unhandledrejection. Observing it here
      // is enough; the `await` further down still sees the same rejection.
      finished.catch(() => {})

      const cleanup = downloadApi.onProgress(
        (progressData: DownloadProgress) => {
          if (progressData.downloadId !== downloadId) return
          {
            setDownloadState((prev) => ({
              ...prev,
              downloadId,
              status: progressData.status as MediaDownloadState["status"],
              progress: progressData.progress || prev.progress,
              speed: progressData.speed,
              eta: progressData.eta,
              indeterminate: progressData.indeterminate,
              message:
                progressData.error ||
                t(media.keys.progress, {
                  percent: (progressData.progress || 0).toFixed(1)
                }),
              outputFile: progressData.filename,
              error: progressData.error
            }))

            // Handle completion
            if (progressData.status === "completed") {
              toast.success(t(media.keys.completed), {
                description: progressData.filename
                  ? t("download.saved", { filename: progressData.filename })
                  : undefined,
                action: {
                  label: t("toast.openFolder"),
                  onClick: () => systemApi.openDownloadFolder()
                }
              })

              settleRef.current?.resolve({ downloadId })
            }

            // Handle failure
            if (progressData.status === "failed") {
              reportActions.stage({
                shortMessage: progressData.error || "Download failed",
                details: progressData.details,
                category: progressData.category,
                platform: "youtube",
                downloadType: kind,
                videoUrl: lastUrlRef.current
              })
              showDownloadErrorToast(
                t(media.keys.failed),
                // the report above keeps main's english; only what is read here
                // is translated
                progressData.error
                  ? localizeError({
                      message: progressData.error,
                      category: progressData.category
                    }).message
                  : t("download.wentWrong"),
                progressData.category,
                "youtube"
              )

              // already surfaced here; onError must not report it twice
              settleRef.current?.reject(
                terminalReason(
                  "failed",
                  progressData.error || "Download failed"
                )
              )
            }

            // Handle cancellation - not a failure, nobody should report it
            if (progressData.status === "cancelled") {
              settleRef.current?.reject(
                terminalReason("cancelled", "Download cancelled")
              )
            }
          }
        }
      )

      progressCleanupRef.current = cleanup

      // the hook only ever serves youtube - the other platforms have their own
      // components and never reach this mutation
      track("download_started", {
        platform: "youtube",
        media_type: kind,
        ...media.trackFields(request),
        is_trimmed: isTrimmedRange(request.time_range)
      })

      try {
        // resolves once the process is running; the download itself is followed
        // through the progress events above
        await media.start({ ...request, download_id: downloadId })

        return await finished
      } catch (error) {
        // a start failure means no terminal event is ever coming, so settle the
        // terminal promise rather than leaving it pending forever (rejecting an
        // already-settled promise is a no-op, so the terminal paths are safe)
        settleRef.current?.reject(error as Error)
        throw error
      } finally {
        settleRef.current = null
        if (progressCleanupRef.current) {
          progressCleanupRef.current()
          progressCleanupRef.current = null
        }
      }
    },
    onError: (error: Error) => {
      // terminal outcomes are owned by the progress-event path above, which has
      // already updated state, toasted and staged the report
      if (isTerminalReason(error)) {
        return
      }

      setDownloadState((prev) => ({
        ...prev,
        status: "failed",
        error: error.message,
        message: t("download.startFailed", { message: error.message })
      }))

      reportActions.stage({
        shortMessage: error.message,
        details: error instanceof DownloadError ? error.details : undefined,
        category: error instanceof DownloadError ? error.category : undefined,
        platform: "youtube",
        downloadType: kind,
        videoUrl: lastUrlRef.current
      })
      showDownloadErrorToast(
        t(media.keys.failed),
        localizeError({
          message: error.message,
          category: error instanceof DownloadError ? error.category : undefined
        }).message,
        error instanceof DownloadError ? error.category : undefined,
        "youtube"
      )
    }
  })

  // Cancel download function
  const cancelDownload = async () => {
    if (downloadState.downloadId) {
      try {
        const cancelled = await downloadApi.cancelDownload(
          downloadState.downloadId
        )

        // main reports false when it had nothing to cancel - usually because the
        // download just finished. Settling anyway would show "cancelled" over a
        // completed download and discard the terminal event still in flight.
        if (!cancelled) {
          return
        }

        setDownloadState((prev) => ({
          ...prev,
          status: "cancelled",
          message: t("download.cancelled")
        }))

        // settle the pending mutation so the button never stays stuck
        settleRef.current?.reject(
          terminalReason("cancelled", "Download cancelled")
        )

        toast.info(t(media.keys.cancelled))
      } catch (error) {
        console.error("Failed to cancel download:", error)
      }
    }
  }

  // Reset function to clear state
  const reset = () => {
    settleRef.current?.reject(terminalReason("abandoned", "Download reset"))
    settleRef.current = null

    if (progressCleanupRef.current) {
      progressCleanupRef.current()
      progressCleanupRef.current = null
    }

    setDownloadState({
      status: "idle",
      progress: 0
    })
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
