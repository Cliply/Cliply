import {
  DownloadError,
  downloadApi,
  systemApi,
  videoApi,
  type AudioDownloadRequest,
  type DownloadProgress
} from "@/lib/api"
import { reportActions } from "@/lib/reportStore"
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
}

export const useAudioDownload = () => {
  const [downloadState, setDownloadState] = useState<AudioDownloadState>({
    status: "idle",
    progress: 0
  })

  const progressCleanupRef = useRef<(() => void) | null>(null)
  const lastUrlRef = useRef<string | undefined>(undefined)

  // Cleanup progress listener on unmount
  useEffect(() => {
    return () => {
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

      // Start the download
      const result = await videoApi.downloadAudio(request)
      const { downloadId } = result

      // Set up progress tracking
      const cleanup = downloadApi.onProgress(
        (progressData: DownloadProgress) => {
          if (progressData.downloadId === downloadId) {
            setDownloadState((prev) => ({
              ...prev,
              downloadId,
              status: progressData.status as AudioDownloadState["status"],
              progress: progressData.progress || prev.progress,
              speed: progressData.speed,
              eta: progressData.eta,
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

              // Cleanup listener after completion
              if (progressCleanupRef.current) {
                progressCleanupRef.current()
                progressCleanupRef.current = null
              }
            }

            // Handle failure
            if (progressData.status === "failed") {
              reportActions.stage({
                shortMessage: progressData.error || "Download failed",
                platform: "youtube",
                downloadType: "audio",
                videoUrl: lastUrlRef.current
              })
              toast.error("Audio download failed", {
                description: progressData.error || "Unknown error occurred",
                action: { label: "Report", onClick: () => reportActions.open() }
              })

              // Cleanup listener after failure
              if (progressCleanupRef.current) {
                progressCleanupRef.current()
                progressCleanupRef.current = null
              }
            }
          }
        }
      )

      progressCleanupRef.current = cleanup

      return { downloadId, cleanup }
    },
    onError: (error: Error) => {
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
      toast.error("Failed to start audio download", {
        description: error.message,
        action: { label: "Report", onClick: () => reportActions.open() }
      })
    }
  })

  // Cancel download function
  const cancelDownload = async () => {
    if (downloadState.downloadId) {
      try {
        await downloadApi.cancelDownload(downloadState.downloadId)
        setDownloadState((prev) => ({
          ...prev,
          status: "cancelled",
          message: "Download cancelled"
        }))

        // Cleanup progress listener
        if (progressCleanupRef.current) {
          progressCleanupRef.current()
          progressCleanupRef.current = null
        }

        toast.info("Audio download cancelled")
      } catch (error) {
        console.error("Failed to cancel download:", error)
      }
    }
  }

  // Reset function to clear state
  const reset = () => {
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
