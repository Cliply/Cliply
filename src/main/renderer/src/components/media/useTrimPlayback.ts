import { useEffect, useRef, useState, type RefObject } from "react"
import type { EditRange } from "@/lib/local-media-types"

type TrimPlaybackOptions = {
  player: RefObject<HTMLMediaElement | null>
  sourceId: string
  retained: EditRange[]
  locked: boolean
}

// Auditions requested source ranges. Export boundaries remain main-owned.
export function useTrimPlayback({
  player,
  sourceId,
  retained,
  locked
}: TrimPlaybackOptions) {
  const [previewing, setPreviewing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const previewIndex = useRef(0)
  const stopPreview = () => setPreviewing(false)
  const togglePlay = () => {
    const media = player.current
    if (!media) return
    setPreviewing(false)
    if (media.paused) void media.play().catch(() => {})
    else media.pause()
  }
  useEffect(() => {
    const media = player.current
    if (!media) return
    const update = () => setPlaying(!media.paused && !media.ended)
    update()
    media.addEventListener("play", update)
    media.addEventListener("pause", update)
    media.addEventListener("ended", update)
    media.addEventListener("emptied", update)
    return () => {
      media.removeEventListener("play", update)
      media.removeEventListener("pause", update)
      media.removeEventListener("ended", update)
      media.removeEventListener("emptied", update)
    }
  }, [player, sourceId])
  useEffect(() => {
    if (!previewing || locked) return
    const media = player.current
    if (!media) return
    let frame = 0
    const tick = () => {
      const section = retained[previewIndex.current]
      if (!section) {
        media.pause()
        setPreviewing(false)
        return
      }
      if (!media.seeking && media.currentTime >= section.end) {
        previewIndex.current += 1
        const next = retained[previewIndex.current]
        if (!next) {
          media.pause()
          setPreviewing(false)
          return
        }
        media.currentTime = next.start
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      media.pause()
    }
    // Edits stop preview through commit; position updates must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewing, locked, sourceId])
  const togglePreview = () => {
    const media = player.current
    if (previewing) {
      setPreviewing(false)
      media?.pause()
      return
    }
    if (media && Number.isFinite(media.duration)) {
      previewIndex.current = 0
      media.currentTime = retained[0].start
      setPreviewing(true)
      void media.play().catch(() => setPreviewing(false))
    }
  }
  return { playing, previewing, stopPreview, togglePlay, togglePreview }
}
