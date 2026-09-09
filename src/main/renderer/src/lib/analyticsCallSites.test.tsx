// @vitest-environment jsdom
//
// every telemetry bag the renderer can build, driven out of the real hooks and
// components against mocked apis and recorded as it crosses the preload bridge.
//
// the recorded list is compared to analytics-payloads.fixture.json, which the
// main suite (tests/renderer-analytics.test.js) replays through the real
// Analytics: an allowed property name is only half the contract, and a value
// that fails the validator is dropped behind a console.warn production never
// shows anyone. The fixture is the only thing tying the two runners together -
// changing a call site fails here, and the change is then proved sendable
// there.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, renderHook, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"

import payloads from "./analytics-payloads.fixture.json"
import type { AudioDownloadRequest, VideoDownloadRequest } from "@/lib/api"
import type { Platform } from "@/lib/store"

type Bag = { event: string; properties: Record<string, unknown> }
type ProgressListener = (payload: Record<string, unknown>) => void

const mocks = vi.hoisted(() => ({
  getVideoInfo: vi.fn(),
  getPlaylistInfo: vi.fn(),
  getPinInfo: vi.fn(),
  getTikTokInfo: vi.fn(),
  downloadVideo: vi.fn(),
  downloadAudio: vi.fn(),
  downloadPlaylist: vi.fn(),
  downloadPin: vi.fn(),
  downloadTikTok: vi.fn(),
  listeners: [] as ProgressListener[]
}))

vi.mock("@/lib/api", () => {
  class DownloadError extends Error {
    details?: string
    category?: string

    constructor(
      message: string,
      error?: { details?: string; category?: string }
    ) {
      super(message)
      this.name = "DownloadError"
      this.details = error?.details
      this.category = error?.category
    }
  }

  return {
    DownloadError,
    videoApi: {
      getVideoInfo: (url: string) => mocks.getVideoInfo(url),
      downloadVideo: (request: unknown) => mocks.downloadVideo(request),
      downloadAudio: (request: unknown) => mocks.downloadAudio(request)
    },
    playlistApi: {
      getPlaylistInfo: (url: string) => mocks.getPlaylistInfo(url),
      download: (request: unknown) => mocks.downloadPlaylist(request)
    },
    pinterestApi: {
      getInfo: (url: string) => mocks.getPinInfo(url),
      download: (request: unknown) => mocks.downloadPin(request)
    },
    tiktokApi: {
      getInfo: (url: string) => mocks.getTikTokInfo(url),
      download: (request: unknown) => mocks.downloadTikTok(request)
    },
    // the youtube card reads it; the two cards driven here never render it
    validateTimeRange: () => ({ isValid: true }),
    downloadApi: {
      onProgress: (listener: ProgressListener) => {
        mocks.listeners.push(listener)
        return () => {
          const index = mocks.listeners.indexOf(listener)
          if (index >= 0) mocks.listeners.splice(index, 1)
        }
      },
      cancelDownload: vi.fn()
    },
    systemApi: { openDownloadFolder: vi.fn() }
  }
})

vi.mock("@/lib/reportStore", () => ({ reportActions: { stage: vi.fn() } }))
vi.mock("@/lib/toast-utils", () => ({
  showDownloadErrorToast: vi.fn(),
  showServerOverwhelmedToast: vi.fn(),
  showBotDetectionToast: vi.fn()
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

import { SearchCard } from "@/components/hero/SearchCard"
import { UnifiedDownloadCard } from "@/components/video/UnifiedDownloadCard"
import { DownloadError } from "@/lib/api"
import { useAudioDownload } from "@/lib/hooks/useAudioDownload"
import { useMediaSearch } from "@/lib/hooks/useMediaSearch"
import { usePlaylistDownload } from "@/lib/hooks/usePlaylistDownload"
import { useVideoDownload } from "@/lib/hooks/useVideoDownload"
import { useMixedLinkStore } from "@/lib/mixedLinkStore"
import { usePinterestStore } from "@/lib/pinterestStore"
import { usePlaylistStore } from "@/lib/playlistStore"
import { useTikTokStore } from "@/lib/tiktokStore"

let recorded: Bag[]

beforeEach(() => {
  recorded = []
  mocks.listeners.length = 0
  vi.clearAllMocks()
  // an ambiguous link is asked about once per session, so the answer one case
  // gives must not carry into the next
  useMixedLinkStore.getState().reset()
  // ...and a listing left loaded is a selection the next playlist download
  // would send
  usePlaylistStore.getState().reset()

  // handleSearchError logs every failure, and the failures below are the point
  vi.spyOn(console, "error").mockImplementation(() => {})
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    analytics: {
      track: (event: string, properties: Record<string, unknown>) => {
        recorded.push({ event, properties })
        return Promise.resolve({ success: true })
      }
    }
  }
})

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  })

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/**
 * click the helper line's playlist link, on the real search box
 *
 * driven through SearchCard rather than URLInput alone because the box's form
 * is useMediaSearch's: the click writes a url into the same form a paste lands
 * in, and a hand-rolled one here would report a bag no user can produce.
 */
