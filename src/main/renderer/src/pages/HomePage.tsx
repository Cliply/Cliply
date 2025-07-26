import { AnimatePresence } from "framer-motion"
import { HeroSection } from "../components/hero/HeroSection"
import { VideoLayout } from "../components/video/VideoLayout"
import { useAppStore } from "../lib/store"

export function HomePage() {
  const { showVideoDetails, videoInfo } = useAppStore()

  return (
    <AnimatePresence mode="wait">
      {showVideoDetails && videoInfo ? (
        <VideoLayout key="video-layout" />
      ) : (
        <HeroSection key="hero-section" />
      )}
    </AnimatePresence>
  )
}
