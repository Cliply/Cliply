// @vitest-environment jsdom
//
// a Stop is one click and up to three moments: main may not have the id yet
// when it is pressed, the reply can be overtaken by main's own first event, and
// a download that emits nothing at all until it finishes still has to stop. what
// this has to get right is that the ask goes out exactly once, and never against
// a download that is already over.

import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cancelDownload: vi.fn(),
  clearHistory: vi.fn(),
  removeHistory: vi.fn()
}))

vi.mock("@/lib/api", () => ({
  downloadApi: {
    cancelDownload: (downloadId: string) => mocks.cancelDownload(downloadId),
    clearHistory: () => mocks.clearHistory(),
    removeHistory: (downloadId: string) => mocks.removeHistory(downloadId)
  }
}))

import {
  useDownloadsStore,
  type DownloadRow
} from "@/lib/stores/downloadsStore"

import {
  keepCancelIntent,
  reconcileCancelIntent,
  requestStop,
  stopIfRequested
} from "./cancelIntent"

const store = () => useDownloadsStore.getState()

const row = (overrides: Partial<DownloadRow> = {}): DownloadRow => ({
  downloadId: "d1",
  kind: "video",
  platform: "youtube",
  title: "My Holiday Video",
  label: "1080p mp4",
  status: "starting",
  progress: 0,
  startedAt: 1000,
  request: { url: "https://youtu.be/abc", height: 1080, container: "mp4" },
  ...overrides
})

/** a cancel reply held open, so an event can be made to overtake it */
function deferredReply() {
  let answer!: (cancelled: boolean) => void

  mocks.cancelDownload.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      answer = resolve
    })
  )

  return { answer }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cancelDownload.mockResolvedValue(true)
  mocks.clearHistory.mockResolvedValue([])
  mocks.removeHistory.mockResolvedValue([])
  store().reset()
})

describe("a Stop main takes straight away", () => {
  test("is one ask and nothing kept", async () => {
    store().add(row({ status: "downloading" }))

    await requestStop("d1")

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)
    expect(store().cancelIntents).toEqual([])
  })
})

/**
 * main reserves the id only after preparing the download folder, so a Stop
 * pressed before that is answered against nothing. the row is `starting` at
 * that point, which is the one state main has not heard of.
 */
