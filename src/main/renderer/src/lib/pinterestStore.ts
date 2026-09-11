import { create } from "zustand"

import type { PinterestVideoInfoResponse } from "@/lib/api"

interface PinterestState {
  url: string
  setUrl: (url: string) => void
  pinInfo: PinterestVideoInfoResponse | null
  setPinInfo: (info: PinterestVideoInfoResponse | null) => void
  isLoadingPinInfo: boolean
  setIsLoadingPinInfo: (loading: boolean) => void
  isDownloading: boolean
  setIsDownloading: (downloading: boolean) => void
  reset: () => void
}

export const usePinterestStore = create<PinterestState>((set) => ({
  url: "",
  pinInfo: null,
  isLoadingPinInfo: false,
  isDownloading: false,
  setUrl: (url) => set({ url }),
  setPinInfo: (info) => set({ pinInfo: info }),
  setIsLoadingPinInfo: (loading) => set({ isLoadingPinInfo: loading }),
  setIsDownloading: (downloading) => set({ isDownloading: downloading }),
  reset: () =>
    set({
      url: "",
      pinInfo: null,
      isLoadingPinInfo: false,
      isDownloading: false
    })
}))
