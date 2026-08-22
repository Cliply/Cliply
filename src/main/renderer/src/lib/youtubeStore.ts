import type {
  AudioMode,
  TimeRange,
  QualityTier,
  VideoInfoResponse,
  DownloadPathInfo
} from "@/lib/api"

import { create } from "zustand"

interface YouTubeState {
  url: string
  setUrl: (url: string) => void

  videoInfo: VideoInfoResponse | null
  setVideoInfo: (info: VideoInfoResponse | null) => void

  isLoadingVideoInfo: boolean
  setIsLoadingVideoInfo: (loading: boolean) => void

  // the dub the user picked, shared by both tabs - "which language do you want
  // to hear" is one question, not one per download type
  selectedAudioLanguage: string | null
  setSelectedAudioLanguage: (code: string | null) => void

  audioTimeRange: TimeRange
  setAudioTimeRange: (range: TimeRange) => void
  selectedAudioMode: AudioMode
  setSelectedAudioMode: (mode: AudioMode) => void
  isDownloadingAudio: boolean
  setIsDownloadingAudio: (downloading: boolean) => void

  videoTimeRange: TimeRange
  setVideoTimeRange: (range: TimeRange) => void
  // the menu row the user is on - one of `videoInfo.quality_tiers`, never a row
  // left over from a previous video
  selectedTier: QualityTier | null
  setSelectedTier: (tier: QualityTier | null) => void
  isDownloadingVideo: boolean
  setIsDownloadingVideo: (downloading: boolean) => void
  videoPreciseCut: boolean
  setVideoPreciseCut: (enabled: boolean) => void
  audioPreciseCut: boolean
  setAudioPreciseCut: (enabled: boolean) => void

  // Download path management
  downloadPath: DownloadPathInfo | null
  setDownloadPath: (pathInfo: DownloadPathInfo) => void
  isLoadingDownloadPath: boolean
  setIsLoadingDownloadPath: (loading: boolean) => void

  // Reset function
  reset: () => void
}

export const useYouTubeStore = create<YouTubeState>((set) => ({
  // Initial state
  url: "",
  videoInfo: null,
  isLoadingVideoInfo: false,
  selectedAudioLanguage: null,
  audioTimeRange: { start: 0, end: 0 },
  // mp3 is the one every device and every editor opens, and it is the same
  // choice on every video - so it is the initial value rather than a default an
  // effect has to install
  selectedAudioMode: "mp3",
  isDownloadingAudio: false,
  videoTimeRange: { start: 0, end: 0 },
  selectedTier: null,
  isDownloadingVideo: false,
  videoPreciseCut: true,
  audioPreciseCut: true,
  downloadPath: null,
  isLoadingDownloadPath: false,

  // Actions
  setUrl: (url) => set({ url }),
  setSelectedAudioLanguage: (code) => set({ selectedAudioLanguage: code }),

  // a new video is a new menu: both per-video selections are dropped here so
  // the pickers re-open on *this* video's defaults. keeping them would mean a
  // tier object still carrying the last video's size, and a dub silently
  // replacing the original on any video that happens to share the code
  setVideoInfo: (info) =>
    set({ videoInfo: info, selectedTier: null, selectedAudioLanguage: null }),
  setIsLoadingVideoInfo: (loading) => set({ isLoadingVideoInfo: loading }),
  setAudioTimeRange: (range) => set({ audioTimeRange: range }),
  setSelectedAudioMode: (mode) => set({ selectedAudioMode: mode }),
  setIsDownloadingAudio: (downloading) =>
    set({ isDownloadingAudio: downloading }),
  setVideoTimeRange: (range) => set({ videoTimeRange: range }),
  setSelectedTier: (tier) => set({ selectedTier: tier }),
  setIsDownloadingVideo: (downloading) =>
    set({ isDownloadingVideo: downloading }),
  setVideoPreciseCut: (enabled) => set({ videoPreciseCut: enabled }),
  setAudioPreciseCut: (enabled) => set({ audioPreciseCut: enabled }),
  setDownloadPath: (pathInfo) => set({ downloadPath: pathInfo }),
  setIsLoadingDownloadPath: (loading) => set({ isLoadingDownloadPath: loading }),

  // Reset all state
  reset: () =>
    set({
      url: "",
      videoInfo: null,
      isLoadingVideoInfo: false,
      selectedAudioLanguage: null,
      audioTimeRange: { start: 0, end: 0 },
      selectedAudioMode: "mp3",
      isDownloadingAudio: false,
      videoTimeRange: { start: 0, end: 0 },
      selectedTier: null,
      isDownloadingVideo: false,
      videoPreciseCut: true,
      audioPreciseCut: true,
      downloadPath: null,
      isLoadingDownloadPath: false
    })
}))
