// @vitest-environment jsdom
//
// a playlist follows the same contract useVideoDownload owns - which download's
// events it accepts, who reports a terminal outcome, what an unmount does - and
// adds the two things only a playlist has: a second level of progress per row,
// and a finish that has to be honest about what it did not save.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"

type ProgressListener = (payload: Record<string, unknown>) => void

const mocks = vi.hoisted(() => ({
  listeners: [] as ((payload: Record<string, unknown>) => void)[],
  stage: vi.fn(),
  showDownloadErrorToast: vi.fn(),
  successToast: vi.fn(),
  infoToast: vi.fn(),
  errorToast: vi.fn(),
  downloadPlaylist: vi.fn(),
  cancelDownload: vi.fn()
}))

const {
  listeners,
  stage,
  showDownloadErrorToast,
  successToast,
  infoToast,
  errorToast,
  downloadPlaylist,
  cancelDownload
} = mocks

vi.mock("@/lib/api", () => {
  class DownloadError extends Error {
    details?: string
    category?: string
  }

  return {
    DownloadError,
    downloadApi: {
      onProgress: (listener: ProgressListener) => {
        mocks.listeners.push(listener)

        return () => {
          const index = mocks.listeners.indexOf(listener)
          if (index >= 0) mocks.listeners.splice(index, 1)
        }
      },
      cancelDownload: (id: string) => mocks.cancelDownload(id)
    },
    playlistApi: {
      download: (request: unknown) => mocks.downloadPlaylist(request)
    },
    systemApi: { openDownloadFolder: vi.fn() }
  }
})

vi.mock("@/lib/reportStore", () => ({ reportActions: { stage: mocks.stage } }))
vi.mock("@/lib/toast-utils", () => ({
  showDownloadErrorToast: mocks.showDownloadErrorToast
}))
vi.mock("sonner", () => ({
  toast: {
    success: mocks.successToast,
    info: mocks.infoToast,
    error: mocks.errorToast
  }
}))

import { usePlaylistStore } from "@/lib/playlistStore"
import {
  summarizePlaylistItems,
  usePlaylistDownload
} from "./usePlaylistDownload"

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  })

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const entry = (index: number, overrides: Partial<PlaylistEntry> = {}): PlaylistEntry => ({
  index,
  id: `video${index}`,
  title: `video ${index}`,
  duration: 60,
  duration_string: "1:00",
  thumbnail: null,
  unavailable: false,
  ...overrides
})

const listing = (
  entries: PlaylistEntry[],
  overrides: Partial<PlaylistInfoResponse> = {}
): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "a playlist",
  uploader: "someone",
  count: entries.length,
  listed: entries.length,
  truncated: false,
  entries,
  ...overrides
})

/** a loaded playlist with three rows, the middle one deleted */
function loadPlaylist(url = "https://www.youtube.com/playlist?list=PL123") {
  usePlaylistStore.getState().setLoadedPlaylist(
    url,
    listing([
      entry(1),
      entry(2, { id: null, unavailable: true, duration: null, duration_string: null }),
      entry(3)
    ])
  )
}

type Settled = { ok: boolean; value: unknown }

async function startDownload(
  result: { current: ReturnType<typeof usePlaylistDownload> },
  options: { ignoreArchive?: boolean } = {}
) {
  let settled!: Promise<Settled>

  // the outcome handler is attached inside the same tick the mutation is
  // started in: a selection that cannot be sent rejects immediately, and a
  // handler attached a tick later would be reported as an unhandled rejection
  await act(async () => {
    settled = result.current
      .mutateAsync(options)
      .then((value: unknown) => ({ ok: true, value }))
      .catch((value: unknown) => ({ ok: false, value }))
  })

  return { settled }
}

function deferredAck() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })

  downloadPlaylist.mockReturnValueOnce(promise)

  return { resolve, reject }
}

const emit = async (payload: Record<string, unknown>) => {
  await act(async () => {
    for (const listener of [...listeners]) listener(payload)
  })
}

const sentRequest = () => downloadPlaylist.mock.calls[0][0]
const sentDownloadId = () => sentRequest().download_id as string

const flush = () => act(async () => {})