async function clickPlaylistHint() {
  const view = render(<SearchCard platform="youtube" />)

  await act(async () => {
    screen.getByRole("button", { name: "playlists" }).click()
  })

  view.unmount()
}

/** put a url through the real submit flow, whatever the api does with it */
async function search(platform: Platform, url: string) {
  const { result, unmount } = renderHook(() => useMediaSearch(platform))

  await act(async () => {
    await result.current.onSubmit({ url })
  })

  unmount()
}

const youtubeInfo = (duration: number | null, tiers: number) => ({
  title: "My Holiday Video",
  duration,
  duration_string: "4:00",
  uploader: "Someone",
  quality_tiers: Array.from({ length: tiers }, (_, index) => ({
    height: 144 * (index + 1),
    container: "mp4",
    filesize: null,
    fps: null
  })),
  audio_tracks: []
})

/**
 * enough of a listing for the mixed-link prompt to have something to ask about
 *
 * `count` is the playlist's true size and `listed` how many rows came back,
 * capped at 100 - they differ for a channel-sized list, and the bucket is
 * derived from the first
 */
const listingOf = (count: number, listed = count) => ({
  playlist_id: "PL123",
  title: "Short talks",
  uploader: "Someone",
  count,
  listed,
  truncated: listed < count,
  entries: []
})

const playlistListing = listingOf(2)

const playlistEntry = (index: number) => ({
  index,
  id: `video${index}`,
  title: "My Holiday Video",
  duration: 60,
  duration_string: "1:00",
  thumbnail: null,
  unavailable: false
})

/** press one of the prompt's two buttons, the way the dialog does */
async function answerMixedLink(choice: "video" | "playlist") {
  await act(async () => {
    useMixedLinkStore.getState().answer(choice)
    // the video branch is a lookup the answer itself does not wait for
    await Promise.resolve()
    await Promise.resolve()
  })
}

const simpleInfo = (duration: number | null) => ({
  title: "My Holiday Video",
  duration,
  duration_string: "0:45",
  thumbnail: null,
  uploader: "Someone"
})

/**
 * run one download far enough to send its event, then settle it
 *
 * the mutation is only resolved by a terminal progress event, so a download
 * left running would keep a listener alive and a promise pending into the next
 * case.
 */
async function download(
  hook: typeof useVideoDownload | typeof useAudioDownload,
  request: VideoDownloadRequest | AudioDownloadRequest,
  api: typeof mocks.downloadVideo
) {
  const { result, unmount } = renderHook(() => hook(), { wrapper })

  let pending!: Promise<unknown>

  await act(async () => {
    pending = (
      result.current as { mutateAsync: (request: unknown) => Promise<unknown> }
    ).mutateAsync(request)
  })
  pending.catch(() => {})

  const downloadId = api.mock.calls.at(-1)?.[0].download_id as string

  await act(async () => {
    for (const listener of [...mocks.listeners]) {
      listener({ downloadId, status: "completed", filename: "clip.mp4" })
    }
  })

  await pending
  unmount()
}

const startVideo = (request: Partial<VideoDownloadRequest>) =>
  download(
    useVideoDownload,
    {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      height: 1080,
      container: "mp4",
      title: "My Holiday Video",
      ...request
    },
    mocks.downloadVideo
  )

/**
 * click the one button pinterest and tiktok have
 *
 * neither platform offers a choice of anything, so the whole download is a
 * store url and a click - there is no hook to drive and no request to build.
 */
async function startSimpleDownload(platform: "pinterest" | "tiktok") {
  const store =
    platform === "pinterest"
      ? usePinterestStore.getState()
      : useTikTokStore.getState()

  store.setUrl(
    platform === "pinterest"
      ? "https://pin.it/abc123"
      : "https://vm.tiktok.com/ZM123/"
  )

  const info = {
    title: "My Holiday Video",
    duration: 45,
    duration_string: "0:45",
    thumbnail: null,
    uploader: "Someone"
  }

  const view = render(
    platform === "pinterest" ? (
      <UnifiedDownloadCard platform="pinterest" pinInfo={info} />
    ) : (
      <UnifiedDownloadCard platform="tiktok" tikTokInfo={info} />
    )
  )

  await act(async () => {
    screen.getByRole("button", { name: /download video/i }).click()
  })

  view.unmount()
}

