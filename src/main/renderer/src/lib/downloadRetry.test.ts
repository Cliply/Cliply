// @vitest-environment jsdom
//
// Retry is the panel's one way of starting something, and it is the only start
// in the app that does not come from a screen with the request still on it. So
// what it has to get right is everything the four hooks do around a start: the
// right channel for the kind, the store row before the ipc call, the
// `download_started` in the vocabulary that kind always uses, and a refused
// start settled rather than left at "starting" forever.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  downloadVideo: vi.fn(),
  downloadAudio: vi.fn(),
  downloadPlaylist: vi.fn(),
  downloadTikTok: vi.fn(),
  downloadPinterest: vi.fn(),
  removeHistory: vi.fn(),
  clearHistory: vi.fn(),
  showDownloadErrorToast: vi.fn(),
  track: vi.fn()
}))

vi.mock("@/lib/api", () => {
  class DownloadError extends Error {
    category?: string
    details?: string
  }

  return {
    DownloadError,
    downloadApi: {
      removeHistory: mocks.removeHistory,
      clearHistory: mocks.clearHistory
    },
    videoApi: {
      downloadVideo: mocks.downloadVideo,
      downloadAudio: mocks.downloadAudio
    },
    playlistApi: { download: mocks.downloadPlaylist },
    tiktokApi: { download: mocks.downloadTikTok },
    pinterestApi: { download: mocks.downloadPinterest }
  }
})

vi.mock("@/lib/toast-utils", () => ({
  showDownloadErrorToast: mocks.showDownloadErrorToast
}))

import { DownloadError } from "@/lib/api"
import { en } from "@/lib/i18n/en"
import {
  useDownloadsStore,
  type DownloadRow
} from "@/lib/stores/downloadsStore"
// the real one: what the Report action reads is the thing under test here, so
// a mock of it would assert that this file calls a function it also wrote
import { useReportStore } from "@/lib/stores/reportStore"

import { canRetry, retryDownload } from "./downloadRetry"

const store = () => useDownloadsStore.getState()
const staged = () => useReportStore.getState().context

const row = (overrides: Partial<DownloadRow> = {}): DownloadRow => ({
  downloadId: "old",
  kind: "video",
  platform: "youtube",
  title: "How to bake sourdough at home",
  label: "1080p mp4",
  status: "failed",
  progress: 0,
  startedAt: 1000,
  error: "Something broke",
  category: "DOWNLOAD_FAILED",
  request: { url: "https://youtu.be/abc", height: 1080, container: "mp4" },
  ...overrides
})

/** the row the retry added, which is always the newest one */
const started = () => store().rows[0]

