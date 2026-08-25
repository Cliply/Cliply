import type { TranscriptTrack } from "@/lib/api"
import { languageName } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { Captions } from "lucide-react"
import { useEffect } from "react"
import { SelectionDropdown } from "./SelectionDropdown"

interface TranscriptLanguageDropdownProps {
  tracks: TranscriptTrack[]
  className?: string
}

/**
 * which track the menu opens on
 *
 * a human-written subtitle wherever there is one: it is punctuated, it has no
 * transcription errors in it, and it is what somebody would pick if they read
 * the whole list. the machine transcript is the fallback, not the default.
 */
function defaultTrack(tracks: TranscriptTrack[]): TranscriptTrack | null {
  return tracks.find((track) => !track.is_auto) || tracks[0] || null
}

export function TranscriptLanguageDropdown({
  tracks,
  className
}: TranscriptLanguageDropdownProps) {
  const { selectedTranscript, setSelectedTranscript } = useYouTubeStore()

  // the store clears the selection when a new video loads, so this installs
  // *this* video's default. it also repairs a code that is not on this video's
  // list, which is what stops the picker pointing at a track that is not there
  useEffect(() => {
    if (tracks.length === 0) {
      if (selectedTranscript !== null) {
        setSelectedTranscript(null)
      }
      return
    }

    if (tracks.some((track) => track.code === selectedTranscript)) {
      return
    }

    setSelectedTranscript(defaultTrack(tracks)?.code ?? null)
  }, [tracks, selectedTranscript, setSelectedTranscript])

  const selected =
    tracks.find((track) => track.code === selectedTranscript) || null

  return (
    <SelectionDropdown
      icon={Captions}
      heading="Transcript Language"
      placeholder="Select a language..."
      options={tracks}
      selected={selected}
      onSelect={(track) => setSelectedTranscript(track.code)}
      optionKey={(track) => track.code}
      renderLabel={(track) => languageName(track.code)}
      // the difference is worth saying out loud: an automatic track is a
      // machine transcription and it reads like one
      renderDetail={(track) => (track.is_auto ? "Auto-generated" : "Subtitles")}
      className={className}
      emptyState={
        <div className="rounded-xl border border-slate-200/60 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/30 p-4 text-sm text-slate-600 dark:text-slate-400">
          This video has no transcript. YouTube offers one only when the
          uploader added subtitles or captions were generated for it.
        </div>
      }
    />
  )
}
