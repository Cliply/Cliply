import { CookieDialog } from "@/components/cookies/CookieDialog"
import { SupportDialog } from "@/components/support/SupportDialog"
import { PinterestLayout } from "@/components/pinterest"
import { MixedLinkPrompt, PlaylistLayout } from "@/components/playlist"
import { ReportIssueDialog } from "@/components/report/ReportIssueDialog"
import { TikTokLayout } from "@/components/tiktok"
import { AnimatePresence } from "framer-motion"
import { HeroSection } from "../components/hero/HeroSection"
import { VideoLayout } from "../components/video/VideoLayout"
import { usePinterestStore } from "../lib/pinterestStore"
import { usePlaylistStore } from "../lib/playlistStore"
import { useAppStore } from "../lib/store"
import { useTikTokStore } from "../lib/tiktokStore"
import { useYouTubeStore } from "../lib/youtubeStore"

export function HomePage() {
  const { selectedPlatform, showMediaDetails } = useAppStore()
  const { videoInfo } = useYouTubeStore()
  const { playlistInfo } = usePlaylistStore()
  const { pinInfo } = usePinterestStore()
  const { videoInfo: tikTokInfo } = useTikTokStore()

  // the youtube box holds one of two things. loading either clears the other,
  // so a listing in the store means the playlist is what was pasted last
  const shouldShowPlaylistLayout =
    selectedPlatform === "youtube" && showMediaDetails && playlistInfo
  const shouldShowYouTubeLayout =
    selectedPlatform === "youtube" && showMediaDetails && videoInfo
  const shouldShowPinterestLayout =
    selectedPlatform === "pinterest" && showMediaDetails && pinInfo
  const shouldShowTikTokLayout =
    selectedPlatform === "tiktok" && showMediaDetails && tikTokInfo

  return (
    <>
      <AnimatePresence mode="wait">
        {shouldShowPlaylistLayout ? (
          <PlaylistLayout key="playlist-layout" />
        ) : shouldShowYouTubeLayout ? (
          <VideoLayout key="video-layout" />
        ) : shouldShowPinterestLayout ? (
          <PinterestLayout key="pinterest-layout" />
        ) : shouldShowTikTokLayout ? (
          <TikTokLayout key="tiktok-layout" />
        ) : (
          <HeroSection key="hero-section" />
        )}
      </AnimatePresence>
      {/* the link can be submitted from any of the views above, and the answer
          is what decides which one comes next */}
      <MixedLinkPrompt />
      <ReportIssueDialog />
      <CookieDialog />
      <SupportDialog />
    </>
  )
}
