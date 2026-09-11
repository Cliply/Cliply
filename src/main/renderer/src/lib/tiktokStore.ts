import { create } from "zustand"

import type { DownloadPathInfo, TikTokVideoInfoResponse } from "@/lib/api"

interface TikTokState {
  url: string
  setUrl: (url: string) => void
  videoInfo: TikTokVideoInfoResponse | null
  setVideoInfo: (info: TikTokVideoInfoResponse | null) => void
  isLoadingVideoInfo: boolean
  setIsLoadingVideoInfo: (loading: boolean) => void
  isDownloading: boolean
  setIsDownloading: (downloading: boolean) => void
  downloadPath: DownloadPathInfo | null
  setDownloadPath: (pathInfo: DownloadPathInfo) => void
  isLoadingDownloadPath: boolean
  setIsLoadingDownloadPath: (loading: boolean) => void
  reset: () => void
}

export const useTikTokStore = create<TikTokState>((set) => ({
  url: "",
  videoInfo: null,
  isLoadingVideoInfo: false,
  isDownloading: false,
  downloadPath: null,
  isLoadingDownloadPath: false,
  setUrl: (url) => set({ url }),
  setVideoInfo: (info) => set({ videoInfo: info }),
  setIsLoadingVideoInfo: (loading) => set({ isLoadingVideoInfo: loading }),
  setIsDownloading: (downloading) => set({ isDownloading: downloading }),
  setDownloadPath: (pathInfo) => set({ downloadPath: pathInfo }),
  setIsLoadingDownloadPath: (loading) =>
    set({ isLoadingDownloadPath: loading }),
  reset: () =>
    set({
      url: "",
      videoInfo: null,
      isLoadingVideoInfo: false,
      isDownloading: false,
      downloadPath: null,
      isLoadingDownloadPath: false
    })
}))
