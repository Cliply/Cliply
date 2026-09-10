import { useEffect } from "react"
import { useForm, type UseFormReturn } from "react-hook-form"
import { toast } from "sonner"

import {
  durationBucket,
  playlistSizeBucket,
  track,
  urlKind
} from "@/lib/analytics"
import {
  DownloadError,
  playlistApi,
  type PlaylistInfoResponse
} from "@/lib/api"
import { en } from "@/lib/i18n/en"
import { localizeError, t } from "@/lib/i18n"
import { mixedLinkKey, useMixedLinkStore } from "@/lib/mixedLinkStore"
import {
  PLATFORM_REGISTRY,
  type PlatformConfig
} from "@/lib/platform-config"
import { usePinterestStore } from "@/lib/pinterestStore"
import { usePlaylistStore } from "@/lib/playlistStore"
import { useAppStore, type Platform } from "@/lib/store"
import { useTikTokStore } from "@/lib/tiktokStore"
import {
  showBotDetectionToast,
  showServerOverwhelmedToast
} from "@/lib/toast-utils"
import {
  detectYouTubeTarget,
  ensureHttpScheme,
  type YouTubeTarget
} from "@/lib/validation"
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

    const reveal = () => setShowMediaDetails(true)
    const loadVideo = () =>
      loadSingleVideo(platform, config, form, data.url, reveal)

    const target = platform === "youtube" ? detectYouTubeTarget(data.url) : null

    if (!target) {
      await loadVideo()
      return
    }

    const token = beginYouTubeLookup()

    // a playlist is the one youtube link that is not a video at all
    if (target.kind === "playlist") {
      await loadPlaylist(data.url, token, reveal)
      return
    }

    // and one that is both is the one link Cliply cannot answer on its own
    if (target.kind === "both") {
      await resolveMixedLink(data.url, target, token, reveal, loadVideo)
      return
    }

    await loadVideo()
  }

  const handleClear = () => {
    form.reset({ url: "" })
    config.store.reset()
  }

  return { form, isLoading, onSubmit, handleClear, config }
}

/**
 * this submission owns the two youtube views from now on
 *
 * **taken synchronously, by every youtube submission, whatever kind of link it
 * turns out to be.** the older rule was that a lookup became current when it
 * answered, which reads as the same thing and is not: a plain video only reset
 * the playlist store inside `fetchAndStore`, once its own response was back. a
 * listing that landed in that window was still "current" and wrote over the
 * video the user had just asked for, and one that landed after a video that
 * *failed* stayed current indefinitely.
 *
 * that was survivable while the answer only ever painted a screen. it is not
 * now: an obsolete listing gets to interrupt the user with a question about a
 * link they have already replaced, and answering it sends one playlist's
 * positions under another playlist's url. so the token moves first and the
 * request comes second, which is the only ordering in which "current" means
 * "the newest one" rather than "the newest one that has answered".
 *
 * the two things the superseded lookup can no longer clean up after itself go
 * with it: the spinner, which belongs to whoever is current, and any question
 * still on screen, which is about the link that has just been replaced.
 */
function beginYouTubeLookup(): number {
  useMixedLinkStore.getState().dismiss()
  usePlaylistStore.getState().setIsLoadingPlaylistInfo(false)

  return usePlaylistStore.getState().beginLookup()
}

/**
 * look one video up and put it on screen
 *
 * lifted out of `onSubmit` unchanged, because it is now reachable two ways: a
 * link that is only a video takes it directly, and a link that is both takes it
 * once the user has said that is what they meant. "Just this video" has to be
 * today's flow and today's download, so it is literally the same function.
 */
