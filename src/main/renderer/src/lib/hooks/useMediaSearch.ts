import { useEffect } from "react"
import { useForm, type UseFormReturn } from "react-hook-form"
import { toast } from "sonner"

import { durationBucket, track, urlKind } from "@/lib/analytics"
import { DownloadError, playlistApi } from "@/lib/api"
import {
  PLATFORM_REGISTRY,
  type PlatformConfig
} from "@/lib/platform-config"
import { usePinterestStore } from "@/lib/pinterestStore"
import { usePlaylistStore } from "@/lib/playlistStore"
import { useAppStore, type Platform } from "@/lib/store"
import { useTikTokStore } from "@/lib/tiktokStore"
import { showServerOverwhelmedToast } from "@/lib/toast-utils"
import { detectYouTubeTarget, ensureHttpScheme } from "@/lib/validation"
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
  // a playlist is the second thing the youtube box can hold, and listing one is
  // a request like any other - the box has to say it is working
  const plIsLoading = usePlaylistStore((s) => s.isLoadingPlaylistInfo)

  // Select reactive state for the current platform
  const url =
    platform === "youtube" ? ytUrl : platform === "tiktok" ? ttUrl : ptUrl
  const isLoading =
    platform === "youtube"
      ? ytIsLoading || plIsLoading
      : platform === "tiktok"
        ? ttIsLoading
        : ptIsLoading

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

    /**
     * a playlist is the one youtube link that is not a video.
     *
     * only a link that is *only* a playlist takes this path. a link carrying
     * both a video and a list keeps going to the single video, which is what
     * Cliply has always done with it; the prompt that asks the user which one
     * they meant is a later ticket, and it would change today's behaviour.
     */
    if (
      platform === "youtube" &&
      detectYouTubeTarget(data.url).kind === "playlist"
    ) {
      await loadPlaylist(data.url, () => setShowMediaDetails(true))
      return
    }

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
 * list what a playlist link holds
 *
 * **nothing is written until the listing is in hand.** a lookup takes a second
 * or two, and in that window the user can submit another link or clear the box.
 * main takes the link and the playlist id as two separate fields and
 * cross-checks neither - the link goes to the engine, the id names the resume
 * archive - so a url committed ahead of its listing, by a lookup that then
 * failed or by two that answered out of order, is one playlist's positions
 * downloaded against another playlist's link. the token says which answer the
 * store is still waiting for; every other one is dropped where it lands.
 *
 * the two youtube views are mutually exclusive, so whichever was loaded last is
 * the one the page shows: the video that was on screen is dropped here, and
 * `fetchAndStore` drops the playlist on the way back. leaving both would put
 * two answers to "what did I just paste" in the store at once.
 */
async function loadPlaylist(url: string, reveal: () => void) {
  const store = usePlaylistStore.getState()
  const token = store.beginLookup()

  store.setIsLoadingPlaylistInfo(true)

  try {
    // main refuses a link with no scheme, and the box accepts one
    const info = await playlistApi.getPlaylistInfo(ensureHttpScheme(url))

    // a newer submit, or a Clear, happened while this was in flight. it owns
    // the store now, and this answer is about a question nobody is asking
    if (!usePlaylistStore.getState().isCurrentLookup(token)) {
      return
    }

    // both halves of "what did I just paste", written together and only once
    // there is something to put in their place: a listing that failed must not
    // take the video the user was already looking at with it
    useYouTubeStore.getState().setVideoInfo(null)
    useYouTubeStore.getState().setUrl(url)
    usePlaylistStore.getState().setLoadedPlaylist(url, info)
    reveal()
    toast.success("Playlist loaded successfully!")
  } catch (error) {
    // a superseded lookup does not get to report its failure either: the user
    // has moved on, and the answer they are waiting for is somebody else's
    if (!usePlaylistStore.getState().isCurrentLookup(token)) {
      return
    }

    const message =
      error instanceof Error ? error.message : "Failed to get playlist information"

    toast.error("Failed to get playlist information", { description: message })
    console.error("Playlist info request failed:", error)
  } finally {
    // the spinner belongs to the newest lookup, which may still be running
    if (usePlaylistStore.getState().isCurrentLookup(token)) {
      usePlaylistStore.getState().setIsLoadingPlaylistInfo(false)
    }
  }
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
