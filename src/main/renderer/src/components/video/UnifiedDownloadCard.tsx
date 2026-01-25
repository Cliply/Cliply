import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  downloadApi,
  pinterestApi,
  systemApi,
  validateTimeRange,
  type DownloadProgress,
  type PinterestVideoInfoResponse,
  type VideoFormat
} from "@/lib/api"
import { useServerStatus } from "@/lib/hooks/useServerStatus"
import { usePinterestStore } from "@/lib/pinterestStore"
import { useYouTubeStore } from "@/lib/youtubeStore"
import {
  showServerOverwhelmedToast,
  showServerStartingToast
} from "@/lib/toast-utils"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { AudioDownloadButton } from "./AudioDownloadButton"
import { AudioFormatDropdown } from "./AudioFormatDropdown"
import { TimeRangeSelector } from "./TimeRangeSelector"
import { VideoDownloadButton } from "./VideoDownloadButton"
import { VideoQualityDropdown } from "./VideoQualityDropdown"
import { VideoTimeRangeSelector } from "./VideoTimeRangeSelector"

type YouTubeDownloadCardProps = {
  platform?: "youtube"
  videoInfo: {
    duration: number
    video_formats: VideoFormat[]
    audio_formats: VideoFormat[]
  }
  className?: string
}

type PinterestDownloadCardProps = {
  platform: "pinterest"
  pinInfo: PinterestVideoInfoResponse
  className?: string
}

type UnifiedDownloadCardProps =
  | YouTubeDownloadCardProps
  | PinterestDownloadCardProps

export function UnifiedDownloadCard(props: UnifiedDownloadCardProps) {
  if (props.platform === "pinterest") {
    return (
      <PinterestDownloadCard pinInfo={props.pinInfo} className={props.className} />
    )
  }

  return <YouTubeDownloadCard videoInfo={props.videoInfo} className={props.className} />
}

function YouTubeDownloadCard({
  videoInfo,
  className
}: {
  videoInfo: {
    duration: number
    video_formats: VideoFormat[]
    audio_formats: VideoFormat[]
  }
  className?: string
}) {
  const {
    audioTimeRange,
    selectedAudioFormatForDownload,
    videoTimeRange,
    selectedVideoQuality
  } = useYouTubeStore()

  const [isVideoQualityDropdownOpen, setIsVideoQualityDropdownOpen] =
    useState(false)
  const [activeTab, setActiveTab] = useState("video")

  const isValidAudioTimeRange = validateTimeRange(
    audioTimeRange.start,
    audioTimeRange.end,
    videoInfo.duration
  ).isValid

  const showAudioFormatDropdown = isValidAudioTimeRange
  const showAudioDownloadButton =
    showAudioFormatDropdown && !!selectedAudioFormatForDownload

  const isValidVideoTimeRange = validateTimeRange(
    videoTimeRange.start,
    videoTimeRange.end,
    videoInfo.duration
  ).isValid

  const showVideoQualityDropdown = isValidVideoTimeRange
  const showVideoDownloadButton = showVideoQualityDropdown && !!selectedVideoQuality

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className={cn(
        "rounded-2xl border-2 transition-all duration-200",
        "dark:bg-slate-800/40 dark:border-slate-700/50 dark:backdrop-blur-sm",
        "bg-white/60 border-slate-300/50 backdrop-blur-sm",
        "shadow-xl",
        "font-space-grotesk",
        isVideoQualityDropdownOpen && activeTab === "video" && "mb-80",
        className
      )}
    >
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="p-6 pb-0">
          <TabsList className="grid w-full grid-cols-2 bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200/50 dark:border-slate-700/50">
            <TabsTrigger
              value="video"
              className="flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:shadow-sm dark:data-[state=active]:bg-slate-700 dark:data-[state=active]:border-slate-600 transition-all duration-200"
            >
              🎬 Video Download
            </TabsTrigger>
            <TabsTrigger
              value="audio"
              className="flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:shadow-sm dark:data-[state=active]:bg-slate-700 dark:data-[state=active]:border-slate-600 transition-all duration-200"
            >
              🎵 Audio Only
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="video" className="p-6 pt-4 m-0">
          <div className="space-y-4">
            <div className="mb-6">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Download video with automatically paired audio
              </p>
            </div>

            <div className="space-y-6">
              <VideoTimeRangeSelector maxDuration={videoInfo.duration} />

              <VideoQualityDropdown
                videoFormats={videoInfo.video_formats}
                audioFormats={videoInfo.audio_formats}
                isVisible={showVideoQualityDropdown}
                onOpenChange={setIsVideoQualityDropdownOpen}
              />

              <VideoDownloadButton
                maxDuration={videoInfo.duration}
                audioFormats={videoInfo.audio_formats}
                isVisible={showVideoDownloadButton}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="audio" className="p-6 pt-4 m-0">
          <div className="space-y-4">
            <div className="mb-6">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Extract audio from the video with custom time range
              </p>
            </div>

            <div className="space-y-6">
              <TimeRangeSelector maxDuration={videoInfo.duration} />

              <AudioFormatDropdown
                audioFormats={videoInfo.audio_formats}
                isVisible={showAudioFormatDropdown}
              />

              <AudioDownloadButton
                maxDuration={videoInfo.duration}
                isVisible={showAudioDownloadButton}
              />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </motion.div>
  )
}

