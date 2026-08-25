import type { TranscriptFormat } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { motion } from "framer-motion"
import { FileText } from "lucide-react"
import { SelectionDropdown } from "./SelectionDropdown"

/**
 * the three shapes a transcript is useful in
 *
 * two are subtitle files with timings, which is what a player wants. `txt` is
 * neither - it is the same words with the cue numbers and the timings taken
 * out, which is what somebody pasting into a document wants, and yt-dlp cannot
 * produce it: main strips it out of the srt afterwards.
 */
const TRANSCRIPT_FORMATS: {
  format: TranscriptFormat
  label: string
  detail: string
}[] = [
  { format: "srt", label: "SRT", detail: "Subtitles · plays everywhere" },
  { format: "vtt", label: "VTT", detail: "WebVTT · for the web" },
  { format: "txt", label: "Plain text", detail: "Just the words, no timings" }
]

const optionFor = (format: TranscriptFormat) =>
  TRANSCRIPT_FORMATS.find((option) => option.format === format) || null

interface TranscriptFormatDropdownProps {
  isVisible: boolean
  className?: string
}

export function TranscriptFormatDropdown({
  isVisible,
  className
}: TranscriptFormatDropdownProps) {
  const { selectedTranscriptFormat, setSelectedTranscriptFormat } =
    useYouTubeStore()

  // no defaulting effect: the three formats are the same on every video, so
  // srt is simply what the store starts on

  if (!isVisible) return null

  const selected = optionFor(selectedTranscriptFormat)

  return (
    <SelectionDropdown
      icon={FileText}
      heading="Transcript Format"
      placeholder="Select a format..."
      options={TRANSCRIPT_FORMATS}
      selected={selected}
      onSelect={(option) => setSelectedTranscriptFormat(option.format)}
      optionKey={(option) => option.format}
      renderLabel={(option) => option.label}
      renderDetail={(option) => option.detail}
      className={className}
      footer={
        selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-sm text-slate-600 dark:text-slate-400"
          >
            Selected:{" "}
            <span className="font-medium text-slate-900 dark:text-white">
              {selected.label}
            </span>
          </motion.div>
        )
      }
    />
  )
}
