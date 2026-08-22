// @vitest-environment jsdom
//
// the audio hook is a parallel copy of the video one, so it carries the same
// contract - and the same regressions if only one of them is fixed. This covers
// the three the cold review named: pre-ack rejection, terminal ownership, and
// honouring the cancel result.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

type ProgressListener = (payload: Record<string, unknown>) => void

const mocks = vi.hoisted(() => ({
  listeners: [] as ((payload: Record<string, unknown>) => void)[],
  stage: vi.fn(),
  showDownloadErrorToast: vi.fn(),
  successToast: vi.fn(),
  infoToast: vi.fn(),
  downloadAudio: vi.fn(),
  cancelDownload: vi.fn()
}))

const {
  listeners,
  stage,
  showDownloadErrorToast,
  successToast,
  infoToast,
  downloadAudio,
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
      downloadAudio: (request: unknown) => mocks.downloadAudio(request)
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

import { useAudioDownload } from "./useAudioDownload"

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  })

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const REQUEST = {
  url: "https://www.youtube.com/watch?v=abc",
  format_id: "medium_audio"
}

type Settled = { ok: boolean; value: unknown }

async function startDownload(result: {
  current: ReturnType<typeof useAudioDownload>
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

function deferredAck() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((res) => {
    resolve = res
  })

  downloadAudio.mockReturnValueOnce(promise)

  return { resolve }
}

const emit = async (payload: Record<string, unknown>) => {
  await act(async () => {
    for (const listener of [...listeners]) listener(payload)
  })
}

const sentDownloadId = () => downloadAudio.mock.calls[0][0].download_id as string

const flush = () => act(async () => {})

beforeEach(() => {
  listeners.length = 0
  vi.clearAllMocks()
  downloadAudio.mockResolvedValue({ download_id: "ignored", status: "started" })
  cancelDownload.mockResolvedValue(true)
})

afterEach(() => {
  expect(listeners).toHaveLength(0)
})

test("another download's terminal event is ignored", async () => {
  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  const { settled } = await startDownload(result)
  await waitFor(() => expect(downloadAudio).toHaveBeenCalled())

  await emit({ downloadId: "someone-else", status: "failed", error: "boom" })

  expect(showDownloadErrorToast).not.toHaveBeenCalled()
  expect(stage).not.toHaveBeenCalled()

  await emit({
    downloadId: sentDownloadId(),
    status: "completed",
    filename: "song.m4a"
  })

  expect((await settled).ok).toBe(true)
  expect(successToast).toHaveBeenCalledTimes(1)
})

test("a mid-download failure reports and toasts exactly once", async () => {
  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  const { settled } = await startDownload(result)
  await waitFor(() => expect(downloadAudio).toHaveBeenCalled())

  await emit({
    downloadId: sentDownloadId(),
    status: "failed",
    error: "Video unavailable"
  })

  expect(await settled).toMatchObject({ ok: false, value: { outcome: "failed" } })
  await flush()

  expect(showDownloadErrorToast).toHaveBeenCalledTimes(1)
  expect(stage).toHaveBeenCalledTimes(1)
})

test("a cancellation is not dressed up as a failure", async () => {
  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  const { settled } = await startDownload(result)
  await waitFor(() => expect(downloadAudio).toHaveBeenCalled())

  await emit({ downloadId: sentDownloadId(), status: "cancelled" })

  expect(await settled).toMatchObject({
    ok: false,
    value: { outcome: "cancelled" }
  })
  await flush()

  expect(showDownloadErrorToast).not.toHaveBeenCalled()
  expect(stage).not.toHaveBeenCalled()
})

test("unmount before the ack raises no unhandled rejection", async () => {
  const unhandled = vi.fn()
  process.on("unhandledRejection", unhandled)

  const ack = deferredAck()
  const { result, unmount } = renderHook(() => useAudioDownload(), { wrapper })

  const { settled } = await startDownload(result)

  unmount()
  await flush()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(unhandled).not.toHaveBeenCalled()

  ack.resolve({})
  expect(await settled).toMatchObject({
    ok: false,
    value: { outcome: "abandoned" }
  })

  process.off("unhandledRejection", unhandled)
})

test("a refused cancel leaves the download alone", async () => {
  cancelDownload.mockResolvedValue(false)

  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  const { settled } = await startDownload(result)
  await waitFor(() => expect(downloadAudio).toHaveBeenCalled())

  await act(async () => {
    await result.current.cancelDownload()
  })

  expect(result.current.downloadState.status).not.toBe("cancelled")
  expect(infoToast).not.toHaveBeenCalled()

  await emit({
    downloadId: sentDownloadId(),
    status: "completed",
    filename: "song.m4a"
  })

  expect((await settled).ok).toBe(true)
})
