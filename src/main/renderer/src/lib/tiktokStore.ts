import { create } from "zustand"

import type { TikTokVideoInfoResponse } from "@/lib/api"

interface TikTokState {
  url: string
  setUrl: (url: string) => void
  videoInfo: TikTokVideoInfoResponse | null
  setVideoInfo: (info: TikTokVideoInfoResponse | null) => void
  isLoadingVideoInfo: boolean
  setIsLoadingVideoInfo: (loading: boolean) => void
  isDownloading: boolean
  setIsDownloading: (downloading: boolean) => void
  reset: () => void
}

export const useTikTokStore = create<TikTokState>((set) => ({
  url: "",
  videoInfo: null,
  isLoadingVideoInfo: false,
  isDownloading: false,
  setUrl: (url) => set({ url }),
  setVideoInfo: (info) => set({ videoInfo: info }),
  setIsLoadingVideoInfo: (loading) => set({ isLoadingVideoInfo: loading }),
  setIsDownloading: (downloading) => set({ isDownloading: downloading }),
  reset: () =>
    set({
      url: "",
      videoInfo: null,
      isLoadingVideoInfo: false,
      isDownloading: false
    })
}))
