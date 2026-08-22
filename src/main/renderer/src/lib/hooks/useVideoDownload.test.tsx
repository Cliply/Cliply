// @vitest-environment jsdom
//
// the hook owns the contract the cold review kept finding holes in: which
// download's events it accepts, who reports a terminal outcome, and what
// happens when the view goes away mid-download.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

type ProgressListener = (payload: Record<string, unknown>) => void

// vi.mock factories are hoisted above the module body, so anything they close
// over has to be hoisted with them
const mocks = vi.hoisted(() => ({
  listeners: [] as ((payload: Record<string, unknown>) => void)[],
  stage: vi.fn(),
  showDownloadErrorToast: vi.fn(),
  successToast: vi.fn(),
  infoToast: vi.fn(),
  downloadVideo: vi.fn(),
  cancelDownload: vi.fn()
}))

const {
  listeners,
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
      onProgress: (listener: ProgressListener) => {
        mocks.listeners.push(listener)

        return () => {
          const index = mocks.listeners.indexOf(listener)
          if (index >= 0) mocks.listeners.splice(index, 1)
        }
      },
      cancelDownload: (id: string) => mocks.cancelDownload(id)
    },
    videoApi: {
      downloadVideo: (request: unknown) => mocks.downloadVideo(request)
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
    error: vi.fn()
  }
}))

import { useVideoDownload } from "./useVideoDownload"

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  })

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const REQUEST = {
  url: "https://www.youtube.com/watch?v=abc",
  video_format_id: "hd_720p",
  audio_format_id: "medium_audio"
}

type Settled = { ok: boolean; value: unknown }

/**
 * start a download and observe its outcome immediately
 *
 * mutateAsync rejects for cancellation and abandonment as well as failure, and
 * a rejection nobody is watching yet would be reported as unhandled - a test
 * artifact. Attaching the handler at creation keeps the assertions about the
 * hook, not about when the test happened to await.
 */
async function startDownload(result: {
  current: ReturnType<typeof useVideoDownload>
}) {
  let pending!: Promise<unknown>

  await act(async () => {
    pending = result.current.mutateAsync(REQUEST)
  })

  // wrapped in an object on purpose: awaiting this helper would otherwise
  // unwrap the outcome promise and block until the download finished
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

const emit = async (payload: Record<string, unknown>) => {
  await act(async () => {
    for (const listener of [...listeners]) listener(payload)
  })
}

const sentDownloadId = () => downloadVideo.mock.calls[0][0].download_id as string

const flush = () => act(async () => {})

beforeEach(() => {
  listeners.length = 0
  vi.clearAllMocks()
  downloadVideo.mockResolvedValue({ download_id: "ignored", status: "started" })
  cancelDownload.mockResolvedValue(true)
})

afterEach(() => {
  // every path must drop its progress listener
  expect(listeners).toHaveLength(0)
})

describe("event correlation", () => {
  test("the id exists and the listener is live before the ack lands", async () => {
    const ack = deferredAck()
    const { result, unmount } = renderHook(() => useVideoDownload(), { wrapper })

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
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    // a concurrent audio/tiktok download failing must not touch this one
    await emit({ downloadId: "someone-else", status: "failed", error: "boom" })

    expect(showDownloadErrorToast).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
    expect(result.current.downloadState.status).not.toBe("failed")

    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      filename: "clip.mp4"
    })

    expect((await settled).ok).toBe(true)
  })
})

describe("terminal outcome ownership", () => {
  test("a mid-download failure reports and toasts exactly once", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await emit({
      downloadId: sentDownloadId(),
      status: "failed",
      error: "Video unavailable",
      details: "stderr tail",
      category: "VIDEO_UNAVAILABLE"
    })

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "failed" }
    })
    await flush()

    // onError must stay silent: the event path already did this
    expect(showDownloadErrorToast).toHaveBeenCalledTimes(1)
    expect(stage).toHaveBeenCalledTimes(1)
    expect(stage.mock.calls[0][0]).toMatchObject({
      shortMessage: "Video unavailable",
      details: "stderr tail"
    })
    expect(result.current.downloadState.status).toBe("failed")
  })

  test("completion produces one success toast and no report", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      progress: 100,
      filename: "clip.mp4"
    })

    expect((await settled).ok).toBe(true)
    expect(successToast).toHaveBeenCalledTimes(1)
    expect(showDownloadErrorToast).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
  })

  test("a cancellation is not dressed up as a failure", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await emit({ downloadId: sentDownloadId(), status: "cancelled" })

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "cancelled" }
    })
    await flush()

    expect(showDownloadErrorToast).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
  })

  test("a start failure keeps the component-facing error path", async () => {
    const ack = deferredAck()
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    ack.reject(new Error("engine missing"))

    const outcome = await settled
    expect(outcome.ok).toBe(false)
    expect(outcome.value).toHaveProperty("message", "engine missing")
    await flush()

    // this one is NOT owned by the event path, so onError reports it
    expect(showDownloadErrorToast).toHaveBeenCalledTimes(1)
    expect(stage).toHaveBeenCalledTimes(1)
    expect(result.current.downloadState.status).toBe("failed")
  })
})

describe("unmount and reset", () => {
  test("unmount before the ack raises no unhandled rejection", async () => {
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)

    const ack = deferredAck()
    const { result, unmount } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)

    // the view goes away while the start ipc is still in flight, so the
    // terminal promise is rejected before anything awaits it
    unmount()
    await flush()

    // node reports unhandled rejections at the end of a microtask checkpoint
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()

    ack.resolve({})
    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "abandoned" }
    })

    process.off("unhandledRejection", unhandled)
  })

  test("unmount mid-download settles the mutation and does not cancel the engine", async () => {
    const { result, unmount } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      progress: 40
    })

    unmount()

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "abandoned" }
    })

    // deliberate: the download keeps running when its view is swapped out
    expect(cancelDownload).not.toHaveBeenCalled()
  })

  test("reset settles the mutation and drops the listener", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await act(async () => {
      result.current.reset()
    })

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "abandoned" }
    })
    expect(result.current.downloadState.status).toBe("idle")
  })
})

describe("cancellation", () => {
  test("a refused cancel leaves the download alone", async () => {
    cancelDownload.mockResolvedValue(false)

    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    // main had nothing to cancel - usually because it just finished
    await act(async () => {
      await result.current.cancelDownload()
    })

    expect(result.current.downloadState.status).not.toBe("cancelled")
    expect(infoToast).not.toHaveBeenCalled()

    // and the completion event still lands
    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      filename: "clip.mp4"
    })

    expect((await settled).ok).toBe(true)
  })

  test("an accepted cancel settles the mutation as cancelled", async () => {
    const { result } = renderHook(() => useVideoDownload(), { wrapper })

    const { settled } = await startDownload(result)
    await waitFor(() => expect(downloadVideo).toHaveBeenCalled())

    await act(async () => {
      await result.current.cancelDownload()
    })

    expect(await settled).toMatchObject({
      ok: false,
      value: { outcome: "cancelled" }
    })
    expect(infoToast).toHaveBeenCalledTimes(1)
    expect(showDownloadErrorToast).not.toHaveBeenCalled()
    expect(stage).not.toHaveBeenCalled()
  })
})
