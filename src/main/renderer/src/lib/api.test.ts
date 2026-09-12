// @vitest-environment jsdom
//
// what an info failure carries once it has crossed ipc.
//
// main classifies the failure itself and puts the answer in `category`
// (infoFailure in ipc-handlers.js) - `code` beside it is the engine's own
// code or the "GENERAL_ERROR" placeholder, which is not a taxonomy value at
// all. throwing a bare Error here discarded both, so every media_info_failed
// the renderer could report was UNKNOWN_ERROR.

import { afterEach, describe, expect, test, vi } from "vitest"

import {
  DownloadError,
  downloadApi,
  pinterestApi,
  playlistApi,
  tiktokApi,
  videoApi
} from "./api"
import type { DownloadHistoryRow, PlaylistDownloadRequest } from "./api"

type Responder = () => unknown

function bridge({ getInfo }: { getInfo: Responder }) {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    video: { getInfo: async () => getInfo() },
    pinterest: { getInfo: async () => getInfo() },
    tiktok: { getInfo: async () => getInfo() }
  }
}

const FAILURE = {
  success: false,
  error: {
    message: "YouTube asked us to confirm you're not a bot.",
    suggestion: "Import your YouTube cookies from Settings and try again.",
    code: "BOT_DETECTION",
    details: "ERROR: [youtube] Sign in to confirm you're not a bot",
    category: "BOT_DETECTION"
  }
}

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe("an info request that failed", () => {
  test.each([
    ["youtube", () => videoApi.getVideoInfo("https://youtu.be/abc")],
    ["pinterest", () => pinterestApi.getInfo("https://pin.it/abc")],
    ["tiktok", () => tiktokApi.getInfo("https://vm.tiktok.com/abc")]
  ])("carries %s's classification back to the caller", async (_name, call) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    bridge({ getInfo: () => FAILURE })

    const error = await call().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DownloadError)
    // still an Error, so every existing `instanceof Error` branch is unmoved
    expect(error).toBeInstanceOf(Error)
    expect((error as DownloadError).message).toBe(FAILURE.error.message)
    expect((error as DownloadError).category).toBe("BOT_DETECTION")
    expect((error as DownloadError).details).toBe(FAILURE.error.details)
  })

  test("survives a failure that carried no classification", async () => {
    // the preload's own catch returns {message, suggestion} and nothing else
    vi.spyOn(console, "error").mockImplementation(() => {})
    bridge({
      getInfo: () => ({
        success: false,
        error: { message: "Communication error with main process" }
      })
    })

    const error = (await videoApi
      .getVideoInfo("https://youtu.be/abc")
      .catch((thrown: unknown) => thrown)) as DownloadError

    expect(error.message).toBe("Communication error with main process")
    expect(error.category).toBeUndefined()
  })
})

