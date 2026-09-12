// @vitest-environment jsdom
//
// tiktok and pinterest were the two downloads main used to await, answering
// with the finished file - so this hook toasted "complete" on the reply. with a
// queue in front of the engine that reply comes back at the acknowledgement
// instead, and toasting there would congratulate the user on a download that
// has not started. what it does now is put a row in the store and let
// DownloadEvents say how it ended.

import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  stage: vi.fn(),
  showDownloadErrorToast: vi.fn(),
  showServerOverwhelmedToast: vi.fn(),
  successToast: vi.fn()
}))

vi.mock("@/lib/api", () => {
  class DownloadError extends Error {
    details?: string
    category?: string
  }

  return {
    DownloadError,
    downloadApi: { clearHistory: vi.fn(), removeHistory: vi.fn() },
    systemApi: { openDownloadFolder: vi.fn() }
  }
})

vi.mock("@/lib/stores/reportStore", () => ({
  reportActions: { stage: mocks.stage }
}))
vi.mock("@/lib/toast-utils", () => ({
  showDownloadErrorToast: mocks.showDownloadErrorToast,
  showServerOverwhelmedToast: mocks.showServerOverwhelmedToast
}))
vi.mock("sonner", () => ({
  toast: { success: mocks.successToast, info: vi.fn(), error: vi.fn() }
}))

import { en } from "@/lib/i18n/en"
import { useDownloadsStore } from "@/lib/stores/downloadsStore"
import { useTikTokStore } from "@/lib/stores/tiktokStore"

import { useSimplePlatformDownload } from "./useSimplePlatformDownload"

const URL = "https://vm.tiktok.com/ZM123/"
const store = () => useDownloadsStore.getState()

const setup = () =>
  renderHook(() =>
    useSimplePlatformDownload({
      platform: "tiktok",
      store: useTikTokStore,
      api: { download: (request) => mocks.download(request) },
      title: "My Holiday Video"
    })
  )

const click = async (result: { current: { handleDownload: () => void } }) => {
  await act(async () => {
    await result.current.handleDownload()
  })
}

const sentDownloadId = () => mocks.download.mock.calls[0][0].download_id

beforeEach(() => {
  vi.clearAllMocks()
  store().reset()
  useTikTokStore.getState().reset()
  useTikTokStore.getState().setUrl(URL)
  mocks.download.mockResolvedValue({
    download_id: "ignored",
    status: "started"
  })
})

test("a click adds a simple row and sends the id main will report under", async () => {
  const { result } = setup()

  await click(result)

  expect(store().rows).toHaveLength(1)
  expect(store().rows[0]).toMatchObject({
    kind: "simple",
    platform: "tiktok",
    title: "My Holiday Video",
    // the platform is the whole of what there is to say about this download
    label: "tiktok",
    status: "starting",
    request: { url: URL, title: "My Holiday Video" }
  })
  expect(store().rows[0].downloadId).toBe(sentDownloadId())
})

/** the regression this ticket exists to close for these two platforms */
test("the acknowledgement is not a completion", async () => {
  const { result } = setup()

  await click(result)

  expect(mocks.successToast).not.toHaveBeenCalled()
  // and the button is still busy: the download has not started yet
  expect(result.current.isDownloading).toBe(true)
})

test("the button comes back when the row settles, not when main answers", async () => {
  const { result } = setup()

  await click(result)
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
  // the platform store's flag still means what it always meant
  expect(useTikTokStore.getState().isDownloading).toBe(false)
})

test("a queued row is still a busy button", async () => {
  const { result } = setup()

  await click(result)

  await act(async () => {
    store().applyEvent({
      downloadId: sentDownloadId(),
      status: "queued",
      progress: 0
    })
  })

  expect(result.current.isDownloading).toBe(true)
})

test("this card starts nothing while its own download is going", async () => {
  const { result } = setup()

  await click(result)
  await click(result)

  expect(mocks.download).toHaveBeenCalledTimes(1)
})

/**
 * the duplicate a card cannot guard against itself: the screen was swapped out
 * and the same clip pasted again, so this hook has no row of its own and the
 * download is still running. two processes writing one .part file corrupt each
 * other, so the click goes to the row that exists
 */
test("a screen that lost its row finds the download still running", async () => {
  const first = setup()
  await click(first.result)
  const running = sentDownloadId()
  first.unmount()

  const second = setup()
  await click(second.result)

  expect(mocks.download).toHaveBeenCalledTimes(1)
  expect(store().rows).toHaveLength(1)
  expect(store().highlightedId).toBe(running)
  expect(store().panelOpen).toBe(true)
  // ...and this screen is following it, so its button is busy again
  expect(second.result.current.isDownloading).toBe(true)
})

test("a clip that already finished is downloadable again", async () => {
  const { result } = setup()

  await click(result)
  await act(async () => {
    store().applyEvent({
      downloadId: sentDownloadId(),
      status: "completed",
      progress: 100
    })
  })

  await click(result)

  await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2))
  expect(store().rows).toHaveLength(2)
})

test("a start main refused settles the row and is reported once", async () => {
  mocks.download.mockRejectedValue(new Error("Unsupported platform"))

  const { result } = setup()
  await click(result)

  expect(store().rows[0]).toMatchObject({
    status: "failed",
    error: "Unsupported platform"
  })
  expect(result.current.isDownloading).toBe(false)
  expect(mocks.showDownloadErrorToast).toHaveBeenCalledTimes(1)
  expect(mocks.showDownloadErrorToast.mock.calls[0][0]).toBe(
    en["download.failed"]
  )
  expect(mocks.stage).toHaveBeenCalledTimes(1)
  expect(mocks.stage.mock.calls[0][0]).toMatchObject({
    platform: "tiktok",
    videoUrl: URL
  })
})

/**
 * kept from the old hook: a start that failed on the network is the server
 * being overwhelmed rather than this download being wrong, and there is nothing
 * to report about it
 */
test("a network failure at the start is not a download failure", async () => {
  mocks.download.mockRejectedValue(new Error("fetch failed"))

  const { result } = setup()
  await click(result)

  expect(mocks.showServerOverwhelmedToast).toHaveBeenCalledTimes(1)
  expect(mocks.showDownloadErrorToast).not.toHaveBeenCalled()
  expect(mocks.stage).not.toHaveBeenCalled()
  // the row still says what happened to it
  expect(store().rows[0].status).toBe("failed")
})