beforeEach(() => {
  listeners.length = 0
  vi.clearAllMocks()
  usePlaylistStore.getState().reset()
  loadPlaylist()
  downloadPlaylist.mockResolvedValue({ downloadId: "ignored", itemsTotal: 2 })
  cancelDownload.mockResolvedValue(true)
})

afterEach(() => {
  // every path must drop its progress listener
  expect(listeners).toHaveLength(0)
})

describe("the request the hook builds", () => {
  test("joins the ticked positions against the listing's ids", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    expect(sentRequest()).toMatchObject({
      url: "https://www.youtube.com/playlist?list=PL123",
      // required: it names the archive this run resumes from, and main refuses
      // a request without one
      playlist_id: "PL123",
      // the unavailable row is not in here, and neither are bare indices
      entries: [
        { index: 1, id: "video1" },
        { index: 3, id: "video3" }
      ],
      height: 1080,
      download_id: expect.any(String)
    })
    expect(sentRequest().audio_mode).toBeUndefined()

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })

  test("the audio tab sends a mode instead of a height", async () => {
    usePlaylistStore.getState().setActiveTab("audio")
    usePlaylistStore.getState().setSelectedAudioMode("m4a")

    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })
    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    expect(sentRequest()).toMatchObject({ type: "audio", audio_mode: "m4a" })
    expect(sentRequest().height).toBeUndefined()

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })

  /**
   * the paste box accepts a link with no protocol, and main refuses one: the
   * engine's normalizeUrl has always asked for an http(s) link. so the scheme
   * is put back before the request leaves.
   */
  test("a protocol-less link is given one", async () => {
    loadPlaylist("youtube.com/playlist?list=PL123")

    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })
    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    expect(sentRequest().url).toBe("https://youtube.com/playlist?list=PL123")

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })

  test("only a literal ignore-archive is sent", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })
    const { settled } = await startDownload(result, { ignoreArchive: true })
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    expect(sentRequest().ignore_archive).toBe(true)

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })

  test("nothing ticked starts nothing and is not reported as a bug", async () => {
    usePlaylistStore.getState().selectNone()

    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })
    const { settled } = await startDownload(result)

    expect((await settled).ok).toBe(false)
    await flush()

    expect(downloadPlaylist).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(stage).not.toHaveBeenCalled()
    expect(showDownloadErrorToast).not.toHaveBeenCalled()
  })

  test("a listing with no playlist id starts nothing", async () => {
    usePlaylistStore
      .getState()
      .setLoadedPlaylist(
        "https://www.youtube.com/playlist?list=PL123",
        listing([entry(1)], { playlist_id: null })
      )

    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })
    const { settled } = await startDownload(result)

    expect((await settled).ok).toBe(false)
    await flush()

    expect(downloadPlaylist).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
  })
})

describe("event correlation", () => {
  test("the id exists and the listener is live before the ack lands", async () => {
    const ack = deferredAck()
    const { result, unmount } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)

    expect(listeners).toHaveLength(1)
    expect(sentDownloadId()).toEqual(expect.any(String))

    ack.resolve({})
    await flush()
    unmount()

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "abandoned" }
    })
  })

  test("another download's terminal event is ignored", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await emit({ downloadId: "someone-else", status: "failed", error: "boom" })

    expect(showDownloadErrorToast).not.toHaveBeenCalled()
    expect(result.current.downloadState.status).not.toBe("failed")

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })
})

