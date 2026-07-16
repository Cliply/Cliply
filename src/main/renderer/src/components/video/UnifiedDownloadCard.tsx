import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DownloadError,
  pinterestApi,
  tiktokApi,
  systemApi,
  validateTimeRange,
  type PinterestVideoInfoResponse,
  type TikTokVideoInfoResponse,
  type VideoFormat
} from "@/lib/api"
import { reportActions } from "@/lib/reportStore"
import { useServerStatus } from "@/lib/hooks/useServerStatus"
import { usePinterestStore } from "@/lib/pinterestStore"
import { useTikTokStore } from "@/lib/tiktokStore"
import { useYouTubeStore } from "@/lib/youtubeStore"
import {
  showDownloadErrorToast,
  showServerOverwhelmedToast,
  showServerStartingToast
} from "@/lib/toast-utils"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { useState } from "react"
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

type TikTokDownloadCardProps = {
  platform: "tiktok"
  tikTokInfo: TikTokVideoInfoResponse
  className?: string
}

type UnifiedDownloadCardProps =
  | YouTubeDownloadCardProps
  | PinterestDownloadCardProps
  | TikTokDownloadCardProps

export function UnifiedDownloadCard(props: UnifiedDownloadCardProps) {
  if (props.platform === "pinterest") {
    return (
      <PinterestDownloadCard pinInfo={props.pinInfo} className={props.className} />
    )
  }

  if (props.platform === "tiktok") {
    return (
      <TikTokDownloadCard tikTokInfo={props.tikTokInfo} className={props.className} />
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

// Shared UI for Pinterest and TikTok — both are single-quality, single-button downloads
function SimpleVideoDownloadCard({
  videoInfo,
  subtitle,
  isDownloading,
  onDownload,
  className
}: {
  videoInfo: { title: string; uploader: string; duration_string: string }
  subtitle: string
  isDownloading: boolean
  onDownload: () => void
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className={cn(
        "rounded-2xl border-2 transition-all duration-200",
        "dark:bg-slate-800/40 dark:border-slate-700/50 dark:backdrop-blur-sm",
        "bg-white/60 border-slate-300/50 backdrop-blur-sm",
        "shadow-xl font-space-grotesk",
        className
      )}
    >
      <div className="p-6 space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium text-slate-900 dark:text-white">
            Download Video
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {subtitle}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200/60 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/30 p-4 text-sm text-slate-600 dark:text-slate-400">
          <p className="font-medium text-slate-900 dark:text-white line-clamp-2">
            {videoInfo.title}
          </p>
          <p className="mt-1">Uploader: {videoInfo.uploader}</p>
          <p>Duration: {videoInfo.duration_string}</p>
        </div>

        <Button
          onClick={onDownload}
          disabled={isDownloading}
          className={cn(
            "w-full h-12 text-base font-semibold rounded-xl transition-all duration-200",
            "bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700",
            "disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
          )}
        >
          {isDownloading ? "Downloading..." : "Download Video"}
        </Button>
      </div>
    </motion.div>
  )
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

  const handleDownload = async () => {
    if (!url || isDownloading) return
    if (serverStatus.isStarting) { showServerStartingToast(); return }
    if (!serverStatus.isReady && !serverStatus.isUnknown) {
      toast.error("Download engine not ready", { description: "Please wait for the download engine to start" })
      return
    }
    try {
      setIsDownloading(true)
      await pinterestApi.download({ url })
      toast.success("Download complete!", { action: { label: "Open Folder", onClick: () => systemApi.openDownloadFolder() } })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to download video"
      if (message.includes("Download engine starting")) { showServerStartingToast() }
      else if (message.includes("network") || message.includes("fetch")) { showServerOverwhelmedToast() }
      else {
        reportActions.stage({
          shortMessage: message,
          details: error instanceof DownloadError ? error.details : undefined,
          category: error instanceof DownloadError ? error.category : undefined,
          platform: "pinterest",
          downloadType: "video",
          videoUrl: url
        })
        showDownloadErrorToast("Download failed", message)
      }
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <SimpleVideoDownloadCard
      videoInfo={pinInfo}
      subtitle="Best available quality, saved as MP4."
      isDownloading={isDownloading}
      onDownload={handleDownload}
      className={className}
    />
  )
}

function TikTokDownloadCard({
  tikTokInfo,
  className
}: {
  tikTokInfo: TikTokVideoInfoResponse
  className?: string
}) {
  const { url, isDownloading, setIsDownloading } = useTikTokStore()
  const serverStatus = useServerStatus()

  const handleDownload = async () => {
    if (!url || isDownloading) return
    if (serverStatus.isStarting) { showServerStartingToast(); return }
    if (!serverStatus.isReady && !serverStatus.isUnknown) {
      toast.error("Download engine not ready", { description: "Please wait for the download engine to start" })
      return
    }
    try {
      setIsDownloading(true)
      await tiktokApi.download({ url })
      toast.success("Download complete!", { action: { label: "Open Folder", onClick: () => systemApi.openDownloadFolder() } })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to download video"
      if (message.includes("Download engine starting")) { showServerStartingToast() }
      else if (message.includes("network") || message.includes("fetch")) { showServerOverwhelmedToast() }
      else {
        reportActions.stage({
          shortMessage: message,
          details: error instanceof DownloadError ? error.details : undefined,
          category: error instanceof DownloadError ? error.category : undefined,
          platform: "tiktok",
          downloadType: "video",
          videoUrl: url
        })
        showDownloadErrorToast("Download failed", message)
      }
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <SimpleVideoDownloadCard
      videoInfo={tikTokInfo}
      subtitle="Best available quality, saved as MP4. No watermark."
      isDownloading={isDownloading}
      onDownload={handleDownload}
      className={className}
    />
  )
}
