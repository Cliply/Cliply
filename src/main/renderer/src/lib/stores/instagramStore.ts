import { create } from "zustand"
import type { InstagramVideoInfoResponse } from "@/lib/api"
import type { MediaState } from "@/lib/stores/createMediaStore"

interface InstagramState extends MediaState<InstagramVideoInfoResponse> {
  lookupVersion: number
  beginLookup: () => number
  isCurrentLookup: (version: number) => boolean
  setLoadedInfo: (
    version: number,
    url: string,
    info: InstagramVideoInfoResponse
  ) => void
}

// Keep the last successful URL and metadata together while a replacement loads.
// Clear, home navigation and platform changes all invalidate pending lookups.
export const useInstagramStore = create<InstagramState>((set, get) => ({
  url: "",
  info: null,
  isLoadingInfo: false,
  isDownloading: false,
  lookupVersion: 0,
  setUrl: (url) => set({ url }),
  setInfo: (info) => set({ info }),
  setIsLoadingInfo: (isLoadingInfo) => set({ isLoadingInfo }),
  setIsDownloading: (isDownloading) => set({ isDownloading }),
  beginLookup: () => {
    const lookupVersion = get().lookupVersion + 1
    set({ lookupVersion, isLoadingInfo: true })
    return lookupVersion
  },
  isCurrentLookup: (version) => get().lookupVersion === version,
  setLoadedInfo: (version, url, info) => {
    if (get().isCurrentLookup(version)) set({ url, info })
  },
  reset: () =>
    set((state) => ({
      url: "",
      info: null,
      isLoadingInfo: false,
      isDownloading: false,
      lookupVersion: state.lookupVersion + 1
    }))
}))
