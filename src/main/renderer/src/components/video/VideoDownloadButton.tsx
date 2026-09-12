import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import {
  formatDuration,
  formatFileSize,
  languageName,
  validateTimeRange
} from "@/lib/api"
import { useVideoDownload } from "@/lib/hooks/useVideoDownload"
import { useT } from "@/lib/i18n"
import { useYouTubeStore } from "@/lib/stores/youtubeStore"
import { cn } from "@/lib/utils"
import { DownloadProgressBar } from "./DownloadProgressBar"
import { motion } from "framer-motion"
import { useEffect } from "react"
import { Headphones, Scissors, Video } from "lucide-react"

interface VideoDownloadButtonProps {
  maxDuration: number
  isVisible: boolean
  className?: string
}

export function VideoDownloadButton({
  maxDuration,
  isVisible,
  className
}: VideoDownloadButtonProps) {
  const {
    url,
    videoInfo,
    videoTimeRange,
    selectedTier,
    selectedAudioLanguage,
    setIsDownloadingVideo,
    videoPreciseCut,
    setVideoPreciseCut
  } = useYouTubeStore()

  const videoDownloadMutation = useVideoDownload()
  const t = useT()

  // the store's flag keeps meaning what it always meant - a download this
  // screen started is still going - which is now a fact about the row rather
  // than about an awaited promise
  const { isDownloading, row } = videoDownloadMutation

  useEffect(() => {
    setIsDownloadingVideo(isDownloading)
  }, [isDownloading, setIsDownloadingVideo])

  const selectedDuration = videoTimeRange.end - videoTimeRange.start

  if (!isVisible || !selectedTier) return null

  const isValidRange = validateTimeRange(
    videoTimeRange.start,
    videoTimeRange.end,
    maxDuration
  ).isValid

  // Check if user is downloading a specific segment (not full video)
  const isSegmentDownload =
    videoTimeRange.start !== 0 || videoTimeRange.end !== maxDuration

  const handleDownload = async () => {
    if (!selectedTier || !isValidRange) return

    // Prevent multiple downloads
    if (videoDownloadMutation.isPending) return

    try {
      await videoDownloadMutation.mutateAsync({
        url,
        height: selectedTier.height,
        // the container we displayed, so the label cannot disagree with the file
        container: selectedTier.container,
        // absent unless this video really offered a choice of dubs
        ...(selectedAudioLanguage
          ? { audio_language: selectedAudioLanguage }
          : {}),
        time_range: isSegmentDownload ? videoTimeRange : undefined,
        precise_cut: videoPreciseCut,
        title: videoInfo?.title || "video"
      })

      // this resolves at main's acknowledgement now, not at the end of the
      // download: the outcome - toast, staged report, the row settling - is
      // DownloadEvents' to report, from anywhere in the app
    } catch (error) {
      // the hook's onError has already toasted and staged this refusal
      console.error("Video download error:", error)
    }
  }

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
                {t("card.videoQuality")}
              </span>
            </div>
            <span className="font-medium text-slate-900 dark:text-white">
              {selectedTier.height}p {selectedTier.container.toUpperCase()}
            </span>
          </div>

          {/* Audio comes with it: yt-dlp merges the best track it can find,
              unless this video carries dubs and the user picked one */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Headphones className="h-4 w-4 text-slate-500 dark:text-slate-500" />
              <span className="text-sm text-slate-600 dark:text-slate-400">
                {t("card.audioTrack")}
              </span>
            </div>
            <span className="font-medium text-slate-900 dark:text-white">
              {selectedAudioLanguage
                ? languageName(selectedAudioLanguage)
                : t("card.bestAvailable")}
            </span>
          </div>

          {/* Size, when the video reported one for this tier - a segment costs
              some unknown fraction of it, so it is only shown for a full one */}
          {!isSegmentDownload && selectedTier.filesize && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600 dark:text-slate-400">
                {t("card.size")}
              </span>
              <span className="font-medium text-slate-900 dark:text-white">
                {formatFileSize(selectedTier.filesize)}
              </span>
            </div>
          )}

          {/* Duration */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600 dark:text-slate-400">
              {t("card.duration")}
            </span>
            <span className="font-medium text-slate-900 dark:text-white">
              {formatDuration(selectedDuration)}
            </span>
          </div>

          {/* Time Range */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600 dark:text-slate-400">
              {t("card.timeRange")}
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
                  {t("card.preciseCut")}
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
                    {videoPreciseCut ? t("card.enabled") : t("card.disabled")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  <p>{t("card.preciseCutHint")}</p>
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
            <span className="animate-pulse">{t("download.inProgress")}</span>
          </>
        ) : (
          t("download.video")
        )}
      </Button>

      {/* Download Progress: the row this screen started, for as long as it is
          live. it settles out of view and the toast and the panel carry the
          outcome from there */}
      {isDownloading && row && (
        <DownloadProgressBar
          state={row}
          label={t("media.video")}
          onCancel={videoDownloadMutation.cancelDownload}
        />
      )}

      {/* Helper Text */}
      {!isDownloading && (
        <div className="text-xs text-slate-500 dark:text-slate-500 text-center">
          {t("download.mergeHint")}
        </div>
      )}
    </motion.div>
  )
}
