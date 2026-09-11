import { SelectionDropdown } from "@/components/video/SelectionDropdown"
import { useT } from "@/lib/i18n"
import { usePlaylistStore } from "@/lib/stores/playlistStore"
import {
  ceilingFor,
  ceilingHelperText,
  ceilingLabel,
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
  const t = useT()

  // no defaulting effect, unlike the video menu: these six rows are the same
  // for every playlist, so there is never a selection this menu cannot offer
  const selected = ceilingFor(selectedCeiling)

  return (
    <SelectionDropdown
      icon={Video}
      heading={t("playlist.qualityHeading")}
      placeholder={t("playlist.qualityPlaceholder")}
      options={PLAYLIST_CEILINGS}
      selected={selected}
      onSelect={(option) => setSelectedCeiling(option.height)}
      optionKey={(option) => `res-${option.height}`}
      renderLabel={(option) => ceilingLabel(option.limit)}
      // the container is the same word in both languages
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
              {t("dropdown.selected")}{" "}
              <span className="font-medium text-slate-900 dark:text-white">
                {ceilingLabel(selected.limit)} MP4
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
