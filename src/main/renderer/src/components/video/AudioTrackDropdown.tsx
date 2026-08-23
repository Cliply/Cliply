import type { AudioTrack } from "@/lib/api"
import { languageName } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { Languages } from "lucide-react"
import { useEffect } from "react"
import { SelectionDropdown } from "./SelectionDropdown"

interface AudioTrackDropdownProps {
  tracks: AudioTrack[]
  isVisible: boolean
  className?: string
}

// the track youtube recorded in is what a download has always produced, so it
// is what the picker opens on - picking a dub is the deliberate act
function defaultTrack(tracks: AudioTrack[]): AudioTrack | null {
  return tracks.find((track) => track.is_original) || tracks[0] || null
}

export function AudioTrackDropdown({
  tracks,
  isVisible,
  className
}: AudioTrackDropdownProps) {
  const { selectedAudioLanguage, setSelectedAudioLanguage } = useYouTubeStore()

  const hasChoice = tracks.length > 1

  // a code the user picked here is kept while this video is on screen; loading
  // another one clears it in the store, so a language both videos happen to
  // carry cannot silently turn the next one's untouched download into a dub
  useEffect(() => {
    if (!hasChoice) {
      if (selectedAudioLanguage !== null) {
        setSelectedAudioLanguage(null)
      }
      return
    }

    if (tracks.some((track) => track.code === selectedAudioLanguage)) {
      return
    }

    setSelectedAudioLanguage(defaultTrack(tracks)?.code ?? null)
  }, [tracks, hasChoice, selectedAudioLanguage, setSelectedAudioLanguage])

  if (!isVisible || !hasChoice) return null

  const selected =
    tracks.find((track) => track.code === selectedAudioLanguage) || null

  return (
    <SelectionDropdown
      icon={Languages}
      heading="Audio Language"
      placeholder="Select audio language..."
      options={tracks}
      selected={selected}
      onSelect={(track) => setSelectedAudioLanguage(track.code)}
      optionKey={(track) => track.code}
      renderLabel={(track) => languageName(track.code)}
      renderDetail={(track) => (track.is_original ? "Original" : null)}
      className={className}
    />
  )
}
