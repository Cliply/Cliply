// @vitest-environment jsdom
//
// the audio hook is the same hook under another name, so it carries the same
// contract - and the same regressions if only one of them is covered. what is
// its own here is the row it builds: kind `audio`, and a label that is the mode,
// which is what keeps "mp3 of this video" and "1080p of this video" two
// downloads rather than one.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, expect, test, vi } from "vitest"

import type { AudioDownloadRequest } from "@/lib/api"

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
  showDownloadErrorToast: vi.fn(),
  successToast: vi.fn(),
  infoToast: vi.fn(),
  downloadAudio: vi.fn(),
  cancelDownload: vi.fn()
}))

const {
  stage,
  showDownloadErrorToast,
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
      cancelDownload: (id: string) => mocks.cancelDownload(id),
      clearHistory: vi.fn(),
      removeHistory: vi.fn()
    },
    videoApi: {
      downloadAudio: (request: unknown) => mocks.downloadAudio(request)
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

import { useAudioDownload } from "./useAudioDownload"

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  })

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const REQUEST: AudioDownloadRequest = {
  url: "https://www.youtube.com/watch?v=abc",
  audio_mode: "mp3",
  title: "My Holiday Video"
}

type Settled = { ok: boolean; value: unknown }

async function startDownload(
  result: { current: ReturnType<typeof useAudioDownload> },
  request: AudioDownloadRequest = REQUEST
) {
  let pending!: Promise<unknown>

  await act(async () => {
    pending = result.current.mutateAsync(request)
  })

  return {
    settled: pending
      .then((value: unknown) => ({ ok: true, value }))
      .catch((value: unknown) => ({ ok: false, value })) as Promise<Settled>
  }
}

function deferredAck() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })

  downloadAudio.mockReturnValueOnce(promise)

  return { resolve, reject }
}

const store = () => useDownloadsStore.getState()
const sentDownloadId = () =>
  downloadAudio.mock.calls[0][0].download_id as string
const flush = () => act(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  store().reset()
  downloadAudio.mockResolvedValue({ downloadId: "ignored" })
  cancelDownload.mockResolvedValue(true)
})

test("the row is an audio row, labelled with the mode", async () => {
  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  const { settled } = await startDownload(result)

  expect(store().rows[0]).toMatchObject({
    kind: "audio",
    platform: "youtube",
    label: "mp3",
    status: "starting"
  })
  expect((await settled).ok).toBe(true)
})

test("the mutation resolves at the acknowledgement", async () => {
  const ack = deferredAck()
  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  const { settled } = await startDownload(result)
  expect(result.current.isPending).toBe(true)

  ack.resolve({})

  expect(await settled).toMatchObject({ ok: true })
  await waitFor(() => expect(result.current.isPending).toBe(false))
  // the download is still going, and the row is what says so
  expect(result.current.isDownloading).toBe(true)
})

test("a start main refused marks the row failed and reports it once", async () => {
  const ack = deferredAck()
  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  const { settled } = await startDownload(result)
  ack.reject(new Error("engine missing"))

  expect((await settled).ok).toBe(false)
  await flush()

  expect(result.current.row).toMatchObject({
    status: "failed",
    error: "engine missing"
  })
  expect(showDownloadErrorToast).toHaveBeenCalledTimes(1)
  expect(showDownloadErrorToast.mock.calls[0][0]).toBe(
    en["download.audioFailed"]
  )
  expect(stage).toHaveBeenCalledTimes(1)
  expect(stage.mock.calls[0][0]).toMatchObject({ downloadType: "audio" })
})

test("the same mode of the same video twice starts one download", async () => {
  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  await startDownload(result)
  const first = sentDownloadId()
  await startDownload(result)

  expect(downloadAudio).toHaveBeenCalledTimes(1)
  expect(store().highlightedId).toBe(first)
  expect(store().panelOpen).toBe(true)
})

test("a different mode of the same video is a second download", async () => {
  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  await startDownload(result)
  await startDownload(result, { ...REQUEST, audio_mode: "m4a" })

  await waitFor(() => expect(downloadAudio).toHaveBeenCalledTimes(2))
  expect(store().rows.map((row) => row.label)).toEqual(["m4a", "mp3"])
})

test("a refused cancel leaves the download alone", async () => {
  cancelDownload.mockResolvedValue(false)

  const { result } = renderHook(() => useAudioDownload(), { wrapper })

  await startDownload(result)
  await waitFor(() => expect(downloadAudio).toHaveBeenCalled())

  await act(async () => {
    await result.current.cancelDownload()
  })

  expect(infoToast).not.toHaveBeenCalled()
  expect(result.current.row?.status).toBe("starting")
})