describe("the playlist client", () => {
  const LISTING = {
    playlist_id: "PLLojVvWCZ5N4",
    title: "Short talks",
    uploader: "TED",
    count: 183,
    listed: 100,
    truncated: true,
    entries: [
      {
        index: 1,
        id: "aaaaaaaaaaa",
        title: "One",
        duration: 307,
        duration_string: "05:07",
        thumbnail: null,
        unavailable: false
      }
    ]
  }

  const REQUEST: PlaylistDownloadRequest = {
    url: "https://www.youtube.com/playlist?list=PLLojVvWCZ5N4",
    playlist_id: "PLLojVvWCZ5N4",
    entries: [{ index: 1, id: "aaaaaaaaaaa" }],
    height: 1080
  }

  function playlistBridge(responder: Responder) {
    const sent: unknown[] = []

    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      playlist: {
        getInfo: async (options: unknown) => {
          sent.push(options)
          return responder()
        },
        download: async (options: unknown) => {
          sent.push(options)
          return responder()
        }
      }
    }

    return sent
  }

  test("a listing comes back whole, truncation included", async () => {
    playlistBridge(() => ({ success: true, data: LISTING }))

    const listing = await playlistApi.getPlaylistInfo(
      "https://www.youtube.com/playlist?list=PLLojVvWCZ5N4"
    )

    // "there is more of this than we are showing you" is only sayable when the
    // true size is known, so both numbers have to survive the trip
    expect(listing.count).toBe(183)
    expect(listing.listed).toBe(100)
    expect(listing.truncated).toBe(true)
    expect(listing.entries[0].unavailable).toBe(false)
  })

  test("a download returns the one id the whole playlist reports under", async () => {
    const sent = playlistBridge(() => ({
      success: true,
      data: {
        download_id: "playlist_1",
        status: "started",
        type: "combined",
        items_total: 1
      }
    }))

    const started = await playlistApi.download(REQUEST)

    expect(started).toEqual({ downloadId: "playlist_1", itemsTotal: 1 })
    expect(sent[0]).toEqual(REQUEST)
  })

  test.each([
    ["a listing", () => playlistApi.getPlaylistInfo("https://youtu.be/list")],
    ["a download", () => playlistApi.download(REQUEST)]
  ])("%s that failed carries its classification back", async (_name, call) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    playlistBridge(() => FAILURE)

    const error = await call().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DownloadError)
    expect((error as DownloadError).category).toBe("BOT_DETECTION")
    expect((error as DownloadError).details).toBe(FAILURE.error.details)
  })
})

/**
 * the history the panel hydrates from, and the two ways of forgetting part of
 * it. all three answer with the rows that are left, so the panel never has to
 * work out which of its rows survived.
 */
describe("the download history client", () => {
  const ROW: DownloadHistoryRow = {
    download_id: "d1",
    status: "completed",
    kind: "video",
    platform: "youtube",
    title: "My Holiday Video",
    label: "1080p mp4",
    started_at: 1000,
    finished_at: 2000,
    filename: "clip.mp4",
    file_size: 999
  }

  function historyBridge(responder: Responder) {
    const sent: unknown[] = []

    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      download: {
        getHistory: async () => responder(),
        clearHistory: async () => responder(),
        removeHistory: async (downloadId: unknown) => {
          sent.push(downloadId)
          return responder()
        }
      }
    }

    return sent
  }

  test("the rows come back as they were written, with their epoch", async () => {
    historyBridge(() => ({ success: true, data: { epoch: 3, rows: [ROW] } }))

    await expect(downloadApi.getHistory()).resolves.toEqual({
      epoch: 3,
      rows: [ROW]
    })
  })

  test("clearing and removing answer with what is left", async () => {
    const sent = historyBridge(() => ({
      success: true,
      data: { epoch: 4, rows: [ROW] }
    }))

    await expect(downloadApi.clearHistory()).resolves.toEqual({
      epoch: 4,
      rows: [ROW]
    })
    await expect(downloadApi.removeHistory("d2")).resolves.toEqual({
      epoch: 4,
      rows: [ROW]
    })
    expect(sent).toEqual(["d2"])
  })

  /**
   * a panel with no history is a panel, and this is the one read the renderer
   * makes: throwing here would take the downloads list down with it
   */
  test("an empty answer is an empty list, not a failure", async () => {
    historyBridge(() => ({ success: true }))

    await expect(downloadApi.getHistory()).resolves.toEqual({
      epoch: 0,
      rows: []
    })
  })

  /**
   * a build from before main stamped an epoch answers with the bare array it
   * always did. reading that as epoch 0 is the truthful version of it: older
   * than any clear, and with no clears at all nothing is ever judged stale
   */
  test("and a bare array is read as a snapshot older than any clear", async () => {
    historyBridge(() => ({ success: true, data: [ROW] }))

    await expect(downloadApi.getHistory()).resolves.toEqual({
      epoch: 0,
      rows: [ROW]
    })
  })

  test("a refusal is thrown, with main's own sentence", async () => {
    historyBridge(() => ({
      success: false,
      error: { message: "Failed to get the download history" }
    }))

    await expect(downloadApi.getHistory()).rejects.toThrow(
      "Failed to get the download history"
    )
  })
})