describe("what a finished run says it did", () => {
  test("a partial run reports every count and folds none of them together", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      progress: 100,
      files: ["/downloads/001 - one [video1] 1080p.mp4"],
      items_saved: 6,
      items_reused: 2,
      items_skipped: 1,
      items_total: 9
    })

    expect((await settled).ok).toBe(true)

    const state = result.current.downloadState
    expect(state.status).toBe("completed")
    // an archive reuse is not a save this run made, and adding it in would
    // claim files we did not write
    expect(state.itemsSaved).toBe(6)
    expect(state.itemsReused).toBe(2)
    expect(state.itemsSkipped).toBe(1)
    expect(state.itemsTotal).toBe(9)
    expect(state.files).toHaveLength(1)

    expect(successToast).toHaveBeenCalledTimes(1)
    const description = successToast.mock.calls[0][1].description as string
    expect(description).toContain("6 of 9")
    expect(description).toContain("2 already downloaded")
    expect(description).toContain("1 skipped")
    expect(stage).not.toHaveBeenCalled()
  })

  test("a failure reports and toasts exactly once, with the advice it came with", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await emit({
      downloadId: sentDownloadId(),
      status: "failed",
      error: "Cliply couldn't prepare its record of this download.",
      suggestion: "Check that Cliply can write to its app data folder.",
      details: "stderr tail",
      category: "PERMISSION_ERROR"
    })

    expect(await settled).toMatchObject({ ok: false, value: { outcome: "failed" } })
    await flush()

    expect(showDownloadErrorToast).toHaveBeenCalledTimes(1)
    // "please try again" is the wrong answer to a folder we cannot write to
    expect(showDownloadErrorToast.mock.calls[0][1]).toContain(
      "Check that Cliply can write to its app data folder."
    )
    expect(stage).toHaveBeenCalledTimes(1)
    expect(stage.mock.calls[0][0]).toMatchObject({
      shortMessage: "Cliply couldn't prepare its record of this download.",
      details: "stderr tail",
      platform: "youtube"
    })
  })

  test("a cancellation is not dressed up as a failure", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      progress: 66,
      item_index: 3,
      items_completed: 2,
      items_total: 3,
      playlist_index: 3
    })

    await emit({
      downloadId: sentDownloadId(),
      status: "cancelled",
      progress: 0,
      items_saved: 2,
      items_reused: 0,
      items_skipped: 1,
      items_total: 3
    })

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "cancelled" }
    })
    await flush()

    expect(showDownloadErrorToast).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
    // the videos it did finish are still on disk, and the event says how many
    expect(result.current.downloadState.itemsSaved).toBe(2)
    // the terminal event reports 0, and a run that got two videos in did not
    // un-download them
    expect(result.current.downloadState.progress).toBe(66)
  })

  test("a start failure keeps the component-facing error path", async () => {
    const ack = deferredAck()
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    ack.reject(new Error("Select at least one video to download."))

    expect((await settled).ok).toBe(false)
    await flush()

    expect(showDownloadErrorToast).toHaveBeenCalledTimes(1)
    expect(stage).toHaveBeenCalledTimes(1)
    expect(result.current.downloadState.status).toBe("failed")
  })
})

describe("the second level of progress", () => {
  test("the row in flight is the one the event names, by playlist position", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    // item 2 of the queue is playlist position 3, which is exactly the pair a
    // sparse selection produces - and the row is keyed on the playlist position
    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      progress: 62,
      item_progress: 24,
      item_index: 2,
      items_completed: 1,
      items_total: 2,
      playlist_index: 3,
      video_id: "video3"
    })

    const state = result.current.downloadState
    expect(state.progress).toBe(62)
    expect(state.itemProgress).toBe(24)
    expect(state.itemIndex).toBe(2)
    expect(state.itemsCompleted).toBe(1)
    expect(state.itemsTotal).toBe(2)
    expect(state.playlistIndex).toBe(3)

    const status = usePlaylistStore.getState().itemStatus
    expect(status.get(3)).toEqual({ state: "downloading", progress: 24 })
    expect(status.has(1)).toBe(false)

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })

  /**
   * the engine counts an item completed the moment its file lands, and its own
   * invariant is that the item in flight stops being added on top once it has.
   * `items_completed >= item_index` is that same fact read from the outside,
   * and it is the only evidence a row's file landed that a progress event
   * carries.
   */
  test("a row is only called saved once the run says its file landed", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    const base = {
      downloadId: sentDownloadId(),
      status: "downloading",
      item_index: 1,
      items_total: 2,
      playlist_index: 1,
      video_id: "video1"
    }

    await emit({ ...base, progress: 40, item_progress: 80, items_completed: 0 })
    expect(usePlaylistStore.getState().itemStatus.get(1)?.state).toBe("downloading")

    await emit({ ...base, progress: 50, item_progress: 100, items_completed: 1 })
    expect(usePlaylistStore.getState().itemStatus.get(1)).toEqual({
      state: "saved",
      progress: 100
    })

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })

  test("a row the run left in flight ends as skipped, and a saved one stays saved", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      item_index: 1,
      items_completed: 1,
      items_total: 2,
      item_progress: 100,
      playlist_index: 1
    })
    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      item_index: 2,
      items_completed: 1,
      items_total: 2,
      item_progress: 30,
      playlist_index: 3
    })

    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      items_saved: 1,
      items_reused: 0,
      items_skipped: 1,
      items_total: 2
    })

    const status = usePlaylistStore.getState().itemStatus
    expect(status.get(1)?.state).toBe("saved")
    expect(status.get(3)?.state).toBe("skipped")

    expect((await settled).ok).toBe(true)
  })

  test("a cancelled run leaves the row it interrupted queued, not skipped", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      item_index: 1,
      items_completed: 0,
      items_total: 2,
      item_progress: 30,
      playlist_index: 1
    })
    await emit({ downloadId: sentDownloadId(), status: "cancelled" })

    expect(usePlaylistStore.getState().itemStatus.get(1)?.state).toBe("pending")

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "cancelled" }
    })
  })
})

