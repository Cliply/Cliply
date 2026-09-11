import { create } from "zustand"

/**
 * one box, one loaded media, one download
 *
 * the shape a platform has when the whole page is a url to paste and a button
 * to press. `youtubeStore` is not built on this: it keeps state per tab, a
 * quality tier, an audio track and two time ranges, and is genuinely a
 * different thing.
 */
export interface MediaState<TInfo> {
  url: string
  setUrl: (url: string) => void
  info: TInfo | null
  setInfo: (info: TInfo | null) => void
  isLoadingInfo: boolean
  setIsLoadingInfo: (loading: boolean) => void
  isDownloading: boolean
  setIsDownloading: (downloading: boolean) => void
  reset: () => void
}

/**
 * a store of that shape, for whatever a given platform's info response is
 *
 * every such store starts empty and `reset` puts it back there, so the initial
 * state is written once here rather than once per platform.
 */
export const createMediaStore = <TInfo>() =>
  create<MediaState<TInfo>>((set) => ({
    url: "",
    info: null,
    isLoadingInfo: false,
    isDownloading: false,
    setUrl: (url) => set({ url }),
    setInfo: (info) => set({ info }),
    setIsLoadingInfo: (loading) => set({ isLoadingInfo: loading }),
    setIsDownloading: (downloading) => set({ isDownloading: downloading }),
    reset: () =>
      set({
        url: "",
        info: null,
        isLoadingInfo: false,
        isDownloading: false
      })
  }))
