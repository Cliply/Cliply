// @vitest-environment jsdom
//
// what the hook owns now that it no longer follows the download: the row goes
// into the store before main is asked, the mutation comes back at the
// acknowledgement rather than at the end, and a second click on the same
// request goes to the download already running instead of starting beside it.
//
// the outcome - the toast, the staged report, the row settling - belongs to
// DownloadEvents, and is proved there.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
  showDownloadErrorToast: vi.fn(),
  successToast: vi.fn(),
  infoToast: vi.fn(),
  downloadVideo: vi.fn(),
  cancelDownload: vi.fn()
}))

const {
  stage,
  showDownloadErrorToast,
  successToast,
  infoToast,
  downloadVideo,
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
      cancelDownload: (id: string) => mocks.cancelDownload(id),
      clearHistory: vi.fn(),
      removeHistory: vi.fn()
    },
    videoApi: {
      downloadVideo: (request: unknown) => mocks.downloadVideo(request)
    },
    systemApi: { openDownloadFolder: vi.fn() }
  }
})

vi.mock("@/lib/stores/reportStore", () => ({
  reportActions: { stage: mocks.stage }
}))
vi.mock("@/lib/toast-utils", () => ({
  showDownloadErrorToast: mocks.showDownloadErrorToast
}))
vi.mock("sonner", () => ({
  toast: {
    success: mocks.successToast,
    info: mocks.infoToast,
    error: vi.fn()
  }
}))

import { en } from "@/lib/i18n/en"
import { useDownloadsStore } from "@/lib/stores/downloadsStore"

import { useVideoDownload } from "./useVideoDownload"

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  })

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const REQUEST = {
  url: "https://www.youtube.com/watch?v=abc",
  height: 1080,
  container: "mp4" as const,
  title: "My Holiday Video"
}

type Settled = { ok: boolean; value: unknown }

/**
 * start a download and observe its outcome immediately
 *
 * the only rejection left is a start main refused, and a rejection nobody is
 * watching yet would be reported as unhandled - a test artifact. Attaching the
 * handler at creation keeps the assertions about the hook.
 */
async function startDownload(result: {
  current: ReturnType<typeof useVideoDownload>
}) {
  let pending!: Promise<unknown>

  await act(async () => {
    pending = result.current.mutateAsync(REQUEST)
  })

  return {
    settled: pending
      .then((value: unknown) => ({ ok: true, value }))
      .catch((value: unknown) => ({ ok: false, value })) as Promise<Settled>
  }
}

// a start ipc we control the timing of
function deferredAck() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })

  downloadVideo.mockReturnValueOnce(promise)

  return { resolve, reject }
}

const store = () => useDownloadsStore.getState()
const sentDownloadId = () =>
  downloadVideo.mock.calls[0][0].download_id as string
const flush = () => act(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  store().reset()
  downloadVideo.mockResolvedValue({ downloadId: "ignored" })
  cancelDownload.mockResolvedValue(true)
})

describe("the row it puts in the store", () => {
  test("exists, as starting, before main has been asked", async () => {
    const ack = deferredAck()
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)

    expect(store().rows).toHaveLength(1)
    expect(store().rows[0]).toMatchObject({
      kind: "video",
      platform: "youtube",
      title: "My Holiday Video",
      // built here rather than waited for: the row exists before the
      // acknowledgement, and the label is half of what tells two apart
      label: "1080p mp4",
      status: "starting",
      progress: 0,
      request: REQUEST
    })
    expect(store().rows[0].downloadId).toBe(sentDownloadId())

    ack.resolve({})
    expect((await settled).ok).toBe(true)
  })

  test("is the row the hook hands back, and it decides `isDownloading`", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    await startDownload(result)
    await waitFor(() => expect(result.current.row).toBeDefined())

    expect(result.current.isDownloading).toBe(true)

    await act(async () => {
      store().applyEvent({
        downloadId: sentDownloadId(),
        status: "completed",
        progress: 100,
        filename: "clip.mp4"
      })
    })

    expect(result.current.isDownloading).toBe(false)
    expect(result.current.isCompleted).toBe(true)
    expect(result.current.row?.filename).toBe("clip.mp4")
  })

  /**
   * the whole point of resolving here: the button comes back while the download
   * is still running, so a second link can be pasted and started
   */
  test("the mutation resolves at the acknowledgement, not at the end", async () => {
    const ack = deferredAck()
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    expect(result.current.isPending).toBe(true)

    ack.resolve({})

    expect(await settled).toMatchObject({
      ok: true,
      value: { downloadId: sentDownloadId(), duplicate: false }
    })
    await waitFor(() => expect(result.current.isPending).toBe(false))
    // ...and the download it started is still going
    expect(result.current.isDownloading).toBe(true)
  })

  test("another download's event never touches this row", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await act(async () => {
      store().applyEvent({
        downloadId: "someone-else",
        status: "failed",
        progress: 0,
        error: "boom"
      })
    })

    expect(result.current.row?.status).toBe("starting")
  })
})