/**
 * one playlist job at a time from this screen.
 *
 * the settlement and cleanup refs are per-hook, not per-invocation, so two
 * overlapping starts would cross: the first run's completion would resolve the
 * second one's promise with the first one's id, and the second one's cleanup
 * would drop the first one's listener and leave its promise pending forever.
 * filtering events by id does not help, because the refs are what is shared.
 */
describe("overlapping starts", () => {
  test("a second start while one is in flight is refused, and the first is untouched", async () => {
    const ack = deferredAck()
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled: first } = await startDownload(result)
    expect(listeners).toHaveLength(1)

    let second!: Promise<Settled>
    await act(async () => {
      second = result.current
        .mutateAsync({})
        .then((value: unknown) => ({ ok: true, value }))
        .catch((value: unknown) => ({ ok: false, value }))
    })

    const refused = await second
    expect(refused.ok).toBe(false)
    expect((refused.value as Error).message).toMatch(/already running/i)

    // it never reached main, it did not take the first run's listener with it,
    // and it is a sentence to the user rather than something to report
    expect(downloadPlaylist).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(1)
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(stage).not.toHaveBeenCalled()
    expect(usePlaylistStore.getState().isDownloading).toBe(true)

    ack.resolve({})
    await flush()
    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      items_saved: 2,
      items_total: 2
    })

    // the first run settles with its own id, not the refused one's
    const outcome = await first
    expect(outcome.ok).toBe(true)
    expect(outcome.value).toMatchObject({ downloadId: sentDownloadId() })
    expect(usePlaylistStore.getState().isDownloading).toBe(false)
  })

  test("a refused start does not disturb a selection that is still valid", async () => {
    const ack = deferredAck()
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    const before = usePlaylistStore.getState().selectedIndices

    let second!: Promise<Settled>
    await act(async () => {
      second = result.current.mutateAsync({}).catch((value: unknown) => ({
        ok: false,
        value
      })) as Promise<Settled>
    })
    await second

    expect(usePlaylistStore.getState().selectedIndices).toBe(before)

    ack.resolve({})
    await flush()
    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })
})

/**
 * main awaits the download directory before it reserves the id
 * (`ipc-handlers.js`), so a cancel arriving in that window finds nothing to
 * cancel and comes back false. dropping that answer, as a cancel after a
 * finished run must be dropped, loses the user's cancel entirely and the
 * playlist downloads on.
 */
