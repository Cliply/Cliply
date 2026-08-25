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
import type {
  AudioDownloadRequest,
  TranscriptFormat,
  TranscriptTrack,
  VideoDownloadRequest,
  VideoInfoResponse
} from "@/lib/api"
import type { Platform } from "@/lib/store"

type Bag = { event: string; properties: Record<string, unknown> }
type ProgressListener = (payload: Record<string, unknown>) => void

const mocks = vi.hoisted(() => ({
  getVideoInfo: vi.fn(),
  getPinInfo: vi.fn(),
  getTikTokInfo: vi.fn(),
  downloadVideo: vi.fn(),
  downloadAudio: vi.fn(),
  downloadPin: vi.fn(),
  downloadTikTok: vi.fn(),
  downloadTranscript: vi.fn(),
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
    pinterestApi: {
      getInfo: (url: string) => mocks.getPinInfo(url),
      download: (request: unknown) => mocks.downloadPin(request)
    },
    tiktokApi: {
      getInfo: (url: string) => mocks.getTikTokInfo(url),
      download: (request: unknown) => mocks.downloadTikTok(request)
    },
    transcriptApi: {
      download: (request: unknown) => mocks.downloadTranscript(request)
    },
    // the transcript button prints the language as a name; the code is what
    // travels, and it is the same either way
    languageName: (code: string) => code,
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
  showServerOverwhelmedToast: vi.fn()
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

import { TranscriptDownloadButton } from "@/components/video/TranscriptDownloadButton"
import { UnifiedDownloadCard } from "@/components/video/UnifiedDownloadCard"
import { DownloadError } from "@/lib/api"
import { useAudioDownload } from "@/lib/hooks/useAudioDownload"
import { useMediaSearch } from "@/lib/hooks/useMediaSearch"
import { useVideoDownload } from "@/lib/hooks/useVideoDownload"
import { usePinterestStore } from "@/lib/pinterestStore"
import { useTikTokStore } from "@/lib/tiktokStore"
import { useYouTubeStore } from "@/lib/youtubeStore"

let recorded: Bag[]

beforeEach(() => {
  recorded = []
  mocks.listeners.length = 0
  vi.clearAllMocks()

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
  audio_tracks: [],
  transcripts: []
})

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
 * click the transcript button, which is the whole flow
 *
 * there is no hook here and no progress to follow: a subtitle track is small
 * enough that the ipc call resolves with the finished file, so the component
 * is driven directly with the store seeded the way the tab would have left it.
 */
async function startTranscript(
  track: TranscriptTrack,
  format: TranscriptFormat
) {
  useYouTubeStore.setState({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    videoInfo: youtubeInfo(240, 1) as unknown as VideoInfoResponse,
    selectedTranscript: track.code,
    selectedTranscriptFormat: format,
    isDownloadingTranscript: false
  })

  const view = render(<TranscriptDownloadButton tracks={[track]} isVisible />)

  await act(async () => {
    screen.getByRole("button", { name: /download transcript/i }).click()
  })

  view.unmount()
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

    // --- the front of the funnel, one link shape at a time ---
    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(240, 6))
    await search("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(30, 2))
    await search("youtube", "https://www.youtube.com/shorts/abc123")

    mocks.getVideoInfo.mockResolvedValueOnce(youtubeInfo(900, 4))
    await search("youtube", "https://www.youtube.com/watch?v=abc&list=PL123")

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

    // a transcript has no quality axis, so all three formats report the same
    // quality label and differ only in transcript_format
    mocks.downloadTranscript.mockResolvedValue({
      filename: "clip.en.srt",
      file_path: "/downloads/clip.en.srt",
      file_size: 1234,
      download_id: "ignored",
      format: "srt",
      language: "en"
    })
    await startTranscript({ code: "en", is_auto: false }, "srt")
    await startTranscript({ code: "es", is_auto: true }, "vtt")
    await startTranscript({ code: "en", is_auto: false }, "txt")

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
