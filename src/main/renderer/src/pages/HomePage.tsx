import { AnimatePresence } from "framer-motion"
import { HeroSection } from "../components/hero/HeroSection"
import { VideoLayout } from "../components/video/VideoLayout"
import { useAppStore } from "../lib/store"
import { useYouTubeStore } from "../lib/youtubeStore"

export function HomePage() {
  const { selectedPlatform, showMediaDetails } = useAppStore()
  const { videoInfo } = useYouTubeStore()
  const shouldShowVideoDetails =
    selectedPlatform === "youtube" && showMediaDetails && videoInfo

  return (
    <AnimatePresence mode="wait">
      {shouldShowVideoDetails ? (
        <VideoLayout key="video-layout" />
      ) : (
        <HeroSection key="hero-section" />
      )}
    </AnimatePresence>
  )
}