/**
 * run one playlist download far enough to send its start event, then settle it
 *
 * the selection comes from the store rather than from a request argument,
 * because that is where the hook reads it: `buildPlaylistDownloadRequest` joins
 * the ticked positions against the listing on screen, and `item_count` is how
 * many of those there were.
 */
async function startPlaylist(tab: "video" | "audio") {
  const store = usePlaylistStore.getState()

  store.setLoadedPlaylist("https://www.youtube.com/playlist?list=PL123", {
    ...playlistListing,
    entries: [playlistEntry(1), playlistEntry(2)]
  })

  if (tab === "audio") {
    usePlaylistStore.getState().setActiveTab("audio")
    usePlaylistStore.getState().setSelectedAudioMode("m4a")
  }

  const { result, unmount } = renderHook(() => usePlaylistDownload(), {
    wrapper
  })

  let pending!: Promise<unknown>

  await act(async () => {
    pending = result.current.mutateAsync({})
  })
  pending.catch(() => {})

  const downloadId = mocks.downloadPlaylist.mock.calls.at(-1)?.[0]
    .download_id as string

  // a playlist mutation is only settled by a terminal progress event, so a run
  // left going would hold a listener into the next case
  await act(async () => {
    for (const listener of [...mocks.listeners]) {
      listener({
        downloadId,
        status: "completed",
        progress: 100,
        items_saved: 2,
        items_reused: 0,
        items_skipped: 0,
        items_total: 2
      })
    }
  })

  await pending
  unmount()
}

const startAudio = (request: Partial<AudioDownloadRequest>) =>
  download(
    useAudioDownload,
    {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      audio_mode: "mp3",
      title: "My Holiday Video",
      ...request
    },
    mocks.downloadAudio
  )

