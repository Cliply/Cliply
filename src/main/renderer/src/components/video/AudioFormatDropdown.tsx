import type { AudioMode } from "@/lib/api"
import { useT, type Key } from "@/lib/i18n"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { motion } from "framer-motion"
import { Headphones } from "lucide-react"
import { SelectionDropdown } from "./SelectionDropdown"

/**
 * the three things yt-dlp can actually do with an audio track
 *
 * two conversions and the untouched stream - no quality ladder, because the
 * audio yt-dlp starts from is the best one the video has either way
 *
 * the rows are built once, at module load, so they carry translation keys
 * rather than words: the locale can change after that
 */
const AUDIO_MODES: {
  mode: AudioMode
  label: Key
  detail: Key
}[] = [
  { mode: "mp3", label: "format.mp3", detail: "format.mp3Detail" },
  { mode: "m4a", label: "format.m4a", detail: "format.m4aDetail" },
  {
    mode: "original",
    label: "dropdown.original",
    detail: "format.originalDetail"
  }
]

const optionFor = (mode: AudioMode) =>
  AUDIO_MODES.find((option) => option.mode === mode) || null

interface AudioFormatDropdownProps {
  isVisible: boolean
  className?: string
  /**
   * which store the menu is reading and writing.
   *
   * the three modes are presets rather than anything derived from a format
   * list, so a playlist offers exactly the same menu as a single video and
   * should not get a second copy of it. it does keep its own selection though,
   * so the two are passed in when the caller is not the video screen.
   */
  value?: AudioMode
  onChange?: (mode: AudioMode) => void
}

export function AudioFormatDropdown({
  isVisible,
  className,
  value,
  onChange
}: AudioFormatDropdownProps) {
  const { selectedAudioMode, setSelectedAudioMode } = useYouTubeStore()
  const t = useT()

  // no defaulting effect: the three modes are the same on every video, so mp3
  // is simply what the store starts on
  const mode = value ?? selectedAudioMode
  const select = onChange ?? setSelectedAudioMode

  if (!isVisible) return null

  const selected = optionFor(mode)

  return (
    <SelectionDropdown
      icon={Headphones}
      heading={t("dropdown.audioFormat")}
      placeholder={t("dropdown.audioFormatPlaceholder")}
      options={AUDIO_MODES}
      selected={selected}
      onSelect={(option) => select(option.mode)}
      optionKey={(option) => option.mode}
      renderLabel={(option) => t(option.label)}
      renderDetail={(option) => t(option.detail)}
      className={className}
      footer={
        selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-sm text-slate-600 dark:text-slate-400"
          >
            {t("dropdown.selected")}{" "}
            <span className="font-medium text-slate-900 dark:text-white">
              {t(selected.label)}
            </span>
          </motion.div>
        )
      }
    />
  )
}
