import { SelectionDropdown } from "@/components/video/SelectionDropdown"
import { usePlaylistStore } from "@/lib/playlistStore"
import {
  ceilingFor,
  ceilingHelperText,
  PLAYLIST_CEILINGS
} from "@/lib/playlistView"
import { motion } from "framer-motion"
import { Video } from "lucide-react"

interface PlaylistCeilingDropdownProps {
  className?: string
  onOpenChange?: (isOpen: boolean) => void
}

/**
 * one quality instruction for the whole playlist
 *
 * a fixed ceiling rather than a derived menu, because a flat listing carries
 * no formats to derive one from. see `PLAYLIST_CEILINGS` for why that is the
 * honest answer rather than the cheap one.
 */
export function PlaylistCeilingDropdown({
  className,
  onOpenChange
}: PlaylistCeilingDropdownProps) {
  const { selectedCeiling, setSelectedCeiling } = usePlaylistStore()

  // no defaulting effect, unlike the video menu: these six rows are the same
  // for every playlist, so there is never a selection this menu cannot offer
  const selected = ceilingFor(selectedCeiling)

  return (
    <SelectionDropdown
      icon={Video}
      heading="Quality"
      placeholder="Select a quality limit..."
      options={PLAYLIST_CEILINGS}
      selected={selected}
      onSelect={(option) => setSelectedCeiling(option.height)}
      optionKey={(option) => `res-${option.height}`}
      renderLabel={(option) => option.label}
      renderDetail={() => "MP4"}
      onOpenChange={onOpenChange}
      className={className}
      footer={
        selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-2 text-sm text-slate-600 dark:text-slate-400"
          >
            <p>
              Selected:{" "}
              <span className="font-medium text-slate-900 dark:text-white">
                {selected.label} MP4
              </span>
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-500">
              {ceilingHelperText(selected.limit)}
            </p>
          </motion.div>
        )
      }
    />
  )
}
