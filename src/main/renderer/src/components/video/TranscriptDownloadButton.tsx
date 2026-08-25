import { Button } from "@/components/ui/button"
import { TRANSCRIPT_QUALITY, track } from "@/lib/analytics"
import {
  DownloadError,
  languageName,
  systemApi,
  transcriptApi,
  type TranscriptTrack
} from "@/lib/api"
import { reportActions } from "@/lib/reportStore"
import { showDownloadErrorToast } from "@/lib/toast-utils"
import { cn } from "@/lib/utils"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { motion } from "framer-motion"
import { Captions, FileText } from "lucide-react"
import { toast } from "sonner"

interface TranscriptDownloadButtonProps {
  tracks: TranscriptTrack[]
  isVisible: boolean
  className?: string
}

export function TranscriptDownloadButton({
  tracks,
  isVisible,
  className
}: TranscriptDownloadButtonProps) {
  const {
    url,
    videoInfo,
    selectedTranscript,
    selectedTranscriptFormat,
    isDownloadingTranscript,
    setIsDownloadingTranscript
  } = useYouTubeStore()

  const selected =
    tracks.find((item) => item.code === selectedTranscript) || null

  if (!isVisible || !selected) return null

  const handleDownload = async () => {
    if (isDownloadingTranscript) return

    try {
      setIsDownloadingTranscript(true)

      // main reports this download's end, so it has to hear about its start -
      // completions with no starts is a funnel that shows the impossible
      track("download_started", {
        platform: "youtube",
        media_type: "transcript",
        quality: TRANSCRIPT_QUALITY,
        transcript_format: selectedTranscriptFormat,
        // a transcript is the whole track; there is no range to send
        is_trimmed: false
      })

      const result = await transcriptApi.download({
        url,
        language: selected.code,
        is_auto: selected.is_auto,
        format: selectedTranscriptFormat,
        title: videoInfo?.title || "transcript"
      })

      toast.success("Transcript downloaded!", {
        description: result.filename
          ? `Saved: ${result.filename}`
          : undefined,
        action: {
          label: "Open Folder",
          onClick: () => systemApi.openDownloadFolder()
        }
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to download transcript"

      reportActions.stage({
        shortMessage: message,
        details: error instanceof DownloadError ? error.details : undefined,
        category: error instanceof DownloadError ? error.category : undefined,
        platform: "youtube",
        downloadType: "transcript",
        videoUrl: url
      })
      showDownloadErrorToast("Transcript download failed", message)
    } finally {
      setIsDownloadingTranscript(false)
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
      <div
        className={cn(
          "p-4 rounded-xl border-2 transition-all duration-200",
          "dark:bg-slate-800/60 dark:border-slate-700/50",
          "bg-white/80 border-slate-300/50",
          "backdrop-blur-sm shadow-lg"
        )}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Captions className="h-4 w-4 text-slate-500 dark:text-slate-500" />
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Language:
              </span>
            </div>
            <span className="font-medium text-slate-900 dark:text-white">
              {languageName(selected.code)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-slate-500 dark:text-slate-500" />
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Format:
              </span>
            </div>
            <span className="font-medium text-slate-900 dark:text-white">
              {selectedTranscriptFormat.toUpperCase()}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600 dark:text-slate-400">
              Source:
            </span>
            <span className="font-medium text-slate-900 dark:text-white">
              {selected.is_auto ? "Auto-generated" : "Uploader subtitles"}
            </span>
          </div>
        </div>
      </div>

      <Button
        onClick={handleDownload}
        disabled={isDownloadingTranscript}
        className={cn(
          "w-full h-14 text-lg font-semibold rounded-xl transition-all duration-200",
          "bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700",
          "disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
        )}
      >
        {isDownloadingTranscript ? (
          <span className="animate-pulse">Downloading...</span>
        ) : (
          "Download Transcript"
        )}
      </Button>

      {/* no progress bar: a transcript is a few hundred kilobytes and yt-dlp
          reports no progress for one, so a bar would be a spinner in disguise */}
      {!isDownloadingTranscript && (
        <div className="text-xs text-slate-500 dark:text-slate-500 text-center">
          {selected.is_auto
            ? "Automatic captions are machine-transcribed and may contain mistakes"
            : "Saved next to your other downloads"}
        </div>
      )}
    </motion.div>
  )
}
