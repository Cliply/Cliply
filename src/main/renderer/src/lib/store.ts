import type {
  TimeRange,
  VideoFormat,
  VideoInfoResponse,
  VideoQualityOption,
  DownloadPathInfo
} from "@/lib/api"

import { create } from "zustand"

interface AppState {
  url: string
  setUrl: (url: string) => void

  videoInfo: VideoInfoResponse | null
  setVideoInfo: (info: VideoInfoResponse | null) => void

  isLoadingVideoInfo: boolean
  setIsLoadingVideoInfo: (loading: boolean) => void

  showVideoDetails: boolean
  setShowVideoDetails: (show: boolean) => void

  selectedVideoFormat: VideoFormat | null
  selectedAudioFormat: VideoFormat | null
  setSelectedVideoFormat: (format: VideoFormat | null) => void
  setSelectedAudioFormat: (format: VideoFormat | null) => void

  audioTimeRange: TimeRange
  setAudioTimeRange: (range: TimeRange) => void
  selectedAudioFormatForDownload: VideoFormat | null
  setSelectedAudioFormatForDownload: (format: VideoFormat | null) => void
  isDownloadingAudio: boolean
  setIsDownloadingAudio: (downloading: boolean) => void

  videoTimeRange: TimeRange
  setVideoTimeRange: (range: TimeRange) => void
  selectedVideoQuality: VideoQualityOption | null
  setSelectedVideoQuality: (quality: VideoQualityOption | null) => void
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

export const useAppStore = create<AppState>((set) => ({
  // Initial state
  url: "",
  videoInfo: null,
  isLoadingVideoInfo: false,
  showVideoDetails: false,
  selectedVideoFormat: null,
  selectedAudioFormat: null,
  audioTimeRange: { start: 0, end: 0 },
  selectedAudioFormatForDownload: null,
  isDownloadingAudio: false,
  videoTimeRange: { start: 0, end: 0 },
  selectedVideoQuality: null,
  isDownloadingVideo: false,
  videoPreciseCut: true,
  audioPreciseCut: true,
  downloadPath: null,
  isLoadingDownloadPath: false,

  // Actions
  setUrl: (url) => set({ url }),
  setVideoInfo: (info) => set({ videoInfo: info }),
  setIsLoadingVideoInfo: (loading) => set({ isLoadingVideoInfo: loading }),
  setShowVideoDetails: (show) => set({ showVideoDetails: show }),
  setSelectedVideoFormat: (format) => set({ selectedVideoFormat: format }),
  setSelectedAudioFormat: (format) => set({ selectedAudioFormat: format }),
  setAudioTimeRange: (range) => set({ audioTimeRange: range }),
  setSelectedAudioFormatForDownload: (format) =>
    set({ selectedAudioFormatForDownload: format }),
  setIsDownloadingAudio: (downloading) =>
    set({ isDownloadingAudio: downloading }),
  setVideoTimeRange: (range) => set({ videoTimeRange: range }),
  setSelectedVideoQuality: (quality) => set({ selectedVideoQuality: quality }),
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
      showVideoDetails: false,
      selectedVideoFormat: null,
      selectedAudioFormat: null,
      audioTimeRange: { start: 0, end: 0 },
      selectedAudioFormatForDownload: null,
      isDownloadingAudio: false,
      videoTimeRange: { start: 0, end: 0 },
      selectedVideoQuality: null,
      isDownloadingVideo: false,
      videoPreciseCut: true,
      audioPreciseCut: true,
      downloadPath: null,
      isLoadingDownloadPath: false
    })
}))