type PinterestDownloadState = {
  status:
    | "idle"
    | "starting"
    | "downloading"
    | "completed"
    | "failed"
    | "cancelled"
  progress: number
  message?: string
  filename?: string
  error?: string
}

function PinterestDownloadCard({
  pinInfo,
  className
}: {
  pinInfo: PinterestVideoInfoResponse
  className?: string
}) {
  const { url, isDownloading, setIsDownloading } = usePinterestStore()
  const serverStatus = useServerStatus()
  const progressCleanupRef = useRef<(() => void) | null>(null)
  const [downloadState, setDownloadState] = useState<PinterestDownloadState>({
    status: "idle",
    progress: 0
  })

  useEffect(() => {
    return () => {
      if (progressCleanupRef.current) {
        progressCleanupRef.current()
        progressCleanupRef.current = null
      }
    }
  }, [])

  const handleDownload = async () => {
    if (!url) {
      toast.error("Missing Pinterest URL")
      return
    }

    if (isDownloading || downloadState.status === "starting") {
      return
    }

    if (serverStatus.isStarting) {
      showServerStartingToast()
      return
    }

    if (!serverStatus.isReady && !serverStatus.isUnknown) {
      toast.error("Download engine not ready", {
        description: "Please wait for the download engine to start"
      })
      return
    }

    try {
      setIsDownloading(true)
      setDownloadState({
        status: "starting",
        progress: 0,
        message: "Starting download..."
      })

      const { downloadId } = await pinterestApi.download({ url })

      const cleanup = downloadApi.onProgress((progress: DownloadProgress) => {
        if (progress.downloadId !== downloadId) return

        setDownloadState((prev) => ({
          ...prev,
          status: progress.status as PinterestDownloadState["status"],
          progress: progress.progress || prev.progress,
          message:
            progress.error ||
            `Downloading pin... ${(progress.progress || 0).toFixed(1)}%`,
          filename: progress.filename,
          error: progress.error
        }))

        if (progress.status === "completed") {
          toast.success("Pinterest download completed!", {
            description: progress.filename
              ? `Saved: ${progress.filename}`
              : undefined,
            action: {
              label: "Open Folder",
              onClick: () => systemApi.openDownloadFolder()
            }
          })
          setIsDownloading(false)
          if (progressCleanupRef.current) {
            progressCleanupRef.current()
            progressCleanupRef.current = null
          }
        }

        if (progress.status === "failed") {
          toast.error("Pinterest download failed", {
            description: progress.error || "Unknown error occurred"
          })
          setIsDownloading(false)
          if (progressCleanupRef.current) {
            progressCleanupRef.current()
            progressCleanupRef.current = null
          }
        }

        if (progress.status === "cancelled") {
          toast.info("Pinterest download cancelled")
          setIsDownloading(false)
          if (progressCleanupRef.current) {
            progressCleanupRef.current()
            progressCleanupRef.current = null
          }
        }
      })

      progressCleanupRef.current = cleanup
    } catch (error) {
      console.error("Pinterest download error:", error)
      const message =
        error instanceof Error ? error.message : "Failed to download pin"
      if (message.includes("Download engine starting")) {
        showServerStartingToast()
      } else if (message.includes("network") || message.includes("fetch")) {
        showServerOverwhelmedToast()
      } else {
        toast.error("Download failed", { description: message })
      }
      setDownloadState({
        status: "failed",
        progress: 0,
        error: message
      })
      setIsDownloading(false)
    }
  }

  const isBusy =
    isDownloading ||
    downloadState.status === "starting" ||
    downloadState.status === "downloading"

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className={cn(
        "rounded-2xl border-2 transition-all duration-200",
        "dark:bg-slate-800/40 dark:border-slate-700/50 dark:backdrop-blur-sm",
        "bg-white/60 border-slate-300/50 backdrop-blur-sm",
        "shadow-xl",
        "font-space-grotesk",
        className
      )}
    >
      <div className="p-6 space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium text-slate-900 dark:text-white">
            Download Pinterest Video
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Download the pin directly without format selection.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200/60 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/30 p-4 text-sm text-slate-600 dark:text-slate-400">
          <p className="font-medium text-slate-900 dark:text-white line-clamp-2">
            {pinInfo.title}
          </p>
          <p className="mt-1">Uploader: {pinInfo.uploader}</p>
          <p>Duration: {pinInfo.duration_string}</p>
        </div>

        <Button
          onClick={handleDownload}
          disabled={isBusy}
          className={cn(
            "w-full h-14 text-lg font-semibold rounded-xl transition-all duration-200",
            "bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700",
            "disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
          )}
        >
          {isBusy ? "Downloading..." : "Download Pin"}
        </Button>

        {downloadState.status !== "idle" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
              <span>{downloadState.message || "Preparing download..."}</span>
              <span>{downloadState.progress.toFixed(1)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-200/70 dark:bg-slate-700/60">
              <div
                className="h-1.5 rounded-full bg-cyan-500 transition-all duration-200"
                style={{ width: `${downloadState.progress}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </motion.div>
  )
}
