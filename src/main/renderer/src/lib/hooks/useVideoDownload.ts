import {
  downloadApi,
  systemApi,
  videoApi,
  type DownloadProgress,
  type VideoDownloadRequest
} from "@/lib/api"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

export interface VideoDownloadState {
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

export const useVideoDownload = () => {
  const [downloadState, setDownloadState] = useState<VideoDownloadState>({
    status: "idle",
    progress: 0
  })

  const progressCleanupRef = useRef<(() => void) | null>(null)

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
    mutationFn: async (request: VideoDownloadRequest) => {
      setDownloadState({
        status: "starting",
        progress: 0,
        message: "Starting video download..."
      })

      // Start the download
      const result = await videoApi.downloadVideo(request)
      const { downloadId } = result

      // Set up progress tracking
      const cleanup = downloadApi.onProgress(
        (progressData: DownloadProgress) => {
          if (progressData.downloadId === downloadId) {
            setDownloadState((prev) => ({
              ...prev,
              downloadId,
              status: progressData.status as VideoDownloadState["status"],
              progress: progressData.progress || prev.progress,
              speed: progressData.speed,
              eta: progressData.eta,
              message:
                progressData.error ||
                `Downloading video... ${(progressData.progress || 0).toFixed(1)}%`,
              outputFile: progressData.filename,
              error: progressData.error
            }))

            // Handle completion
            if (progressData.status === "completed") {
              toast.success("Video download completed!", {
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
              toast.error("Video download failed", {
                description: progressData.error || "Unknown error occurred"
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

      toast.error("Failed to start video download", {
        description: error.message
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

        toast.info("Video download cancelled")
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
