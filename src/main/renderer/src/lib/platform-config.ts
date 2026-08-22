import { zodResolver } from "@hookform/resolvers/zod"
import type { Resolver } from "react-hook-form"

import { pinterestApi, tiktokApi, videoApi } from "@/lib/api"
import { usePinterestStore } from "@/lib/pinterestStore"
import type { Platform } from "@/lib/store"
import { useTikTokStore } from "@/lib/tiktokStore"
import { pinterestUrlSchema, tiktokUrlSchema, youtubeUrlSchema } from "@/lib/validation"
import { useYouTubeStore } from "@/lib/youtubeStore"

interface PlatformStoreAccessor {
  getUrl: () => string
  setUrl: (url: string) => void
  isLoading: () => boolean
  setIsLoading: (loading: boolean) => void
  hasInfo: () => boolean
  reset: () => void
}

/**
 * what a loaded media is, in the only terms telemetry may know it in
 *
 * the title, the uploader and the url stay in the store this came from. a
 * duration is bucketed before it is sent, and a count is a count.
 */
export interface MediaSummary {
  durationSeconds: number | null
  // youtube is the only platform that offers a choice of quality; the others
  // report nothing rather than a fabricated 1
  formatsCount: number | null
}

export interface PlatformConfig {
  id: Platform
  label: string
  logo: string
  formResolver: Resolver<{ url: string }>
  placeholder: string
  helperText: string
  loadingText: string
  successMessage: string
  errorMessages: {
    invalidUrl: string
    invalidUrlToast: string
    unavailable: string
    genericFail: string
    logPrefix: string
  }
  fetchAndStore: (url: string) => Promise<MediaSummary>
  store: PlatformStoreAccessor
}

export const PLATFORM_REGISTRY: Record<Platform, PlatformConfig> = {
  youtube: {
    id: "youtube",
    label: "youtube",
    logo: "./youtube-logo.svg",
    formResolver: zodResolver(youtubeUrlSchema),
    placeholder: "paste video url here...",
    helperText:
      "supports youtube videos & shorts from youtube.com and youtu.be",
    loadingText: "\u{1F40B} getting video information",
    successMessage: "Video information loaded successfully!",
    errorMessages: {
      invalidUrl: "Invalid YouTube URL",
      invalidUrlToast: "Please enter a valid YouTube URL",
      unavailable: "This video is not available for download",
      genericFail: "Failed to get video information",
      logPrefix: "Video info request failed:"
    },
    fetchAndStore: async (url: string) => {
      const info = await videoApi.getVideoInfo(url)
      useYouTubeStore.getState().setVideoInfo(info)

      return {
        durationSeconds: info.duration ?? null,
        formatsCount: info.quality_tiers?.length ?? null
      }
    },
    store: {
      getUrl: () => useYouTubeStore.getState().url,
      setUrl: (url) => useYouTubeStore.getState().setUrl(url),
      isLoading: () => useYouTubeStore.getState().isLoadingVideoInfo,
      setIsLoading: (loading) =>
        useYouTubeStore.getState().setIsLoadingVideoInfo(loading),
      hasInfo: () => useYouTubeStore.getState().videoInfo !== null,
      reset: () => useYouTubeStore.getState().reset()
    }
  },
  pinterest: {
    id: "pinterest",
    label: "pinterest",
    logo: "./pinterest-logo.svg",
    formResolver: zodResolver(pinterestUrlSchema),
    placeholder: "paste video url here...",
    helperText: "supports pinterest videos from pin.it urls",
    loadingText: "\u{1F40B} getting video information",
    successMessage: "Video information loaded successfully!",
    errorMessages: {
      invalidUrl: "Invalid Pinterest URL",
      invalidUrlToast: "Please enter a valid Pinterest URL",
      unavailable: "This video is not available for download",
      genericFail: "Failed to get video information",
      logPrefix: "Pinterest info request failed:"
    },
    fetchAndStore: async (url: string) => {
      const info = await pinterestApi.getInfo(url)
      usePinterestStore.getState().setPinInfo(info)

      return { durationSeconds: info.duration ?? null, formatsCount: null }
    },
    store: {
      getUrl: () => usePinterestStore.getState().url,
      setUrl: (url) => usePinterestStore.getState().setUrl(url),
      isLoading: () => usePinterestStore.getState().isLoadingPinInfo,
      setIsLoading: (loading) =>
        usePinterestStore.getState().setIsLoadingPinInfo(loading),
      hasInfo: () => usePinterestStore.getState().pinInfo !== null,
      reset: () => usePinterestStore.getState().reset()
    }
  },
  tiktok: {
    id: "tiktok",
    label: "tiktok",
    logo: "./tiktok-logo.svg",
    formResolver: zodResolver(tiktokUrlSchema),
    placeholder: "paste video url here...",
    helperText: "supports tiktok.com/@user/video/ID, vm.tiktok.com, and vt.tiktok.com links",
    loadingText: "\u{1F40B} getting video information",
    successMessage: "Video information loaded successfully!",
    errorMessages: {
      invalidUrl: "Invalid TikTok URL",
      invalidUrlToast: "Please enter a valid TikTok URL",
      unavailable: "This video is not available for download",
      genericFail: "TikTok blocked this request — please try again in a moment",
      logPrefix: "TikTok info request failed:"
    },
    fetchAndStore: async (url: string) => {
      const info = await tiktokApi.getInfo(url)
      useTikTokStore.getState().setVideoInfo(info)

      return { durationSeconds: info.duration ?? null, formatsCount: null }
    },
    store: {
      getUrl: () => useTikTokStore.getState().url,
      setUrl: (url) => useTikTokStore.getState().setUrl(url),
      isLoading: () => useTikTokStore.getState().isLoadingVideoInfo,
      setIsLoading: (loading) =>
        useTikTokStore.getState().setIsLoadingVideoInfo(loading),
      hasInfo: () => useTikTokStore.getState().videoInfo !== null,
      reset: () => useTikTokStore.getState().reset()
    }
  }
}

export const PLATFORM_LIST = Object.values(PLATFORM_REGISTRY).map((p) => ({
  id: p.id,
  label: p.label,
  logo: p.logo
}))
