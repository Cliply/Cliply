import { Button } from "@/components/ui/button"
import type { VideoFormat, VideoQualityOption } from "@/lib/api"
import { getVideoQualityOptions, selectBestAudioFormat } from "@/lib/api"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Check, ChevronDown, Headphones, Video } from "lucide-react"
import { useState } from "react"

interface VideoQualityDropdownProps {
  videoFormats: VideoFormat[]
  audioFormats: VideoFormat[]
  isVisible: boolean
  className?: string
  onOpenChange?: (isOpen: boolean) => void
}

export function VideoQualityDropdown({
  videoFormats,
  audioFormats,
  isVisible,
  className,
  onOpenChange
}: VideoQualityDropdownProps) {
  const { selectedVideoQuality, setSelectedVideoQuality } = useAppStore()
  const [isOpen, setIsOpen] = useState(false)

  if (!isVisible) return null

  const qualityOptions = getVideoQualityOptions(videoFormats)
  const bestAudioFormat = selectBestAudioFormat(audioFormats)

  const handleQualitySelect = (option: VideoQualityOption) => {
    setSelectedVideoQuality(option)
    setIsOpen(false)
    onOpenChange?.(false)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, y: -20, height: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn("space-y-4", "font-space-grotesk", className)}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <Video className="h-5 w-5 text-slate-600 dark:text-slate-400" />
        <h3 className="font-medium text-slate-900 dark:text-white">
          Video Quality
        </h3>
      </div>

      {/* Dropdown */}
      <div className="relative">
        <Button
          variant="outline"
          onClick={() => {
            const newIsOpen = !isOpen
            setIsOpen(newIsOpen)
            onOpenChange?.(newIsOpen)
          }}
          className={cn(
            "w-full justify-between h-auto p-4 text-left",
            "border-2 rounded-xl transition-all duration-200",
            // Dark mode styles
            "dark:bg-slate-800/60 dark:border-slate-700/50 dark:hover:border-slate-600",
            // Light mode styles
            "bg-white/80 border-slate-300/50 hover:border-slate-400",
            // Common styles
            "backdrop-blur-sm shadow-lg",
            isOpen && "border-slate-400 dark:border-slate-600"
          )}
        >
          <div className="flex-1">
            {selectedVideoQuality ? (
              <div className="flex items-center justify-between">
                <p className="font-medium text-slate-900 dark:text-white">
                  {selectedVideoQuality.label}
                </p>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {selectedVideoQuality.format.ext.toUpperCase()} • video only
                </p>
              </div>
            ) : (
              <p className="text-slate-500 dark:text-slate-400">
                Select video quality...
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

        {/* Dropdown Options */}
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "absolute top-full left-0 right-0 mt-2 z-[70]",
              "border-2 rounded-xl overflow-hidden",
              // Dark mode styles
              "dark:bg-slate-800/95 dark:border-slate-700/50 dark:backdrop-blur-xl",
              // Light mode styles
              "bg-white/95 border-slate-300/50 backdrop-blur-xl",
              // Common styles
              "shadow-2xl max-h-80"
            )}
          >
            <div className="max-h-80 overflow-y-auto overscroll-contain">
              {qualityOptions.map((option) => (
                <button
                  key={option.format.format_id}
                  onClick={() => handleQualitySelect(option)}
                  className={cn(
                    "w-full p-4 text-left transition-all duration-200",
                    "hover:bg-slate-100/80 dark:hover:bg-slate-700/50",
                    "border-b border-slate-200/50 dark:border-slate-700/50 last:border-b-0",
                    selectedVideoQuality?.format.format_id ===
                      option.format.format_id &&
                      "bg-blue-50 dark:bg-blue-950/20 border-blue-500/20"
                  )}
                >
                  <div className="flex justify-between items-center">
                    <p className="font-medium text-slate-900 dark:text-white">
                      {option.label}
                    </p>
                    <div className="flex items-center gap-3">
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        {option.format.ext.toUpperCase()} • video only
                      </p>
                      {selectedVideoQuality?.format.format_id ===
                        option.format.format_id && (
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

      {/* Audio Pairing Info */}
      {selectedVideoQuality && bestAudioFormat && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={cn(
            "p-3 rounded-xl border transition-all duration-200",
            // Dark mode styles
            "dark:bg-slate-800/40 dark:border-slate-700/50",
            // Light mode styles
            "bg-slate-50/80 border-slate-300/50",
            // Common styles
            "backdrop-blur-sm"
          )}
        >
          <div className="flex items-center gap-2 mb-2">
            <Headphones className="h-4 w-4 text-slate-500 dark:text-slate-500" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Auto-selected Audio
            </p>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {bestAudioFormat.quality} {bestAudioFormat.ext.toUpperCase()}
          </p>
        </motion.div>
      )}

      {/* Quality Description */}
      {selectedVideoQuality && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-sm text-slate-600 dark:text-slate-400"
        >
          Selected:{" "}
          <span className="font-medium text-slate-900 dark:text-white">
            {selectedVideoQuality.label}{" "}
            {selectedVideoQuality.format.ext.toUpperCase()}
          </span>
          <span className="text-slate-500 dark:text-slate-500">
            {" "}
            + best audio
          </span>
        </motion.div>
      )}
    </motion.div>
  )
}
