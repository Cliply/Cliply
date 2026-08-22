import {
  DownloadError,
  downloadApi,
  systemApi,
  videoApi,
  type AudioDownloadRequest,
  type DownloadProgress
} from "@/lib/api"
import { isTerminalReason, terminalReason } from "@/lib/downloadOutcome"
import { reportActions } from "@/lib/reportStore"
import { showDownloadErrorToast } from "@/lib/toast-utils"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

export interface AudioDownloadState {
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

export const useAudioDownload = () => {
  const [downloadState, setDownloadState] = useState<AudioDownloadState>({
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
      settleRef.current?.reject(terminalReason("abandoned", "Download view closed"))
      settleRef.current = null

      if (progressCleanupRef.current) {
        progressCleanupRef.current()
        progressCleanupRef.current = null
      }
    }
  }, [])

  const mutation = useMutation({
    mutationFn: async (request: AudioDownloadRequest) => {
      lastUrlRef.current = request.url
      setDownloadState({
        status: "starting",
        progress: 0,
        message: "Starting audio download..."
      })

      // Correlate on an id we generate here: the listener can then filter from
      // the moment it subscribes, so a concurrent download's events can never
      // settle this mutation.
      const downloadId = crypto.randomUUID()
      setDownloadState((prev) => ({ ...prev, downloadId }))

      // settles when a terminal event arrives, which is what keeps the caller's
      // await (and the button's pending state) tied to the real download
      const finished = new Promise<{ downloadId: string }>((resolve, reject) => {
        settleRef.current = { resolve, reject }
      })

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
              status: progressData.status as AudioDownloadState["status"],
              progress: progressData.progress || prev.progress,
              speed: progressData.speed,
              eta: progressData.eta,
              indeterminate: progressData.indeterminate,
              message:
                progressData.error ||
                `Downloading audio... ${(progressData.progress || 0).toFixed(1)}%`,
              outputFile: progressData.filename,
              error: progressData.error
            }))

            // Handle completion
            if (progressData.status === "completed") {
              toast.success("Audio download completed!", {
                description: progressData.filename
                  ? `Saved: ${progressData.filename}`
                  : undefined,
                action: {
                  label: "Open Folder",
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
                downloadType: "audio",
                videoUrl: lastUrlRef.current
              })
              showDownloadErrorToast(
                "Audio download failed",
                progressData.error || "Something went wrong. You can send us the details."
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

      try {
        // resolves once the process is running; the download itself is followed
        // through the progress events above
        await videoApi.downloadAudio({ ...request, download_id: downloadId })

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
        message: `Failed to start download: ${error.message}`
      }))

      reportActions.stage({
        shortMessage: error.message,
        details: error instanceof DownloadError ? error.details : undefined,
        category: error instanceof DownloadError ? error.category : undefined,
        platform: "youtube",
        downloadType: "audio",
        videoUrl: lastUrlRef.current
      })
      showDownloadErrorToast("Audio download failed", error.message)
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
          message: "Download cancelled"
        }))

        // settle the pending mutation so the button never stays stuck
        settleRef.current?.reject(
          terminalReason("cancelled", "Download cancelled")
        )

        toast.info("Audio download cancelled")
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
