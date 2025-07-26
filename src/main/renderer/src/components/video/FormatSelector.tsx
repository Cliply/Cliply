import { Button } from "@/components/ui/button"
import type { VideoFormat } from "@/lib/api"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Download, Headphones, Video } from "lucide-react"

interface FormatSelectorProps {
  videoFormats: VideoFormat[]
  audioFormats: VideoFormat[]
  className?: string
}

export function FormatSelector({
  videoFormats,
  audioFormats,
  className
}: FormatSelectorProps) {
  const {
    selectedVideoFormat,
    selectedAudioFormat,
    setSelectedVideoFormat,
    setSelectedAudioFormat
  } = useAppStore()

  const handleDownload = () => {
    // TODO: Implement download functionality in next phase
    console.log("Download:", { selectedVideoFormat, selectedAudioFormat })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className={cn("space-y-6", className)}
    >
      {/* Video Quality Selection */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Video className="h-5 w-5 text-slate-600 dark:text-slate-400" />
          <h3 className="font-medium text-slate-900 dark:text-white">
            Video Quality
          </h3>
        </div>

        <div className="space-y-2">
          {videoFormats.map((format) => (
            <button
              key={format.format_id}
              onClick={() => setSelectedVideoFormat(format)}
              className={cn(
                "w-full p-3 rounded-xl border-2 text-left transition-all duration-200",
                "hover:border-slate-400 dark:hover:border-slate-500",
                selectedVideoFormat?.format_id === format.format_id
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20"
                  : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
              )}
            >
              <div className="flex justify-between items-center">
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">
                    {format.quality}
                  </p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {format.ext.toUpperCase()}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Audio Quality Selection */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Headphones className="h-5 w-5 text-slate-600 dark:text-slate-400" />
          <h3 className="font-medium text-slate-900 dark:text-white">
            Audio Quality
          </h3>
        </div>

        <div className="space-y-2">
          {audioFormats.map((format) => (
            <button
              key={format.format_id}
              onClick={() => setSelectedAudioFormat(format)}
              className={cn(
                "w-full p-3 rounded-xl border-2 text-left transition-all duration-200",
                "hover:border-slate-400 dark:hover:border-slate-500",
                selectedAudioFormat?.format_id === format.format_id
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20"
                  : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
              )}
            >
              <div className="flex justify-between items-center">
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">
                    {format.quality}
                  </p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {format.ext.toUpperCase()}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Download Button */}
      <Button
        onClick={handleDownload}
        disabled={!selectedVideoFormat && !selectedAudioFormat}
        className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl"
      >
        <Download className="h-5 w-5 mr-2" />
        Download Selected
      </Button>
    </motion.div>
  )
}
