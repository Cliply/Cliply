import { PinterestLayout } from "@/components/pinterest"
import { AnimatePresence } from "framer-motion"
import { HeroSection } from "../components/hero/HeroSection"
import { VideoLayout } from "../components/video/VideoLayout"
import { usePinterestStore } from "../lib/pinterestStore"
import { useAppStore } from "../lib/store"
import { useYouTubeStore } from "../lib/youtubeStore"

export function HomePage() {
  const { selectedPlatform, showMediaDetails } = useAppStore()
  const { videoInfo } = useYouTubeStore()
  const { pinInfo } = usePinterestStore()

  const shouldShowYouTubeLayout =
    selectedPlatform === "youtube" && showMediaDetails && videoInfo
  const shouldShowPinterestLayout =
    selectedPlatform === "pinterest" && showMediaDetails && pinInfo

  return (
    <AnimatePresence mode="wait">
      {shouldShowYouTubeLayout ? (
        <VideoLayout key="video-layout" />
      ) : shouldShowPinterestLayout ? (
        <PinterestLayout key="pinterest-layout" />
      ) : (
        <HeroSection key="hero-section" />
      )}
    </AnimatePresence>
  )
}
