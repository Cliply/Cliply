import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SIMPLE_QUALITY, track } from "@/lib/analytics"
import {
  DownloadError,
  pinterestApi,
  tiktokApi,
  systemApi,
  validateTimeRange,
  type AudioTrack,
  type PinterestVideoInfoResponse,
  type QualityTier,
  type TikTokVideoInfoResponse,
  type TranscriptTrack
} from "@/lib/api"
import { reportActions } from "@/lib/reportStore"
import { usePinterestStore } from "@/lib/pinterestStore"
import { useTikTokStore } from "@/lib/tiktokStore"
import { useYouTubeStore } from "@/lib/youtubeStore"
import {
  showDownloadErrorToast,
  showServerOverwhelmedToast
} from "@/lib/toast-utils"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { useState } from "react"
import { toast } from "sonner"
import { AudioDownloadButton } from "./AudioDownloadButton"
import { AudioFormatDropdown } from "./AudioFormatDropdown"
import { AudioTrackDropdown } from "./AudioTrackDropdown"
import { TimeRangeSelector } from "./TimeRangeSelector"
import { TranscriptDownloadButton } from "./TranscriptDownloadButton"
import { TranscriptFormatDropdown } from "./TranscriptFormatDropdown"
import { TranscriptLanguageDropdown } from "./TranscriptLanguageDropdown"
import { VideoDownloadButton } from "./VideoDownloadButton"
import { VideoQualityDropdown } from "./VideoQualityDropdown"
import { VideoTimeRangeSelector } from "./VideoTimeRangeSelector"

type YouTubeDownloadCardProps = {
  platform?: "youtube"
  videoInfo: {
    duration: number
    quality_tiers: QualityTier[]
    audio_tracks?: AudioTrack[]
    transcripts?: TranscriptTrack[]
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
    quality_tiers: QualityTier[]
    audio_tracks?: AudioTrack[]
    transcripts?: TranscriptTrack[]
  }
  className?: string
}) {
  const { audioTimeRange, selectedAudioMode, videoTimeRange, selectedTier } =
    useYouTubeStore()

  const [isVideoQualityDropdownOpen, setIsVideoQualityDropdownOpen] =
    useState(false)
  const [activeTab, setActiveTab] = useState("video")

  const isValidAudioTimeRange = validateTimeRange(
    audioTimeRange.start,
    audioTimeRange.end,
    videoInfo.duration
  ).isValid

  const showAudioFormatDropdown = isValidAudioTimeRange
  const showAudioDownloadButton = showAudioFormatDropdown && !!selectedAudioMode

  const isValidVideoTimeRange = validateTimeRange(
    videoTimeRange.start,
    videoTimeRange.end,
    videoInfo.duration
  ).isValid

  const showVideoQualityDropdown = isValidVideoTimeRange
  const showVideoDownloadButton = showVideoQualityDropdown && !!selectedTier

  const audioTracks = videoInfo.audio_tracks ?? []

  // optional so an older main process (or a fixture written before the field
  // existed) renders the tab empty rather than crashing on a missing array
  const transcripts = videoInfo.transcripts ?? []

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
          <TabsList className="grid w-full grid-cols-3 bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200/50 dark:border-slate-700/50">
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
            <TabsTrigger
              value="transcript"
              className="flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:shadow-sm dark:data-[state=active]:bg-slate-700 dark:data-[state=active]:border-slate-600 transition-all duration-200"
            >
              📝 Transcript
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
                tiers={videoInfo.quality_tiers}
                isVisible={showVideoQualityDropdown}
                onOpenChange={setIsVideoQualityDropdownOpen}
              />

              {/* no video to download means no language to pick for it - the
                  audio tab still offers the choice */}
              <AudioTrackDropdown
                tracks={audioTracks}
                isVisible={showVideoQualityDropdown && !!selectedTier}
              />

              <VideoDownloadButton
                maxDuration={videoInfo.duration}
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

              <AudioFormatDropdown isVisible={showAudioFormatDropdown} />

              <AudioTrackDropdown
                tracks={audioTracks}
                isVisible={showAudioFormatDropdown}
              />

              <AudioDownloadButton
                maxDuration={videoInfo.duration}
                isVisible={showAudioDownloadButton}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="transcript" className="p-6 pt-4 m-0">
          <div className="space-y-4">
            <div className="mb-6">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Save the subtitles or captions as a file
              </p>
            </div>

            {/* no time range here on purpose: yt-dlp writes a subtitle track
                whole, and trimming one is a text edit rather than a download */}
            <div className="space-y-6">
              <TranscriptLanguageDropdown tracks={transcripts} />

              <TranscriptFormatDropdown isVisible={transcripts.length > 0} />

              <TranscriptDownloadButton
                tracks={transcripts}
                isVisible={transcripts.length > 0}
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

  const handleDownload = async () => {
    if (!url || isDownloading) return
    try {
      setIsDownloading(true)

      // main reports this download's end, so it has to hear about its start:
      // completions with no starts is a funnel that shows the impossible
      track("download_started", {
        platform: "pinterest",
        media_type: "video",
        quality: SIMPLE_QUALITY,
        // there is no trimming here to report - no range is ever sent
        is_trimmed: false
      })

      await pinterestApi.download({ url, title: pinInfo?.title })
      toast.success("Download complete!", { action: { label: "Open Folder", onClick: () => systemApi.openDownloadFolder() } })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to download video"
      if (message.includes("network") || message.includes("fetch")) { showServerOverwhelmedToast() }
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

  const handleDownload = async () => {
    if (!url || isDownloading) return
    try {
      setIsDownloading(true)

      // as pinterest above: one button, one quality, never a range
      track("download_started", {
        platform: "tiktok",
        media_type: "video",
        quality: SIMPLE_QUALITY,
        is_trimmed: false
      })

      await tiktokApi.download({ url, title: tikTokInfo?.title })
      toast.success("Download complete!", { action: { label: "Open Folder", onClick: () => systemApi.openDownloadFolder() } })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to download video"
      if (message.includes("network") || message.includes("fetch")) { showServerOverwhelmedToast() }
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
