import type { QualityTier } from "@/lib/api"
import { formatFileSize } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Video } from "lucide-react"
import { useEffect } from "react"
import { SelectionDropdown } from "./SelectionDropdown"

interface VideoQualityDropdownProps {
  tiers: QualityTier[]
  isVisible: boolean
  className?: string
  onOpenChange?: (isOpen: boolean) => void
}

// the untouched case has to produce a file that plays everywhere, so the
// default is the highest tier that really is an mp4 - 4K is one click away and
// labelled MKV. a source with no mp4 at all falls back to its best row.
function defaultTier(tiers: QualityTier[]): QualityTier | null {
  return tiers.find((tier) => tier.container === "mp4") || tiers[0] || null
}

const tierLabel = (tier: QualityTier) => `${tier.height}p`

/**
 * everything after the height: the container the row promises, the frame rate
 * when it is worth knowing, and the size - which is simply absent when yt-dlp
 * did not report one, rather than shown as 0 MB
 */
function tierDetail(tier: QualityTier): string {
  const parts = [tier.container.toUpperCase()]

  if (tier.fps && tier.fps > 30) {
    parts.push(`${tier.fps}fps`)
  }

  if (tier.filesize) {
    parts.push(formatFileSize(tier.filesize))
  }

  return parts.join(" · ")
}

export function VideoQualityDropdown({
  tiers,
  isVisible,
  className,
  onOpenChange
}: VideoQualityDropdownProps) {
  const { selectedTier, setSelectedTier } = useYouTubeStore()

  // the selection has to be a row of *this* menu, by identity and not by a
  // matching height: a tier object from the last video would otherwise keep
  // displaying that video's size, fps and container next to this one's heights
  useEffect(() => {
    if (selectedTier && tiers.includes(selectedTier)) {
      return
    }

    setSelectedTier(defaultTier(tiers))
  }, [tiers, selectedTier, setSelectedTier])

  if (!isVisible) return null

  return (
    <SelectionDropdown
      icon={Video}
      heading="Video Quality"
      placeholder="Select video quality..."
      options={tiers}
      selected={selectedTier}
      onSelect={setSelectedTier}
      optionKey={(tier) => `${tier.height}-${tier.container}`}
      renderLabel={tierLabel}
      renderDetail={tierDetail}
      onOpenChange={onOpenChange}
      className={className}
      emptyState={
        <div
          className={cn(
            "p-4 rounded-xl border-2 transition-all duration-200",
            "dark:bg-slate-800/40 dark:border-slate-700/50",
            "bg-slate-50/80 border-slate-300/50 backdrop-blur-sm"
          )}
        >
          <p className="text-sm text-slate-600 dark:text-slate-400">
            This link has no video streams to download — only audio. The Audio
            Only tab still works.
          </p>
        </div>
      }
      footer={
        selectedTier && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-sm text-slate-600 dark:text-slate-400"
          >
            Selected:{" "}
            <span className="font-medium text-slate-900 dark:text-white">
              {tierLabel(selectedTier)} {selectedTier.container.toUpperCase()}
            </span>
            <span className="text-slate-500 dark:text-slate-500">
              {" "}
              + best audio
            </span>
          </motion.div>
        )
      }
    />
  )
}