async function loadSingleVideo(
  platform: Platform,
  config: PlatformConfig,
  form: UseFormReturn<{ url: string }>,
  url: string,
  reveal: () => void
) {
  try {
    config.store.setIsLoading(true)
    config.store.setUrl(url)
    const summary = await config.fetchAndStore(url)
    reveal()
    toast.success(t(config.successMessage))

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

/**
 * a link that names a video *and* the playlist it sits in
 *
 * `watch?v=…&list=…` is what youtube hands out from inside a playlist, and
 * `youtu.be/ID?list=…` is the same thing off the share sheet. Cliply has always
 * quietly taken the video out of it. it does not guess any more.
 *
 * **the listing is fetched before the question is asked**, which is the whole
 * design of this. "All 11 videos in *Short talks to watch during your coffee
 * break*" is a decision somebody can make; "All videos in the playlist" is not,
 * and a question nobody can answer is worse than the guess it replaced. the
 * cost is one flat listing, about a second, thrown away when the answer is the
 * video. that is the price of the question, it is paid once per link, and the
 * answer to "then why not fetch it after they choose" is that there is nothing
 * to choose between until it is in hand.
 *
 * a listing that never arrives is not a failed paste. the user asked for a
 * link Cliply has downloaded for years; the lookup was our idea, so its failure
 * is ours to swallow and the video is what they get.
 */
async function resolveMixedLink(
  url: string,
  target: YouTubeTarget,
  token: number,
  reveal: () => void,
  loadVideo: () => Promise<void>
) {
  const key = mixedLinkKey(target)
  const remembered = useMixedLinkStore.getState().recall(key)

  // an answer already given about this exact link, which also spares it the
  // listing: the question is the only thing that listing was for
  if (remembered === "video") {
    await loadVideo()
    return
  }

  usePlaylistStore.getState().setIsLoadingPlaylistInfo(true)

  let info: PlaylistInfoResponse | null = null

  try {
    // main refuses a link with no scheme, and the box accepts one
    info = await playlistApi.getPlaylistInfo(ensureHttpScheme(url))
  } catch (error) {
    console.error("Playlist info request failed:", error)
  }

  // a newer submit, or a Clear, happened while this was in flight. the store is
  // somebody else's now, and so is the screen this question would open over
  if (!usePlaylistStore.getState().isCurrentLookup(token)) {
    return
  }

  usePlaylistStore.getState().setIsLoadingPlaylistInfo(false)

  // nothing came back, or nothing worth offering. an empty playlist is not a
  // second choice, so there is no question to interrupt anybody with
  if (!info || info.listed < 1) {
    await loadVideo()
    return
  }

  const listing = info

  if (remembered === "playlist") {
    commitPlaylist(url, listing, reveal)
    return
  }

  useMixedLinkStore.getState().ask({
    info: listing,
    choose: (choice) => {
      /**
       * the same rule the lookup itself answers to, one step later.
       *
       * the question sits between the listing and the write, so the window in
       * which the store can change hands is as long as the user takes to read
       * it. every path that supersedes a question now retires it outright, so
       * this is the second lock on a door that is already shut - but what it
       * guards against, one playlist's positions sent under another playlist's
       * link, is not a cosmetic bug, and the retiring lives in callers while
       * this lives with the write it protects.
       *
       * **nothing is remembered before it passes.** an answer that was not
       * applied is not an answer, and remembering one would have the next
       * paste of this link silently follow a decision the app threw away.
       */
      if (!usePlaylistStore.getState().isCurrentLookup(token)) {
        return
      }

      /**
       * the answer, which is the question url_kind's "playlist" value could
       * only ever half ask.
       *
       * reported here rather than in the dialog, and after the guard rather
       * than before it, for the reason the remembering below is: an answer that
       * was not applied is not an answer. a question that was closed rather than
       * answered sends nothing at all - an abandoned paste teaches nothing, and
       * a third value for a two-button question would be one the vocabulary
       * would drop anyway.
       *
       * the size is the list they were choosing about, bucketed. the link, the
       * video id and the playlist's title stay in the renderer, where they
       * already are.
       */
      track("playlist_prompt_answered", {
        choice,
        playlist_size: playlistSizeBucket(listing)
      })

      useMixedLinkStore.getState().remember(key, choice)

      if (choice === "playlist") {
        commitPlaylist(url, listing, reveal)
        return
      }

      void loadVideo()
    }
  })
}

/**
 * put a listing on screen, whichever question it answered
 *
 * the two youtube views are mutually exclusive, so whichever was loaded last is
 * the one the page shows: the video that was on screen is dropped here, and
 * `fetchAndStore` drops the playlist on the way back. leaving both would put
 * two answers to "what did I just paste" in the store at once.
 *
 * the url and the listing are written together by `setLoadedPlaylist`, and
 * there is no way to write one without the other: main takes the link and the
 * playlist id as two separate fields and cross-checks neither.
 */
function commitPlaylist(
  url: string,
  info: PlaylistInfoResponse,
  reveal: () => void
) {
  useYouTubeStore.getState().setVideoInfo(null)
  useYouTubeStore.getState().setUrl(url)
  usePlaylistStore.getState().setLoadedPlaylist(url, info)
  reveal()
  toast.success(t("playlist.loaded"))

  /**
   * the same event a loaded video sends, carrying what a playlist has instead.
   *
   * there is no duration and no format count here, and there cannot be: the
   * listing is flat, so it holds no formats, and one duration for a list of
   * videos is not a number. how long the list is takes their place, bucketed -
   * the title, the playlist id and the link are the answer to "which playlist",
   * which is not a question telemetry asks.
   *
   * both routes to a loaded playlist come through here, so the pure playlist
   * link and the ambiguous one answered "the playlist" report the same thing.
   * playlists are a youtube feature and this is the only platform that reaches
   * it (isPlaylistPlatform, ipc-handlers.js).
   */
  track("media_info_loaded", {
    platform: "youtube",
    playlist_size: playlistSizeBucket(info)
  })
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
 * store is still waiting for; every other one is dropped where it lands, and it
 * is taken by the submission rather than here so that a submission of any kind
 * invalidates this one the moment it starts.
 */
async function loadPlaylist(url: string, token: number, reveal: () => void) {
  usePlaylistStore.getState().setIsLoadingPlaylistInfo(true)

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
    commitPlaylist(url, info, reveal)
  } catch (error) {
    // a superseded lookup does not get to report its failure either: the user
    // has moved on, and the answer they are waiting for is somebody else's
    if (!usePlaylistStore.getState().isCurrentLookup(token)) {
      return
    }

    const category = error instanceof DownloadError ? error.category : undefined

    // main's sentence, in the reader's language where a category names one -
    // the same swap handleSearchError makes for a video lookup
    const message =
      error instanceof Error
        ? localizeError({ message: error.message, category }).message
        : t("playlist.infoFailed")

    // the one failure here the user can fix, and main has already said which
    // it is. a listing is a youtube lookup like any other, so it gets the same
    // toast a refused video lookup does, cookie action included
    if (category === "BOT_DETECTION") {
      showBotDetectionToast(message, "youtube")
    } else {
      toast.error(t("playlist.infoFailed"), { description: message })
    }

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
    error instanceof Error ? error.message : t(config.errorMessages.genericFail)

  // main's sentence is matched in english below, because that is the language it
  // is written in, and shown in the reader's - which are two different strings
  // once the locale is russian
  const shown = localizeError({
    message: errorMessage,
    category: error instanceof DownloadError ? error.category : undefined
  }).message

  // checked first, and on the category rather than the wording: this is the one
  // failure here the user can actually fix, and main already decided which it
  // is. matching on text would put it behind whichever generic branch happened
  // to catch the sentence first
  if (
    error instanceof DownloadError &&
    error.category === "BOT_DETECTION"
  ) {
    // the platform decides which action the toast offers: BOT_DETECTION also
    // catches tiktok and pinterest, and the cookie dialog is youtube's alone
    showBotDetectionToast(shown, config.id)
  } else if (errorMessage.includes(en[config.errorMessages.invalidUrl])) {
    // matched against english on purpose: this sentence came from main, which
    // stays english so its wording keeps feeding logs and issue bodies. only
    // what the user is shown gets translated
    toast.error(t(config.errorMessages.invalidUrlToast))
    form.setError("url", { message: config.errorMessages.invalidUrl })
  } else if (
    errorMessage.includes("unavailable") ||
    errorMessage.includes("not found")
  ) {
    toast.error(t(config.errorMessages.unavailable))
  } else if (errorMessage.includes("image, not a video")) {
    toast.error(t("error.imageNotVideo"), {
      description: t("error.imageNotVideoDesc")
    })
  } else if (
    errorMessage.includes("network") ||
    errorMessage.includes("fetch")
  ) {
    showServerOverwhelmedToast()
  } else {
    toast.error(t(config.errorMessages.genericFail), {
      description: shown
    })
  }

  console.error(config.errorMessages.logPrefix, error)
}
