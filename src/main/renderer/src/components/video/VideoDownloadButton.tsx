import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import {
  formatDuration,
  selectBestAudioFormat,
  validateTimeRange,
  type VideoFormat
} from "@/lib/api"
import { useVideoDownload } from "@/lib/hooks/useVideoDownload"
import { useAppStore } from "@/lib/store"
import { showDownloadSuccessToast } from "@/lib/toast-utils"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Headphones, Scissors, Video } from "lucide-react"
import { toast } from "sonner"

interface VideoDownloadButtonProps {
  maxDuration: number
  audioFormats: VideoFormat[]
  isVisible: boolean
  className?: string
}

export function VideoDownloadButton({
  maxDuration,
  audioFormats,
  isVisible,
  className
}: VideoDownloadButtonProps) {
  const {
    url,
    videoTimeRange,
    selectedVideoQuality,
    setIsDownloadingVideo,
    videoPreciseCut,
    setVideoPreciseCut
  } = useAppStore()

  const videoDownloadMutation = useVideoDownload()

  const bestAudioFormat = selectBestAudioFormat(audioFormats)
  const selectedDuration = videoTimeRange.end - videoTimeRange.start


  if (!isVisible || !selectedVideoQuality) return null

  const isValidRange = validateTimeRange(
    videoTimeRange.start,
    videoTimeRange.end,
    maxDuration
  ).isValid

  const handleDownload = async () => {
    if (!selectedVideoQuality || !bestAudioFormat || !isValidRange) return

    // Prevent multiple downloads
    if (videoDownloadMutation.isPending) return

    try {
      setIsDownloadingVideo(true)

      await videoDownloadMutation.mutateAsync({
        url,
        video_format_id: selectedVideoQuality.format.format_id,
        audio_format_id: bestAudioFormat.format_id,
        time_range: videoTimeRange,
        precise_cut: videoPreciseCut
      })

      showDownloadSuccessToast("video")
    } catch (error) {
      console.error("Video download error:", error)

      toast.error("Download failed", {
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred"
      })
    } finally {
      setIsDownloadingVideo(false)
    }
  }

  // Check if user is downloading a specific segment (not full video)
  const isSegmentDownload =
    videoTimeRange.start !== 0 || videoTimeRange.end !== maxDuration

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, y: -20, height: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn("space-y-4", "font-space-grotesk", className)}
    >
      {/* Download Summary Card */}
      <div
        className={cn(
          "p-4 rounded-xl border-2 transition-all duration-200",
          // Dark mode styles
          "dark:bg-slate-800/60 dark:border-slate-700/50",
          // Light mode styles
          "bg-white/80 border-slate-300/50",
          // Common styles
          "backdrop-blur-sm shadow-lg"
        )}
      >
        <div className="space-y-3">
          {/* Video Quality */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Video className="h-4 w-4 text-slate-500 dark:text-slate-500" />
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Video Quality:
              </span>
            </div>
            <span className="font-medium text-slate-900 dark:text-white">
              {selectedVideoQuality.label}{" "}
              {selectedVideoQuality.format.ext.toUpperCase()}
            </span>
          </div>

          {/* Auto-selected Audio */}
          {bestAudioFormat && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Headphones className="h-4 w-4 text-slate-500 dark:text-slate-500" />
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  Audio Track:
                </span>
              </div>
              <span className="font-medium text-slate-900 dark:text-white">
                {bestAudioFormat.quality} {bestAudioFormat.ext.toUpperCase()}
              </span>
            </div>
          )}

          {/* Duration */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600 dark:text-slate-400">
              Duration:
            </span>
            <span className="font-medium text-slate-900 dark:text-white">
              {formatDuration(selectedDuration)}
            </span>
          </div>

          {/* Time Range */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600 dark:text-slate-400">
              Time Range:
            </span>
            <span className="font-medium text-slate-900 dark:text-white">
              {Math.floor(videoTimeRange.start / 60)}:
              {(videoTimeRange.start % 60).toString().padStart(2, "0")} -{" "}
              {Math.floor(videoTimeRange.end / 60)}:
              {(videoTimeRange.end % 60).toString().padStart(2, "0")}
            </span>
          </div>

          {/* Precise Cut Toggle - Only show for segment downloads */}
          {isSegmentDownload && (
            <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-700">
              <div className="flex items-center gap-2">
                <Scissors className="h-4 w-4 text-slate-500 dark:text-slate-500" />
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  Precise Cut:
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setVideoPreciseCut(!videoPreciseCut)}
                    className={cn(
                      "h-8 px-3 text-xs transition-all duration-200",
                      videoPreciseCut
                        ? "bg-cyan-100 border-cyan-300 text-cyan-700 hover:bg-cyan-200 dark:bg-cyan-900 dark:border-cyan-700 dark:text-cyan-300 dark:hover:bg-cyan-800"
                        : "hover:bg-slate-100 dark:hover:bg-slate-700"
                    )}
                  >
                    {videoPreciseCut ? "Enabled" : "Disabled"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  <p>Turn off for faster download but less precise cuts</p>
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>

      {/* Download Button */}
      <Button
        onClick={handleDownload}
        disabled={videoDownloadMutation.isPending}
        className={cn(
          "w-full h-14 text-lg font-semibold rounded-xl transition-all duration-200",
          "bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700",
          // Disabled states
          "disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
        )}
      >
        {videoDownloadMutation.isPending ? (
          <>
            <span className="animate-pulse">Downloading...</span>
          </>
        ) : (
          "Download Video"
        )}
      </Button>

      {/* Download Progress */}
      {videoDownloadMutation.isPending && (
        <div className="text-xs text-slate-500 dark:text-slate-500 text-center">
          Processing your video download...
        </div>
      )}

      {/* Helper Text */}
      {!videoDownloadMutation.isPending && (
        <div className="text-xs text-slate-500 dark:text-slate-500 text-center">
          Video and audio will be merged automatically
        </div>
      )}
    </motion.div>
  )
}