describe("the bags the call sites build", () => {
  test("are exactly the ones the main suite validates", async () => {
    mocks.downloadVideo.mockResolvedValue({ downloadId: "ignored" })
    mocks.downloadAudio.mockResolvedValue({ downloadId: "ignored" })

    /**
     * the one thing on the hero that is not a paste.
     *
     * the helper line says playlists work and offers one to try, and this is
     * how often that offer is taken. it carries the platform and nothing else:
     * the link is ours, so there is no url_kind to report about it, and the
     * submission it leads to reports itself like any other paste.
     */
    await clickPlaylistHint()

    // --- the front of the funnel, one link shape at a time ---
    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(240, 6))
    await search("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(30, 2))
    await search("youtube", "https://www.youtube.com/shorts/abc123")

    /**
     * a link naming a video *and* the playlist it sits in.
     *
     * this used to be one more search: the link went straight to the single
     * video, so `url_submitted` and `media_info_loaded` came out of the one
     * call. it is now asked about first, and the video's own bags arrive only
     * once "Just this video" is answered - so the answer is driven here, and
     * the pair of bags is unchanged.
     *
     * between them sits the answer itself, which is the question the prompt was
     * built to ask: how often somebody pastes a link like this and did not mean
     * the video Cliply used to take out of it silently.
     */
    mocks.getPlaylistInfo.mockResolvedValueOnce(playlistListing)
    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(900, 4))
    await search("youtube", "https://www.youtube.com/watch?v=abc&list=PL123")
    await answerMixedLink("video")

    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(2400, 1))
    await search("youtube", "https://youtu.be/dQw4w9WgXcQ")

    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(5000, 3))
    await search("youtube", "https://www.youtube.com/embed/abc123")

    // a failure main classified for us
    mocks.getVideoInfo.mockRejectedValueOnce(
      new DownloadError("YouTube asked us to confirm you're not a bot.", {
        message: "YouTube asked us to confirm you're not a bot.",
        category: "BOT_DETECTION",
        details: "ERROR: [youtube] Sign in to confirm you're not a bot"
      })
    )
    await search("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    // and one nobody classified - the preload's own catch throws a bare Error
    mocks.getVideoInfo.mockRejectedValueOnce(
      new Error("Communication error with main process")
    )
    await search("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    mocks.getPinInfo.mockResolvedValueOnce(simpleInfo(45))
    await search("pinterest", "https://pin.it/abc123")

    // a pin with no duration on it at all
    mocks.getPinInfo.mockResolvedValueOnce(simpleInfo(null))
    await search("pinterest", "https://www.pinterest.com/pin/12345/")

    mocks.getTikTokInfo.mockResolvedValueOnce(simpleInfo(20))
    await search("tiktok", "https://www.tiktok.com/@someone/video/12345")

    mocks.getTikTokInfo.mockResolvedValueOnce(simpleInfo(12))
    await search("tiktok", "https://vm.tiktok.com/ZM123/")

    mocks.getTikTokInfo.mockRejectedValueOnce(
      new DownloadError("Network interrupted the download.", {
        message: "Network interrupted the download.",
        category: "NETWORK_ERROR"
      })
    )
    await search("tiktok", "https://www.tiktok.com/@someone/video/12345")

    /**
     * a link that is only a playlist, which is the one youtube link that names
     * no video at all.
     *
     * its `media_info_loaded` carries neither a duration nor a format count and
     * cannot: a flat listing has no formats, and one duration for a list of
     * videos is not a thing. what it carries instead is how many videos are in
     * it, bucketed - the reason `URL_KINDS.playlist` was added in the first
     * place was to ask how often this happens, and this is the other half of
     * that answer
     */
    mocks.getPlaylistInfo.mockResolvedValueOnce(listingOf(30))
    await search("youtube", "https://www.youtube.com/playlist?list=PL456")

    /**
     * ...and an ambiguous link answered the other way. a different link from the
     * one above, because an answer is remembered per link and a repeat would
     * skip the question rather than ask it again.
     *
     * the listing is a channel-sized one truncated at the item cap: the bucket
     * comes off `count`, what the platform says the list holds, not off the
     * hundred rows we listed
     */
    mocks.getPlaylistInfo.mockResolvedValueOnce(listingOf(5283, 100))
    await search("youtube", "https://www.youtube.com/watch?v=xyz&list=PL999")
    await answerMixedLink("playlist")

    // --- and the downloads those searches lead to ---
    await startVideo({ height: 1080 })
    await startVideo({ height: 2160, time_range: { start: 10, end: 30 } })
    // the store's opening range: main throws this away, so neither may call it
    // a trimmed download
    await startVideo({ height: 720, time_range: { start: 0, end: 0 } })
    // a height no menu row could have produced. the validator would drop the
    // quality behind a warning, so the property is left out instead
    await startVideo({ height: 0 })

    await startAudio({ audio_mode: "mp3" })
    await startAudio({
      audio_mode: "m4a",
      time_range: { start: 10, end: 30 }
    })
    await startAudio({ audio_mode: "original" })

    // the two platforms that offer no choice at all. main falls back to the
    // platform name for their format id, which extractQuality reads as
    // "best_available", and it never marks them trimmed
    mocks.downloadPin.mockResolvedValue({ downloadId: "ignored" })
    mocks.downloadTikTok.mockResolvedValue({ downloadId: "ignored" })
    await startSimpleDownload("pinterest")
    await startSimpleDownload("tiktok")

    /**
     * one download of n videos, on each tab.
     *
     * it extends `download_started` rather than sending an event of its own, so
     * the funnel joins on the same dimensions: the same platform, the same media
     * type, and `quality` as the ceiling that was asked for. what a playlist adds
     * is that it is one, and how many videos were ticked.
     *
     * `is_trimmed` is false by construction - the playlist operation does not
     * accept a range at all, which is a stronger statement than the control
     * being hidden
     */
    mocks.downloadPlaylist.mockResolvedValue({ downloadId: "ignored" })
    await startPlaylist("video")
    await startPlaylist("audio")

    expect(recorded).toEqual(payloads.callSites)
  })

  test("say nothing about the url, the title or the file", async () => {
    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(240, 6))
    await search(
      "youtube",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&si=abcdef"
    )

    mocks.downloadVideo.mockResolvedValue({ downloadId: "ignored" })
    await startVideo({ height: 1080 })

    const serialised = JSON.stringify(recorded)
    expect(serialised).not.toContain("dQw4w9WgXcQ")
    expect(serialised).not.toContain("youtube.com")
    expect(serialised).not.toContain("My Holiday Video")
    expect(serialised).not.toContain("clip.mp4")
  })

  test("forward an unvouched-for failure message as it arrived", async () => {
    // free text is the one thing the renderer cannot make safe: pre-scrubbing
    // here would be a second, weaker copy of the boundary's own redaction. what
    // this proves is that the raw text reaches it - the main suite proves what
    // it does with it
    mocks.getVideoInfo.mockRejectedValueOnce(
      new Error(
        "ERROR: unable to open for writing: [Errno 13] Permission denied: '/Users/someone/Movies/My Holiday Video.mp4'"
      )
    )
    await search("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    expect(recorded[1]).toEqual(payloads.unvouchedText[0])
  })

  test("send nothing when the submit belongs to somebody else", async () => {
    // CompactSearch can hand the hook an onSearch, which takes the whole flow
    // away - there is no request to report and no result to report about
    const onSearch = vi.fn()
    const { result, unmount } = renderHook(() =>
      useMediaSearch("youtube", { onSearch })
    )

    await act(async () => {
      await result.current.onSubmit({ url: "https://youtu.be/dQw4w9WgXcQ" })
    })
    unmount()

    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual([])
  })
})