describe("a start main refused", () => {
  test("marks the row failed and reports it once", async () => {
    const ack = deferredAck()
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    ack.reject(new Error("engine missing"))

    const outcome = await settled
    expect(outcome.ok).toBe(false)
    expect(outcome.value).toHaveProperty("message", "engine missing")
    await flush()

    // no event will ever come for this row, so the row has to say so itself
    expect(result.current.row).toMatchObject({
      status: "failed",
      error: "engine missing"
    })
    expect(result.current.isDownloading).toBe(false)

    // DownloadEvents will never see this one, so onError is what reports it
    expect(showDownloadErrorToast).toHaveBeenCalledTimes(1)
    expect(showDownloadErrorToast.mock.calls[0][0]).toBe(
      en["download.videoFailed"]
    )
    expect(stage).toHaveBeenCalledTimes(1)
    expect(stage.mock.calls[0][0]).toMatchObject({
      shortMessage: "engine missing",
      platform: "youtube",
      downloadType: "video",
      videoUrl: REQUEST.url
    })
  })

  /**
   * the one race the store did not remove: a start that rejects after the view
   * has moved on. the row is marked by its id, so the failure lands on the
   * download it belongs to rather than on whatever the hook points at now
   */
  test("settles the row it belongs to, not the one on screen", async () => {
    const ack = deferredAck()
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    const abandoned = sentDownloadId()

    await act(async () => {
      result.current.reset()
    })
    ack.reject(new Error("engine missing"))
    await settled
    await flush()

    expect(
      store().rows.find((row) => row.downloadId === abandoned)
    ).toMatchObject({ status: "failed", error: "engine missing" })
    // the view is following nothing now
    expect(result.current.row).toBeUndefined()
  })
})

describe("the same download asked for twice", () => {
  test("opens the panel on the first one and starts nothing", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    expect((await settled).ok).toBe(true)
    const first = sentDownloadId()

    const second = await startDownload(result)

    expect(await second.settled).toMatchObject({
      ok: true,
      value: { downloadId: first, duplicate: true }
    })
    // one process, one row
    expect(downloadVideo).toHaveBeenCalledTimes(1)
    expect(store().rows).toHaveLength(1)
    expect(store().highlightedId).toBe(first)
    expect(store().panelOpen).toBe(true)
  })

  test("a download that has finished is not in the way", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await act(async () => {
      store().applyEvent({
        downloadId: sentDownloadId(),
        status: "completed",
        progress: 100
      })
    })

    await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalledTimes(2))
    expect(store().rows).toHaveLength(2)
  })
})

describe("cancellation and reset", () => {
  test("an accepted cancel says so, and the event settles the row", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await act(async () => {
      await result.current.cancelDownload()
    })

    expect(cancelDownload).toHaveBeenCalledWith(sentDownloadId())
    expect(infoToast).toHaveBeenCalledTimes(1)
    expect(showDownloadErrorToast).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
  })

  test("a refused cancel leaves the download alone", async () => {
    // main reports false when it had nothing to cancel - usually because the
    // download just finished, and "cancelled" over a completed one is a lie
    cancelDownload.mockResolvedValue(false)

    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await act(async () => {
      await result.current.cancelDownload()
    })

    expect(infoToast).not.toHaveBeenCalled()
    expect(result.current.row?.status).toBe("starting")
  })

  /**
   * unmounting a view does not cancel its download and never did. what is new
   * is that it no longer loses it either: the row and its outcome outlive the
   * card that started it
   */
  test("unmounting stops following the download and keeps its row", async () => {
    const { result, unmount } = renderHook(() => useVideoDownload(), {
      wrapper
    })

    await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    unmount()

    expect(cancelDownload).not.toHaveBeenCalled()
    expect(store().rows).toHaveLength(1)
    expect(store().rows[0].status).toBe("starting")
  })

  test("reset lets go of the row without touching it", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    await startDownload(result)
    await waitFor(() => expect(result.current.row).toBeDefined())

    await act(async () => {
      result.current.reset()
    })

    expect(result.current.row).toBeUndefined()
    expect(result.current.isDownloading).toBe(false)
    expect(store().rows).toHaveLength(1)
    expect(successToast).not.toHaveBeenCalled()
  })
})
