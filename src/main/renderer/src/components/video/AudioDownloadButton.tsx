import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { formatDuration, validateTimeRange } from "@/lib/api"
import { useAudioDownload } from "@/lib/hooks/useAudioDownload"
import { useServerStatus } from "@/lib/hooks/useServerStatus"
import { useAppStore } from "@/lib/store"
import {
  showDownloadSuccessToast,
  showServerOverwhelmedToast,
  showServerStartingToast
} from "@/lib/toast-utils"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Scissors } from "lucide-react"
import { toast } from "sonner"

interface AudioDownloadButtonProps {
  isVisible: boolean
  maxDuration: number
  className?: string
}

export function AudioDownloadButton({
  isVisible,
  maxDuration,
  className
}: AudioDownloadButtonProps) {
  const {
    url,
    audioTimeRange,
    setIsDownloadingAudio,
    selectedAudioFormatForDownload,
    audioPreciseCut,
    setAudioPreciseCut
  } = useAppStore()

  const audioDownloadMutation = useAudioDownload()
  const serverStatus = useServerStatus()

  const selectedDuration = audioTimeRange.end - audioTimeRange.start


  if (!isVisible) return null

  const isValidRange = validateTimeRange(
    audioTimeRange.start,
    audioTimeRange.end,
    maxDuration
  ).isValid

  const handleDownload = async () => {
    if (!selectedAudioFormatForDownload || !isValidRange) return

    // Prevent multiple downloads
    if (audioDownloadMutation.isPending) return

    // Check server status before attempting download
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
      setIsDownloadingAudio(true)

      await audioDownloadMutation.mutateAsync({
        url,
        format_id: selectedAudioFormatForDownload.format_id,
        time_range: audioTimeRange,
        precise_cut: audioPreciseCut
      })

      showDownloadSuccessToast("audio")
    } catch (error) {
      console.error("Download error:", error)

      const errorMessage =
        error instanceof Error ? error.message : "Download failed"

      if (errorMessage.includes("Invalid time range")) {
        toast.error(
          "Invalid time range. Please check your start and end times."
        )
      } else if (errorMessage.includes("Format not available")) {
        toast.error("Selected audio format is not available.")
      } else if (errorMessage.includes("Download engine starting")) {
        showServerStartingToast()
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("fetch")
      ) {
        showServerOverwhelmedToast()
      } else {
        toast.error("Download failed. Please try again.")
      }
    } finally {
      setIsDownloadingAudio(false)
    }
  }

  // Check if user is downloading a specific segment (not full audio)
  const isSegmentDownload =
    audioTimeRange.start !== 0 || audioTimeRange.end !== maxDuration

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, y: -20, height: 0 }}
      transition={{ duration: 0.3, ease: "easeOut", delay: 0.1 }}
      className={cn("space-y-4", "font-space-grotesk", className)}
    >
      {/* Download Summary */}
      <div
        className={cn(
          "p-4 rounded-xl border transition-all duration-200",
          // Dark mode styles
          "dark:bg-slate-800/40 dark:border-slate-700/50",
          // Light mode styles
          "bg-slate-50/80 border-slate-300/50",
          // Common styles
          "backdrop-blur-sm"
        )}
      >
        <h4 className="font-medium text-slate-900 dark:text-white mb-2">
          Download Summary
        </h4>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-600 dark:text-slate-400">
              Duration:
            </span>
            <span className="font-medium text-slate-900 dark:text-white">
              {formatDuration(selectedDuration)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-600 dark:text-slate-400">Format:</span>
            <span className="font-medium text-slate-900 dark:text-white">
              {selectedAudioFormatForDownload?.quality}{" "}
              {selectedAudioFormatForDownload?.ext.toUpperCase()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-600 dark:text-slate-400">
              Time Range:
            </span>
            <span className="font-medium text-slate-900 dark:text-white">
              {Math.floor(audioTimeRange.start / 60)}:
              {(audioTimeRange.start % 60).toString().padStart(2, "0")} -{" "}
              {Math.floor(audioTimeRange.end / 60)}:
              {(audioTimeRange.end % 60).toString().padStart(2, "0")}
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
                    onClick={() => setAudioPreciseCut(!audioPreciseCut)}
                    className={cn(
                      "h-8 px-3 text-xs transition-all duration-200",
                      audioPreciseCut
                        ? "bg-cyan-100 border-cyan-300 text-cyan-700 hover:bg-cyan-200 dark:bg-cyan-900 dark:border-cyan-700 dark:text-cyan-300 dark:hover:bg-cyan-800"
                        : "hover:bg-slate-100 dark:hover:bg-slate-700"
                    )}
                  >
                    {audioPreciseCut ? "Enabled" : "Disabled"}
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
        disabled={audioDownloadMutation.isPending}
        className={cn(
          "w-full h-14 text-lg font-semibold rounded-xl transition-all duration-200",
          "bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700",
          // Disabled states
          "disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
        )}
      >
        {audioDownloadMutation.isPending ? (
          <>
            <span className="animate-pulse">Downloading...</span>
          </>
        ) : (
          "Download Audio"
        )}
      </Button>

      {/* Helper Text */}
      <div className="text-xs text-slate-500 dark:text-slate-500 text-center">
        Audio will be downloaded with the selected time range and format
      </div>
    </motion.div>
  )
}