describe("a Stop main was not ready for", () => {
  test("is kept while the row is still starting", async () => {
    mocks.cancelDownload.mockResolvedValue(false)
    store().add(row())

    await requestStop("d1")

    expect(store().cancelIntents).toEqual(["d1"])
    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)
  })

  /**
   * the whole point of keeping it: a download that says nothing until it is
   * finished - a trimmed one is a single ffmpeg pass and does exactly that -
   * gives the panel no event to reconcile against. the acknowledgement is what
   * settles it, and every start path calls this at theirs.
   */
  test("goes out at the acknowledgement, with no event ever having arrived", async () => {
    mocks.cancelDownload.mockResolvedValue(false)
    store().add(row())

    await requestStop("d1")
    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)

    mocks.cancelDownload.mockResolvedValue(true)
    stopIfRequested("d1")
    await settle()

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(2)
    expect(mocks.cancelDownload).toHaveBeenLastCalledWith("d1")
    expect(store().cancelIntents).toEqual([])
  })

  test("goes out on the first event, for a row this window never started", async () => {
    mocks.cancelDownload.mockResolvedValue(false)
    store().add(row())
    await requestStop("d1")

    mocks.cancelDownload.mockResolvedValue(true)
    reconcileCancelIntent({ downloadId: "d1", status: "queued", progress: 0 })
    await settle()

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(2)

    // and it is spent: the progress lines that follow are not more cancels
    reconcileCancelIntent({
      downloadId: "d1",
      status: "downloading",
      progress: 12
    })
    await settle()

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(2)
  })

  /**
   * the other ordering. main reserves the id, emits `queued`, and that event
   * beats the reply to the Stop home - so there was no intent to reconcile when
   * it arrived, and the reply lands to find the row already admitted. a queued
   * row emits nothing further until it takes a slot, so keeping the intent for
   * a later event is keeping it for an event that may never come.
   */
  test("is asked again at once when main's own event overtook the reply", async () => {
    const { answer } = deferredReply()
    store().add(row())

    const stopping = requestStop("d1")

    // the event lands while the reply is still in flight
    store().applyEvent({ downloadId: "d1", status: "queued", progress: 0 })
    reconcileCancelIntent({ downloadId: "d1", status: "queued", progress: 0 })

    answer(false)
    await stopping
    await settle()

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(2)
    expect(store().cancelIntents).toEqual([])
  })

  /**
   * the ordering the row cannot see.
   *
   * main reserves the id and answers the start before it answers the Stop, and
   * the renderer processes them in that order too: `stopIfRequested` runs while
   * the `false` is still in flight, and finds nothing to carry out. the reply
   * then lands on a row that still says `starting`, because a download that
   * took a free slot and is trimmed says nothing at all until it is finished -
   * no queued notice, no progress line. without the admission being written
   * down, the ask waits for an event that never comes and the completion
   * quietly throws it away.
   */
  test("is asked again at once when the acknowledgement overtook the reply", async () => {
    const { answer } = deferredReply()
    store().add(row())

    const stopping = requestStop("d1")

    // main took the start while the Stop's reply was still in flight
    stopIfRequested("d1")
    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)

    answer(false)
    await stopping
    await settle()

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(2)
    expect(mocks.cancelDownload).toHaveBeenLastCalledWith("d1")
    expect(store().cancelIntents).toEqual([])

    // ...and nothing asks a third time when the run finally says something
    reconcileCancelIntent({
      downloadId: "d1",
      status: "completed",
      progress: 100
    })
    await settle()

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(2)
  })

  /**
   * `false` means two things and the row separates them: this one is "the
   * download finished while your click was in flight", and asking again would
   * be asking main to stop a file that is on disk.
   */
  test("is dropped when the row settled while the click was in flight", async () => {
    const { answer } = deferredReply()
    store().add(row({ status: "downloading" }))

    const stopping = requestStop("d1")

    store().applyEvent({ downloadId: "d1", status: "completed", progress: 100 })

    answer(false)
    await stopping
    await settle()

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)
    expect(store().cancelIntents).toEqual([])
  })

  test("a terminal event clears one that is still waiting", () => {
    store().rememberCancelIntent("d1")

    reconcileCancelIntent({
      downloadId: "d1",
      status: "failed",
      progress: 0,
      error: "boom"
    })

    expect(mocks.cancelDownload).not.toHaveBeenCalled()
    expect(store().cancelIntents).toEqual([])
  })
})

describe("a download nobody stopped", () => {
  test("is not cancelled at its acknowledgement", async () => {
    store().add(row())

    stopIfRequested("d1")
    await settle()

    expect(mocks.cancelDownload).not.toHaveBeenCalled()
  })

  test("is not cancelled by its own events either", async () => {
    store().add(row())

    reconcileCancelIntent({
      downloadId: "d1",
      status: "downloading",
      progress: 40
    })
    await settle()

    expect(mocks.cancelDownload).not.toHaveBeenCalled()
  })
})

describe("what is remembered about an admission", () => {
  test("is forgotten once the download is over", async () => {
    store().add(row())

    stopIfRequested("d1")
    expect(store().admittedIds).toEqual(["d1"])

    reconcileCancelIntent({
      downloadId: "d1",
      status: "completed",
      progress: 100
    })

    expect(store().admittedIds).toEqual([])
  })
})

describe("keeping an intent directly", () => {
  test("a row that is already downloading is asked rather than remembered", async () => {
    store().add(row({ status: "downloading" }))

    keepCancelIntent("d1")
    await settle()

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)
    expect(store().cancelIntents).toEqual([])
  })

  test("a row nobody knows is left alone", async () => {
    keepCancelIntent("never-heard-of-it")
    await settle()

    expect(mocks.cancelDownload).not.toHaveBeenCalled()
    expect(store().cancelIntents).toEqual([])
  })
})
