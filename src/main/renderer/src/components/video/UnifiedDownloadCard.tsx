import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { validateTimeRange, type VideoFormat } from "@/lib/api"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { useState } from "react"
import { AudioDownloadButton } from "./AudioDownloadButton"
import { AudioFormatDropdown } from "./AudioFormatDropdown"
import { TimeRangeSelector } from "./TimeRangeSelector"
import { VideoDownloadButton } from "./VideoDownloadButton"
import { VideoQualityDropdown } from "./VideoQualityDropdown"
import { VideoTimeRangeSelector } from "./VideoTimeRangeSelector"

interface UnifiedDownloadCardProps {
  videoInfo: {
    duration: number
    video_formats: VideoFormat[]
    audio_formats: VideoFormat[]
  }
  className?: string
}

export function UnifiedDownloadCard({
  videoInfo,
  className
}: UnifiedDownloadCardProps) {
  const {
    audioTimeRange,
    selectedAudioFormatForDownload,
    videoTimeRange,
    selectedVideoQuality
  } = useAppStore()

  const [isVideoQualityDropdownOpen, setIsVideoQualityDropdownOpen] =
    useState(false)
  const [activeTab, setActiveTab] = useState("video")

  const isValidAudioTimeRange = validateTimeRange(
    audioTimeRange.start,
    audioTimeRange.end,
    videoInfo.duration
  ).isValid

  const showAudioFormatDropdown = isValidAudioTimeRange
  const showAudioDownloadButton = showAudioFormatDropdown && !!selectedAudioFormatForDownload

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
        // Dark mode styles
        "dark:bg-slate-800/40 dark:border-slate-700/50 dark:backdrop-blur-sm",
        // Light mode styles
        "bg-white/60 border-slate-300/50 backdrop-blur-sm",
        // Common styles
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
