import { motion } from "framer-motion"

import { usePinterestStore } from "@/lib/pinterestStore"
import { useAppStore, type Platform } from "@/lib/store"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { cn } from "@/lib/utils"

const platforms: Array<{ id: Platform; label: string }> = [
  { id: "youtube", label: "YouTube" },
  { id: "pinterest", label: "Pinterest" }
]

export function PlatformSelector() {
  const { selectedPlatform, setSelectedPlatform, setShowMediaDetails } = useAppStore()
  const resetYouTube = useYouTubeStore((state) => state.reset)
  const resetPinterest = usePinterestStore((state) => state.reset)

  const handleSelect = (platform: Platform) => {
    if (platform === selectedPlatform) {
      return
    }

    setSelectedPlatform(platform)
    resetYouTube()
    resetPinterest()
    setShowMediaDetails(false)
  }

  return (
    <div className="w-full flex justify-center">
      <div
        className={cn(
          "inline-flex items-center gap-1 rounded-xl border p-1 backdrop-blur-sm",
          "dark:bg-slate-800/60 dark:border-slate-700/60",
          "bg-white/90 border-slate-200/60"
        )}
      >
        {platforms.map((platform) => {
          const isActive = platform.id === selectedPlatform

          return (
            <button
              key={platform.id}
              type="button"
              onClick={() => handleSelect(platform.id)}
              className={cn(
                "relative h-8 px-3 rounded-lg text-xs font-mono transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40",
                isActive
                  ? "text-white dark:text-slate-900"
                  : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
              )}
              style={{
                fontFamily:
                  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
              }}
            >
              {isActive && (
                <motion.span
                  layoutId="platform-selector-pill"
                  className="absolute inset-0 rounded-lg bg-slate-900 dark:bg-slate-100"
                  transition={{ type: "spring", stiffness: 320, damping: 26 }}
                />
              )}
              <span className="relative z-10">{platform.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