beforeEach(() => {
  store().reset()
  useReportStore.setState({ context: null })
  vi.clearAllMocks()
  mocks.downloadVideo.mockResolvedValue({ downloadId: "new" })
  mocks.downloadAudio.mockResolvedValue({ downloadId: "new" })
  mocks.downloadPlaylist.mockResolvedValue({ downloadId: "new", itemsTotal: 3 })
  mocks.downloadTikTok.mockResolvedValue({ downloadId: "new" })
  mocks.downloadPinterest.mockResolvedValue({ downloadId: "new" })

  // `track` reaches for the bridge and swallows everything, so the spy is the
  // bridge rather than a mocked module: the property bag is what is asserted
  vi.stubGlobal("window", {
    ...window,
    electronAPI: {
      analytics: { track: mocks.track.mockResolvedValue(undefined) }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("canRetry", () => {
  test("needs a request with a url in it", () => {
    expect(canRetry(row())).toBe(true)
    expect(canRetry(row({ request: undefined }))).toBe(false)
    expect(canRetry(row({ request: { url: "" } as never }))).toBe(false)
  })
})

describe("the channel a kind goes back out on", () => {
  test("a video goes to the combined download", async () => {
    await retryDownload(row())

    expect(mocks.downloadVideo).toHaveBeenCalledWith({
      url: "https://youtu.be/abc",
      height: 1080,
      container: "mp4",
      download_id: started().downloadId
    })
  })

  test("an audio download goes to the audio one", async () => {
    await retryDownload(
      row({
        kind: "audio",
        label: "mp3",
        request: { url: "https://youtu.be/abc", audio_mode: "mp3" }
      })
    )

    expect(mocks.downloadAudio).toHaveBeenCalledWith({
      url: "https://youtu.be/abc",
      audio_mode: "mp3",
      download_id: started().downloadId
    })
  })

  test("a playlist re-sends the selection it was started with", async () => {
    await retryDownload(
      row({
        kind: "playlist",
        label: "3 videos",
        request: {
          url: "https://youtube.com/playlist?list=PL1",
          playlist_id: "PL1",
          entries: [
            { index: 1, id: "a" },
            { index: 2, id: "b" },
            { index: 4, id: "d" }
          ],
          type: "video",
          height: 1080
        }
      })
    )

    expect(mocks.downloadPlaylist).toHaveBeenCalledWith(
      expect.objectContaining({
        playlist_id: "PL1",
        entries: [
          { index: 1, id: "a" },
          { index: 2, id: "b" },
          { index: 4, id: "d" }
        ],
        download_id: started().downloadId
      })
    )
  })

  test.each([
    [
      "tiktok" as const,
      () => mocks.downloadTikTok,
      () => mocks.downloadPinterest
    ],
    [
      "pinterest" as const,
      () => mocks.downloadPinterest,
      () => mocks.downloadTikTok
    ]
  ])("a %s pin or clip goes to its own api", async (platform, sent, other) => {
    await retryDownload(
      row({
        kind: "simple",
        platform,
        label: platform,
        request: { url: "https://example.com/one" }
      })
    )

    expect(sent()).toHaveBeenCalledWith({
      url: "https://example.com/one",
      download_id: started().downloadId
    })
    expect(other()).not.toHaveBeenCalled()
  })

  /**
   * main annotates a stored request with the platform it belongs to (see
   * retryRequest in ipc-handlers.js) so a reload can tell which channel to send
   * it on. it is not part of any of the four requests, and the preload injects
   * the real one on the way out, so it is dropped rather than echoed.
   */
  test("main's own annotation on the request is not sent back", async () => {
    await retryDownload(
      row({
        request: {
          url: "https://youtu.be/abc",
          height: 1080,
          container: "mp4",
          platform: "youtube"
        }
      })
    )

    expect(mocks.downloadVideo).toHaveBeenCalledWith(
      expect.not.objectContaining({ platform: expect.anything() })
    )
  })
})

describe("the row a retry adds", () => {
  test("is a new download, in front, with nothing of the old one's outcome", async () => {
    store().add(row({ fileSize: 100, finishedAt: 2000 }))

    await retryDownload(store().rows[0])

    expect(store().rows).toHaveLength(2)
    expect(started()).toMatchObject({
      kind: "video",
      platform: "youtube",
      title: "How to bake sourdough at home",
      label: "1080p mp4",
      status: "starting",
      progress: 0
    })
    expect(started().downloadId).not.toBe("old")
    expect(started().error).toBeUndefined()
    expect(started().category).toBeUndefined()
    expect(started().fileSize).toBeUndefined()
    expect(started().finishedAt).toBeUndefined()
  })

  /**
   * the failed row stays. it is a different download with its own id, its
   * failure is what an issue report would be about, and forgetting it here
   * would erase it from the history on disk without being asked.
   */
  test("and leaves the attempt it came from alone", async () => {
    store().add(row())

    await retryDownload(store().rows[0])

    expect(
      store().rows.find((entry) => entry.downloadId === "old")?.status
    ).toBe("failed")
  })

  test("exists before the ipc call, so a cancel has something to find", async () => {
    let rowsWhenCalled = 0
    mocks.downloadVideo.mockImplementation(() => {
      rowsWhenCalled = store().rows.length
      return Promise.resolve({ downloadId: "new" })
    })

    await retryDownload(row())

    expect(rowsWhenCalled).toBe(1)
  })
})

describe("a start main refuses", () => {
  test("settles the row rather than leaving it starting", async () => {
    mocks.downloadVideo.mockRejectedValue(
      new Error("Download folder is not writable")
    )

    await retryDownload(row())

    expect(started()).toMatchObject({
      status: "failed",
      error: "Download folder is not writable"
    })
  })

  test("and tells whoever pressed Retry", async () => {
    mocks.downloadVideo.mockRejectedValue(new Error("No."))

    await retryDownload(row())

    expect(mocks.showDownloadErrorToast).toHaveBeenCalledWith(
      en["downloads.retryFailed"],
      "No.",
      undefined,
      "youtube"
    )
  })

  /**
   * that toast offers to report the failure, and the dialog behind the action
   * renders nothing without a staged context - so a retry that toasted without
   * staging left the Report button dead, or worse, opened whatever earlier
   * failure was still staged, with its url and its platform.
   *
   * no progress event exists for a refused start, so `DownloadEvents` cannot
   * make up for it: staging here is the only chance.
   */
  test("stages the failure so Report has something to open", async () => {
    const refusal = new DownloadError("Download folder is not writable")
    refusal.category = "PERMISSION_ERROR"
    refusal.details = "EACCES, mkdir '/Volumes/gone/Cliply'"
    mocks.downloadVideo.mockRejectedValue(refusal)

    await retryDownload(row())

    expect(staged()).toEqual({
      shortMessage: "Download folder is not writable",
      details: "EACCES, mkdir '/Volumes/gone/Cliply'",
      category: "PERMISSION_ERROR",
      platform: "youtube",
      downloadType: "video",
      videoUrl: "https://youtu.be/abc"
    })
  })

  test("and stages it before the toast that offers to send it", async () => {
    let stagedWhenToasted: unknown = "not called"
    mocks.showDownloadErrorToast.mockImplementation(() => {
      stagedWhenToasted = staged()
    })
    mocks.downloadVideo.mockRejectedValue(new Error("No."))

    await retryDownload(row())

    expect(stagedWhenToasted).toMatchObject({ shortMessage: "No." })
  })

  test("names the platform the download belonged to", async () => {
    mocks.downloadTikTok.mockRejectedValue(new Error("TikTok said no."))

    await retryDownload(
      row({
        kind: "simple",
        platform: "tiktok",
        label: "tiktok",
        request: { url: "https://example.com/one" }
      })
    )

    expect(staged()).toMatchObject({
      platform: "tiktok",
      downloadType: "video",
      videoUrl: "https://example.com/one"
    })
  })

  test("calls an audio download audio", async () => {
    mocks.downloadAudio.mockRejectedValue(new Error("No."))

    await retryDownload(
      row({
        kind: "audio",
        label: "mp3",
        request: { url: "https://youtu.be/abc", audio_mode: "mp3" }
      })
    )

    expect(staged()).toMatchObject({ downloadType: "audio" })
  })

  // a playlist of audio is a playlist row and an audio download; the request is
  // the only thing that knows, which is how the playlist hook decides too
  test("and a playlist of audio too", async () => {
    mocks.downloadPlaylist.mockRejectedValue(new Error("No."))

    await retryDownload(
      row({
        kind: "playlist",
        label: "2 videos",
        request: {
          url: "https://youtube.com/playlist?list=PL1",
          playlist_id: "PL1",
          entries: [{ index: 1, id: "a" }],
          type: "audio",
          audio_mode: "m4a"
        }
      })
    )

    expect(staged()).toMatchObject({ downloadType: "audio" })
  })

  test("while a playlist of video is video", async () => {
    mocks.downloadPlaylist.mockRejectedValue(new Error("No."))

    await retryDownload(
      row({
        kind: "playlist",
        label: "2 videos",
        request: {
          url: "https://youtube.com/playlist?list=PL1",
          playlist_id: "PL1",
          entries: [{ index: 1, id: "a" }],
          type: "video",
          height: 1080
        }
      })
    )

    expect(staged()).toMatchObject({ downloadType: "video" })
  })

  // an earlier failure's context must not be left standing in front of a
  // successful retry either: nothing is staged when nothing went wrong
  test("stages nothing when the start is accepted", async () => {
    await retryDownload(row())

    expect(staged()).toBeNull()
  })
})

describe("what is not started twice", () => {
  test("a row with no request sends nothing", async () => {
    await retryDownload(row({ request: undefined }))

    expect(mocks.downloadVideo).not.toHaveBeenCalled()
    expect(store().rows).toEqual([])
    // nothing was attempted, so there is no failure to report and no toast
    expect(staged()).toBeNull()
    expect(mocks.showDownloadErrorToast).not.toHaveBeenCalled()
  })

  /**
   * two processes writing one `.part` file corrupt each other. a retried row is
   * terminal by definition, so this can only be something started elsewhere -
   * or a second click before the first row appeared.
   */
  test("an identical download already in flight is shown instead", async () => {
    store().add(row({ downloadId: "live", status: "downloading" }))

    await retryDownload(row())

    expect(mocks.downloadVideo).not.toHaveBeenCalled()
    expect(store().panelOpen).toBe(true)
    expect(store().highlightedId).toBe("live")
    expect(store().rows).toHaveLength(1)
  })
})

describe("the download_started it sends", () => {
  const sent = () => mocks.track.mock.calls[0]

  test("describes a video the way its hook does", async () => {
    await retryDownload(
      row({
        request: {
          url: "https://youtu.be/abc",
          height: 720,
          container: "mp4",
          time_range: { start: 5, end: 20 }
        }
      })
    )

    expect(sent()).toEqual([
      "download_started",
      {
        platform: "youtube",
        media_type: "video",
        quality: "720p",
        is_trimmed: true
      }
    ])
  })

  test("names the mode of an audio download", async () => {
    await retryDownload(
      row({
        kind: "audio",
        label: "original",
        request: { url: "https://youtu.be/abc", audio_mode: "original" }
      })
    )

    expect(sent()).toEqual([
      "download_started",
      {
        platform: "youtube",
        media_type: "audio",
        quality: "original_audio",
        audio_format: "original",
        is_trimmed: false
      }
    ])
  })

  test("counts a playlist's videos", async () => {
    await retryDownload(
      row({
        kind: "playlist",
        label: "2 videos",
        request: {
          url: "https://youtube.com/playlist?list=PL1",
          playlist_id: "PL1",
          entries: [
            { index: 1, id: "a" },
            { index: 2, id: "b" }
          ],
          type: "audio",
          audio_mode: "m4a"
        }
      })
    )

    expect(sent()).toEqual([
      "download_started",
      {
        platform: "youtube",
        is_playlist: true,
        item_count: 2,
        is_trimmed: false,
        media_type: "audio",
        quality: "m4a",
        audio_format: "m4a"
      }
    ])
  })

  test("says best_available for the platforms that offer no choice", async () => {
    await retryDownload(
      row({
        kind: "simple",
        platform: "tiktok",
        label: "tiktok",
        request: { url: "https://example.com/one" }
      })
    )

    expect(sent()).toEqual([
      "download_started",
      {
        platform: "tiktok",
        media_type: "video",
        quality: "best_available",
        is_trimmed: false
      }
    ])
  })

  test("and nothing at all when there was nothing to start", async () => {
    await retryDownload(row({ request: undefined }))

    expect(mocks.track).not.toHaveBeenCalled()
  })
})
