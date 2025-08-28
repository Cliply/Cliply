import { Button } from "@/components/ui/button"
import type { VideoFormat } from "@/lib/api"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Check, ChevronDown, Headphones } from "lucide-react"
import { useState } from "react"

interface AudioFormatDropdownProps {
  audioFormats: VideoFormat[]
  isVisible: boolean
  className?: string
}

export function AudioFormatDropdown({
  audioFormats,
  isVisible,
  className
}: AudioFormatDropdownProps) {
  const { selectedAudioFormatForDownload, setSelectedAudioFormatForDownload } =
    useAppStore()
  const [isOpen, setIsOpen] = useState(false)

  if (!isVisible) return null

  const handleFormatSelect = (format: VideoFormat) => {
    setSelectedAudioFormatForDownload(format)
    setIsOpen(false)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, y: -20, height: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn("space-y-4", "font-space-grotesk", className)}
    >
      <div className="flex items-center gap-2">
        <Headphones className="h-5 w-5 text-slate-600 dark:text-slate-400" />
        <h3 className="font-medium text-slate-900 dark:text-white">
          Audio Format
        </h3>
      </div>

      <div className="relative">
        <Button
          variant="outline"
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            "w-full justify-between h-auto p-4 text-left",
            "border-2 rounded-xl transition-all duration-200",
            "dark:bg-slate-800/60 dark:border-slate-700/50 dark:hover:border-slate-600",
            "bg-white/80 border-slate-300/50 hover:border-slate-400",
            "backdrop-blur-sm shadow-lg",
            isOpen && "border-slate-400 dark:border-slate-600"
          )}
        >
          <div className="flex-1">
            {selectedAudioFormatForDownload ? (
              <div className="flex items-center justify-between">
                <p className="font-medium text-slate-900 dark:text-white">
                  {selectedAudioFormatForDownload.quality}
                </p>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {selectedAudioFormatForDownload.ext.toUpperCase()}
                </p>
              </div>
            ) : (
              <p className="text-slate-500 dark:text-slate-400">
                Select audio format...
              </p>
            )}
          </div>
          <ChevronDown
            className={cn(
              "h-5 w-5 text-slate-500 transition-transform duration-200",
              isOpen && "rotate-180"
            )}
          />
        </Button>

        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "absolute top-full left-0 right-0 mt-2 z-[70]",
              "border-2 rounded-xl overflow-hidden",
              "dark:bg-slate-800/95 dark:border-slate-700/50 dark:backdrop-blur-xl",
              "bg-white/95 border-slate-300/50 backdrop-blur-xl",
              "shadow-2xl max-h-80"
            )}
          >
            <div className="max-h-80 overflow-y-auto overscroll-contain">
              {audioFormats.map((format) => (
                <button
                  key={format.format_id}
                  onClick={() => handleFormatSelect(format)}
                  className={cn(
                    "w-full p-4 text-left transition-all duration-200",
                    "hover:bg-slate-100/80 dark:hover:bg-slate-700/50",
                    "border-b border-slate-200/50 dark:border-slate-700/50 last:border-b-0",
                    selectedAudioFormatForDownload?.format_id ===
                      format.format_id &&
                      "bg-blue-50 dark:bg-blue-950/20 border-blue-500/20"
                  )}
                >
                  <div className="flex justify-between items-center">
                    <p className="font-medium text-slate-900 dark:text-white">
                      {format.quality}
                    </p>
                    <div className="flex items-center gap-3">
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        {format.ext.toUpperCase()}
                        {format.quality === "Auto" && " • recommended"}
                      </p>
                      {selectedAudioFormatForDownload?.format_id ===
                        format.format_id && (
                        <Check className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </div>

      {selectedAudioFormatForDownload && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-sm text-slate-600 dark:text-slate-400"
        >
          Selected:{" "}
          <span className="font-medium text-slate-900 dark:text-white">
            {selectedAudioFormatForDownload.quality}{" "}
            {selectedAudioFormatForDownload.ext.toUpperCase()}
          </span>
        </motion.div>
      )}
    </motion.div>
  )
}