import { zodResolver } from "@hookform/resolvers/zod"
import type { Resolver } from "react-hook-form"

import { pinterestApi, tiktokApi, videoApi } from "@/lib/api"
import type { Key } from "@/lib/i18n"
import { usePinterestStore } from "@/lib/stores/pinterestStore"
import { usePlaylistStore } from "@/lib/stores/playlistStore"
import type { Platform } from "@/lib/stores/store"
import { useTikTokStore } from "@/lib/stores/tiktokStore"
import {
  pinterestUrlSchema,
  tiktokUrlSchema,
  youtubeUrlSchema
} from "@/lib/validation"
import { useYouTubeStore } from "@/lib/stores/youtubeStore"

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

/**
 * every user-facing field here is a translation key, not a sentence: the
 * registry is built once at module load, so a string baked in here would stay
 * in whichever language was current when the app started. the consumers call
 * `t()` at render time instead. `logPrefix` is the exception - it only ever
 * reaches the console.
 */
export interface PlatformConfig {
  id: Platform
  label: string
  logo: string
  formResolver: Resolver<{ url: string }>
  placeholder: Key
  helperText: Key
  loadingText: Key
  successMessage: Key
  errorMessages: {
    invalidUrl: Key
    invalidUrlToast: Key
    unavailable: Key
    genericFail: Key
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
    // the one box that takes a playlist link, so the one placeholder that says
    // so. pinterest and tiktok keep the shared line, which is still true of them
    placeholder: "url.youtubePlaceholder",
    helperText: "url.youtubeHelper",
    loadingText: "url.loading",
    successMessage: "url.loaded",
    errorMessages: {
      invalidUrl: "error.youtubeUrl",
      invalidUrlToast: "validation.youtubeInvalid",
      unavailable: "error.unavailable",
      genericFail: "error.infoFailed",
      logPrefix: "Video info request failed:"
    },
    fetchAndStore: async (url: string) => {
      const info = await videoApi.getVideoInfo(url)
      useYouTubeStore.getState().setVideoInfo(info)
      // the youtube box holds either a video or a playlist, never both at once:
      // whichever was loaded last is what the page shows
      usePlaylistStore.getState().reset()

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
      // clearing the box clears both of the things it can be holding
      reset: () => {
        useYouTubeStore.getState().reset()
        usePlaylistStore.getState().reset()
      }
    }
  },
  pinterest: {
    id: "pinterest",
    label: "pinterest",
    logo: "./pinterest-logo.svg",
    formResolver: zodResolver(pinterestUrlSchema),
    placeholder: "url.placeholder",
    helperText: "url.pinterestHelper",
    loadingText: "url.loading",
    successMessage: "url.loaded",
    errorMessages: {
      invalidUrl: "error.pinterestUrl",
      invalidUrlToast: "validation.pinterestInvalid",
      unavailable: "error.unavailable",
      genericFail: "error.infoFailed",
      logPrefix: "Pinterest info request failed:"
    },
    fetchAndStore: async (url: string) => {
      const info = await pinterestApi.getInfo(url)
      usePinterestStore.getState().setInfo(info)

      return { durationSeconds: info.duration ?? null, formatsCount: null }
    },
    store: {
      getUrl: () => usePinterestStore.getState().url,
      setUrl: (url) => usePinterestStore.getState().setUrl(url),
      isLoading: () => usePinterestStore.getState().isLoadingInfo,
      setIsLoading: (loading) =>
        usePinterestStore.getState().setIsLoadingInfo(loading),
      hasInfo: () => usePinterestStore.getState().info !== null,
      reset: () => usePinterestStore.getState().reset()
    }
  },
  tiktok: {
    id: "tiktok",
    label: "tiktok",
    logo: "./tiktok-logo.svg",
    formResolver: zodResolver(tiktokUrlSchema),
    placeholder: "url.placeholder",
    helperText: "url.tiktokHelper",
    loadingText: "url.loading",
    successMessage: "url.loaded",
    errorMessages: {
      invalidUrl: "error.tiktokUrl",
      invalidUrlToast: "validation.tiktokInvalid",
      unavailable: "error.unavailable",
      genericFail: "error.tiktokBlocked",
      logPrefix: "TikTok info request failed:"
    },
    fetchAndStore: async (url: string) => {
      const info = await tiktokApi.getInfo(url)
      useTikTokStore.getState().setInfo(info)

      return { durationSeconds: info.duration ?? null, formatsCount: null }
    },
    store: {
      getUrl: () => useTikTokStore.getState().url,
      setUrl: (url) => useTikTokStore.getState().setUrl(url),
      isLoading: () => useTikTokStore.getState().isLoadingInfo,
      setIsLoading: (loading) =>
        useTikTokStore.getState().setIsLoadingInfo(loading),
      hasInfo: () => useTikTokStore.getState().info !== null,
      reset: () => useTikTokStore.getState().reset()
    }
  }
}

export const PLATFORM_LIST = Object.values(PLATFORM_REGISTRY).map((p) => ({
  id: p.id,
  label: p.label,
  logo: p.logo
}))