describe("cancel inside the start window", () => {
  test("a cancel main could not take yet is issued again once it can", async () => {
    const ack = deferredAck()
    cancelDownload.mockResolvedValueOnce(false)

    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })
    const { settled } = await startDownload(result)

    await act(async () => {
      await result.current.cancelDownload()
    })

    // nothing to show yet: main has not reserved the id, so nothing was stopped
    expect(cancelDownload).toHaveBeenCalledTimes(1)
    expect(result.current.downloadState.status).not.toBe("cancelled")

    cancelDownload.mockResolvedValue(true)
    await act(async () => {
      ack.resolve({})
    })
    await flush()

    expect(cancelDownload).toHaveBeenCalledTimes(2)
    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "cancelled" }
    })
    expect(result.current.downloadState.status).toBe("cancelled")
    expect(infoToast).toHaveBeenCalledTimes(1)
  })

  test("a run that finished before the retry is left completed", async () => {
    const ack = deferredAck()
    cancelDownload.mockResolvedValueOnce(false)

    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })
    const { settled } = await startDownload(result)

    await act(async () => {
      await result.current.cancelDownload()
    })

    // it finished on its own before main was ever in a position to be asked
    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      items_saved: 3,
      items_total: 3
    })

    // it would take now, and must not be asked
    cancelDownload.mockResolvedValue(true)
    await act(async () => {
      ack.resolve({})
    })
    await flush()

    expect(cancelDownload).toHaveBeenCalledTimes(1)
    expect((await settled).ok).toBe(true)
    expect(result.current.downloadState.status).toBe("completed")
    expect(infoToast).not.toHaveBeenCalled()
  })

  test("a cancel clicked after the run finished is not sent at all", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })
    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)

    await act(async () => {
      await result.current.cancelDownload()
    })

    expect(cancelDownload).not.toHaveBeenCalled()
    expect(result.current.downloadState.status).toBe("completed")
  })
})

describe("unmount, reset and cancellation", () => {
  test("unmount settles the mutation and does not cancel the engine", async () => {
    const { result, unmount } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    unmount()

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "abandoned" }
    })
    // deliberate: a playlist keeps downloading when its view is swapped out
    expect(cancelDownload).not.toHaveBeenCalled()
  })

  test("a refused cancel leaves the download alone", async () => {
    cancelDownload.mockResolvedValue(false)

    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await act(async () => {
      await result.current.cancelDownload()
    })

    expect(result.current.downloadState.status).not.toBe("cancelled")
    expect(infoToast).not.toHaveBeenCalled()

    await emit({ downloadId: sentDownloadId(), status: "completed" })
    expect((await settled).ok).toBe(true)
  })

  test("an accepted cancel settles the mutation as cancelled", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await act(async () => {
      await result.current.cancelDownload()
    })

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "cancelled" }
    })
    expect(infoToast).toHaveBeenCalledTimes(1)
    expect(showDownloadErrorToast).not.toHaveBeenCalled()
    expect(usePlaylistStore.getState().isDownloading).toBe(false)
  })

  test("reset settles the mutation and clears the download state", async () => {
    const { result } = renderHook(() => usePlaylistDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadPlaylist).toHaveBeenCalled())

    await act(async () => {
      result.current.reset()
    })

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "abandoned" }
    })
    expect(result.current.downloadState.status).toBe("idle")

    // a reset view has no run of its own, so Cancel has nothing to send: the
    // engine deliberately keeps going, exactly as it does after an unmount
    await act(async () => {
      await result.current.cancelDownload()
    })
    expect(cancelDownload).not.toHaveBeenCalled()
  })
})

// the sentence a partial run puts in front of the user. no em-dashes, and no
// arithmetic that turns an archive reuse into a save
describe("summarizePlaylistItems", () => {
  test.each([
    [{ saved: 9, reused: 0, skipped: 0, total: 9 }, "9 of 9 videos saved."],
    [{ saved: 1, reused: 0, skipped: 0, total: 1 }, "1 of 1 video saved."],
    [{ saved: 8, reused: 0, skipped: 1, total: 9 }, "8 of 9 videos saved, 1 skipped."],
    [
      { saved: 3, reused: 2, skipped: 0, total: 5 },
      "3 of 5 videos saved, 2 already downloaded."
    ],
    [
      { saved: 0, reused: 5, skipped: 0, total: 5 },
      "0 of 5 videos saved, 5 already downloaded."
    ],
    [
      { saved: 6, reused: 2, skipped: 1, total: 9 },
      "6 of 9 videos saved, 2 already downloaded, 1 skipped."
    ]
  ])("%j reads as %s", (counts, sentence) => {
    expect(summarizePlaylistItems(counts)).toBe(sentence)
  })

  test("says nothing when the run reported no counts", () => {
    expect(summarizePlaylistItems({})).toBeUndefined()
  })

  test("never uses an em-dash", () => {
    const sentence = summarizePlaylistItems({
      saved: 6,
      reused: 2,
      skipped: 1,
      total: 9
    })

    expect(sentence).not.toContain("—")
  })
})
