import { useEffect } from "react"
import { useForm, type UseFormReturn } from "react-hook-form"
import { toast } from "sonner"

import { durationBucket, track, urlKind } from "@/lib/analytics"
import { DownloadError } from "@/lib/api"
import {
  PLATFORM_REGISTRY,
  type PlatformConfig
} from "@/lib/platform-config"
import { usePinterestStore } from "@/lib/pinterestStore"
import { useAppStore, type Platform } from "@/lib/store"
import { useTikTokStore } from "@/lib/tiktokStore"
import { showServerOverwhelmedToast } from "@/lib/toast-utils"
import { useYouTubeStore } from "@/lib/youtubeStore"

interface MediaSearchOptions {
  onSearch?: (url: string) => void
}

interface MediaSearchResult {
  form: UseFormReturn<{ url: string }>
  isLoading: boolean
  onSubmit: (data: { url: string }) => Promise<void>
  handleClear: () => void
  config: PlatformConfig
}

/**
 * Shared hook that encapsulates the search/submit flow for any platform.
 * Subscribes to all platform stores (satisfies rules of hooks) and selects
 * the right reactive state based on the current platform.
 *
 * To add a new platform: add selectors here + config entry in platform-config.ts.
 */
export function useMediaSearch(
  platform: Platform,
  options?: MediaSearchOptions
): MediaSearchResult {
  const config = PLATFORM_REGISTRY[platform]
  const { setShowMediaDetails } = useAppStore()

  // Always subscribe to all stores (rules of hooks: constant call count)
  const ytUrl = useYouTubeStore((s) => s.url)
  const ytIsLoading = useYouTubeStore((s) => s.isLoadingVideoInfo)
  const ptUrl = usePinterestStore((s) => s.url)
  const ptIsLoading = usePinterestStore((s) => s.isLoadingPinInfo)
  const ttUrl = useTikTokStore((s) => s.url)
  const ttIsLoading = useTikTokStore((s) => s.isLoadingVideoInfo)

  // Select reactive state for the current platform
  const url =
    platform === "youtube" ? ytUrl : platform === "tiktok" ? ttUrl : ptUrl
  const isLoading =
    platform === "youtube" ? ytIsLoading : platform === "tiktok" ? ttIsLoading : ptIsLoading

  const form = useForm<{ url: string }>({
    resolver: config.formResolver,
    defaultValues: { url }
  })

  useEffect(() => {
    form.reset({ url })
  }, [form, url, platform])

  const onSubmit = async (data: { url: string }) => {
    if (options?.onSearch) {
      options.onSearch(data.url)
      return
    }

    // the shape of the link, never the link
    track("url_submitted", { platform, url_kind: urlKind(data.url) })

    try {
      config.store.setIsLoading(true)
      config.store.setUrl(data.url)
      const summary = await config.fetchAndStore(data.url)
      setShowMediaDetails(true)
      toast.success(config.successMessage)

      track("media_info_loaded", {
        platform,
        duration_bucket: durationBucket(summary.durationSeconds),
        formats_count: summary.formatsCount
      })
    } catch (error) {
      trackSearchFailure(platform, error)
      handleSearchError(error, config, form)
    } finally {
      config.store.setIsLoading(false)
    }
  }

  const handleClear = () => {
    form.reset({ url: "" })
    config.store.reset()
  }

  return { form, isLoading, onSubmit, handleClear, config }
}

/**
 * report a failed lookup
 *
 * the category is main's own answer, computed there by the taxonomy and carried
 * across on the error (ipc-handlers.js:421). the `code` next to it in the same
 * payload is not one - it is the engine's code or a "GENERAL_ERROR" placeholder
 * - and classifying the message instead would collapse almost every failure
 * into UNKNOWN_ERROR, because the wording is written for the user rather than
 * for a pattern.
 *
 * the message travels raw. it is the one free-text property, it is scrubbed and
 * re-checked at the boundary before it can leave the machine, and a second,
 * weaker scrub here would only make the real one harder to reason about.
 */
function trackSearchFailure(platform: Platform, error: unknown) {
  track("media_info_failed", {
    platform,
    error_category:
      (error instanceof DownloadError ? error.category : null) ??
      "UNKNOWN_ERROR",
    error_stage: "fetch_info",
    error_message: error instanceof Error ? error.message : null
  })
}

function handleSearchError(
  error: unknown,
  config: PlatformConfig,
  form: UseFormReturn<{ url: string }>
) {
  const errorMessage =
    error instanceof Error ? error.message : config.errorMessages.genericFail

  if (errorMessage.includes(config.errorMessages.invalidUrl)) {
    toast.error(config.errorMessages.invalidUrlToast)
    form.setError("url", { message: config.errorMessages.invalidUrl })
  } else if (
    errorMessage.includes("unavailable") ||
    errorMessage.includes("not found")
  ) {
    toast.error(config.errorMessages.unavailable)
  } else if (errorMessage.includes("image, not a video")) {
    toast.error("This is an image, not a video", {
      description: "Only videos can be downloaded"
    })
  } else if (
    errorMessage.includes("network") ||
    errorMessage.includes("fetch")
  ) {
    showServerOverwhelmedToast()
  } else {
    toast.error(config.errorMessages.genericFail, {
      description: errorMessage
    })
  }

  console.error(config.errorMessages.logPrefix, error)
}
