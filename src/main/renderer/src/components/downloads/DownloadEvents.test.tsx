// @vitest-environment jsdom
//
// the two subscriptions every download is watched through. Main pushes the
// whole list whenever it changes and this replaces what the store holds with
// it, so what has to be right here is narrow: the list is taken in the order
// main sent it, the progress events land on the rows it brings, and a download
// is announced exactly once, whoever started it and whatever screen is up by
// the time it ends - including the two things the old per-hook listeners could
// not do, surviving the card that started the download and keeping their hands
// off a playlist, which reports itself.

import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"

import type {
  DownloadHistoryRow,
  DownloadListSnapshot,
  DownloadProgress
} from "@/lib/api"

type ProgressListener = (payload: DownloadProgress) => void
type ListListener = (snapshot: DownloadListSnapshot) => void

const mocks = vi.hoisted(() => ({
  listeners: [] as ProgressListener[],
  listListeners: [] as ListListener[],
  /** how many progress listeners were live when the one read was made */
  listenersAtRead: -1,
  getList: vi.fn(),
  clearHistory: vi.fn(),
  cancelDownload: vi.fn(),
  openDownloadFolder: vi.fn(),
  stage: vi.fn(),
  showDownloadErrorToast: vi.fn(),
  successToast: vi.fn()
}))

vi.mock("@/lib/api", () => ({
  downloadApi: {
    onProgress: (listener: ProgressListener) => {
      mocks.listeners.push(listener)

      return () => {
        const index = mocks.listeners.indexOf(listener)
        if (index >= 0) mocks.listeners.splice(index, 1)
      }
    },
    onList: (listener: ListListener) => {
      mocks.listListeners.push(listener)

      return () => {
        const index = mocks.listListeners.indexOf(listener)
        if (index >= 0) mocks.listListeners.splice(index, 1)
      }
    },
    getList: () => {
      mocks.listenersAtRead = mocks.listeners.length
      return mocks.getList()
    },
    cancelDownload: (downloadId: string) => mocks.cancelDownload(downloadId),
    clearHistory: () => mocks.clearHistory(),
    removeHistory: () => Promise.resolve(snapshot())
  },
  systemApi: { openDownloadFolder: mocks.openDownloadFolder }
}))

vi.mock("@/lib/stores/reportStore", () => ({
  reportActions: { stage: mocks.stage }
}))
vi.mock("@/lib/toast-utils", () => ({
  showDownloadErrorToast: mocks.showDownloadErrorToast
}))
vi.mock("sonner", () => ({
  toast: { success: mocks.successToast, info: vi.fn(), error: vi.fn() }
}))

import { en } from "@/lib/i18n/en"
import {
  useDownloadsStore,
  type DownloadRow
} from "@/lib/stores/downloadsStore"

import { DownloadEvents } from "./DownloadEvents"

const store = () => useDownloadsStore.getState()

const row = (overrides: Partial<DownloadRow> = {}): DownloadRow => ({
  downloadId: "d1",
  kind: "video",
  platform: "youtube",
  title: "My Holiday Video",
  label: "1080p mp4",
  status: "downloading",
  progress: 40,
  startedAt: 1000,
  request: { url: "https://youtu.be/abc", height: 1080, container: "mp4" },
  ...overrides
})

/** one of main's rows */
const listed = (overrides: Partial<DownloadHistoryRow> = {}) =>
  ({
    download_id: "d1",
    status: "downloading",
    kind: "video",
    platform: "youtube",
    title: "My Holiday Video",
    label: "1080p mp4",
    started_at: 1000,
    request: { url: "https://youtu.be/abc", height: 1080, container: "mp4" },
    ...overrides
  }) as DownloadHistoryRow

/** one of main's pushes, in the order main sent them */
let seq = 0
const snapshot = ({
  rows = [] as DownloadHistoryRow[],
  lifetimeCompleted = 0,
  at = 0
} = {}): DownloadListSnapshot => ({
  seq: at || (seq += 1),
  lifetimeCompleted,
  rows
})

/** main's push, as the renderer receives it */
const push = async (snap: DownloadListSnapshot) => {
  await act(async () => {
    for (const listener of [...mocks.listListeners]) listener(snap)
  })
}

const emit = async (payload: Partial<DownloadProgress>) => {
  await act(async () => {
    for (const listener of [...mocks.listeners]) {
      listener({
        downloadId: "d1",
        status: "completed",
        progress: 100,
        ...payload
      } as DownloadProgress)
    }
  })
}

const settled = () => act(async () => {})

async function mount() {
  const view = render(<DownloadEvents />)
  // the one read settles a microtask after mount
  await act(async () => {})

  return view
}

beforeEach(() => {
  mocks.listeners.length = 0
  mocks.listListeners.length = 0
  mocks.listenersAtRead = -1
  seq = 0
  vi.clearAllMocks()
  mocks.getList.mockResolvedValue(snapshot())
  mocks.clearHistory.mockResolvedValue(snapshot())
  mocks.cancelDownload.mockResolvedValue(true)
  store().reset()
})

describe("mounting", () => {
  test("subscribes before it reads, so nothing in between is lost", async () => {
    await mount()

    expect(mocks.listenersAtRead).toBe(1)
    expect(mocks.listListeners).toHaveLength(1)
    expect(mocks.getList).toHaveBeenCalledTimes(1)
    expect(store().hydrated).toBe(true)
  })

  test("unmounting drops both subscriptions", async () => {
    const view = await mount()

    view.unmount()

    expect(mocks.listeners).toHaveLength(0)
    expect(mocks.listListeners).toHaveLength(0)
  })

  test("a list it could not read is an empty panel, not a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.getList.mockRejectedValue(new Error("no list for you"))

    await mount()

    expect(store().rows).toEqual([])

    // ...and the next change to the list arrives on the push channel anyway
    await push(snapshot({ rows: [listed()] }))

    expect(store().rows.map((r) => r.downloadId)).toEqual(["d1"])
    expect(store().hydrated).toBe(true)
  })

  /**
   * the read and the pushes are one stream, ordered by main's own count: a push
   * that overtakes the reply to the read is the newer list, and applying the
   * reply afterwards would undo it.
   */
  test("a push that overtakes the read is not undone by it", async () => {
    let answer!: (snap: DownloadListSnapshot) => void
    mocks.getList.mockReturnValue(
      new Promise<DownloadListSnapshot>((resolve) => {
        answer = resolve
      })
    )

    render(<DownloadEvents />)
    await settled()

    await push(snapshot({ rows: [listed({ status: "completed" })], at: 2 }))

    await act(async () => {
      answer(snapshot({ rows: [listed()], at: 1 }))
    })
    await settled()

    expect(store().rows[0].status).toBe("completed")
  })
})

/**
 * every scenario the six rounds of this panel's review accumulated, in the two
 * things that now exist: main's pushes, and the progress events.
 */
describe("the list, and the events over it", () => {
  test("a download admitted after the read still gets its row", async () => {
    await mount()

    // main reserved it after this window had read the list, and says so
    await push(snapshot({ rows: [listed({ download_id: "late" })] }))

    expect(store().rows.map((r) => r.downloadId)).toEqual(["late"])
  })

  test("a silent run is a row from the moment it is accepted", async () => {
    await mount()

    await push(
      snapshot({ rows: [listed({ download_id: "silent", status: "queued" })] })
    )

    expect(store().rows[0]).toMatchObject({
      downloadId: "silent",
      status: "queued"
    })
  })

  test("progress before the list lands is applied when the row arrives", async () => {
    await mount()

    await emit({ downloadId: "late", status: "downloading", progress: 62 })
    await push(snapshot({ rows: [listed({ download_id: "late" })] }))

    expect(store().rows[0]).toMatchObject({
      downloadId: "late",
      progress: 62
    })
  })

  /**
   * a completion can overtake the push that lists its download. The ending is
   * this window's news either way, so it waits for the row and is said once.
   */
  test("a completion that arrives before its row is announced when it lands", async () => {
    await mount()

    await emit({ downloadId: "late", status: "completed", progress: 100 })

    expect(mocks.successToast).not.toHaveBeenCalled()

    await push(
      snapshot({
        rows: [listed({ download_id: "late", status: "completed" })]
      })
    )

    expect(mocks.successToast).toHaveBeenCalledTimes(1)

    // ...and not again, however many lists follow
    await push(
      snapshot({
        rows: [listed({ download_id: "late", status: "completed" })]
      })
    )

    expect(mocks.successToast).toHaveBeenCalledTimes(1)
  })

  test("and once when the push comes first", async () => {
    await mount()

    await push(snapshot({ rows: [listed({ download_id: "late" })] }))
    await emit({ downloadId: "late", status: "completed", progress: 100 })

    expect(mocks.successToast).toHaveBeenCalledTimes(1)
  })

  /**
   * a row that arrives already finished with no event behind it is a download
   * nobody in this window was waiting on: another window's, or one that ended
   * before this one opened.
   */
  test("but a finished row nobody here was waiting on says nothing", async () => {
    await mount()

    await push(
      snapshot({
        rows: [listed({ download_id: "someone-elses", status: "completed" })]
      })
    )

    expect(mocks.successToast).not.toHaveBeenCalled()
  })

  test("a hundred unknown ids cost nothing at all", async () => {
    await mount()

    await act(async () => {
      for (let index = 0; index < 100; index += 1) {
        for (const listener of [...mocks.listeners]) {
          listener({
            downloadId: `ghost-${index}`,
            status: "downloading",
            progress: 1
          } as DownloadProgress)
        }
      }
    })

    // there is nothing to ask: the list is main's to send
    expect(mocks.getList).toHaveBeenCalledTimes(1)
    expect(store().rows).toEqual([])
  })

  test("a push cannot turn a finished row live again", async () => {
    await mount()
    await push(snapshot({ rows: [listed()] }))

    await emit({ status: "completed", progress: 100 })
    // a push built before the completion landed
    await push(snapshot({ rows: [listed()] }))

    expect(store().rows[0].status).toBe("completed")
  })

  test("a row cleared while a push was in flight does not come back", async () => {
    await mount()
    const older = snapshot({ rows: [listed({ download_id: "done" })], at: 1 })

    await push(snapshot({ rows: [listed({ download_id: "done" })], at: 2 }))
    mocks.clearHistory.mockResolvedValue(snapshot({ rows: [], at: 3 }))

    await act(async () => {
      store().clearFinished()
    })
    await settled()

    await push(older)

    expect(store().rows).toEqual([])
  })

  test("two clears in a row leave the list empty", async () => {
    await mount()
    await push(snapshot({ rows: [listed({ status: "completed" })] }))

    mocks.clearHistory.mockResolvedValue(snapshot({ rows: [] }))

    await act(async () => {
      store().clearFinished()
    })
    await settled()
    await act(async () => {
      store().clearFinished()
    })
    await settled()

    expect(store().rows).toEqual([])
  })

  test("the count comes with the list and never walks backwards", async () => {
    await mount()

    await push(snapshot({ lifetimeCompleted: 128 }))
    await push(snapshot({ lifetimeCompleted: 127 }))

    expect(store().lifetimeCompleted).toBe(128)
  })

  test("every event is applied to the row it names", async () => {
    await mount()
    await push(
      snapshot({
        rows: [listed(), listed({ download_id: "other", label: "720p mp4" })]
      })
    )

    await emit({ downloadId: "other", status: "downloading", progress: 12 })

    expect(store().rows.find((r) => r.downloadId === "other")?.progress).toBe(
      12
    )
    // the two rows are separate: this is the regression the one store fixes
    expect(store().rows.find((r) => r.downloadId === "d1")?.progress).toBe(0)
  })
})

describe("terminal outcomes", () => {
  test("a completion toasts once, names the file and offers the folder", async () => {
    await mount()
    store().add(row())

    await emit({ status: "completed", filename: "clip.mp4" })

    expect(mocks.successToast).toHaveBeenCalledTimes(1)
    expect(mocks.successToast.mock.calls[0][0]).toBe(
      en["download.videoCompleted"]
    )
    expect(mocks.successToast.mock.calls[0][1]).toMatchObject({
      description: en["download.saved"].replace("{filename}", "clip.mp4")
    })
    mocks.successToast.mock.calls[0][1].action.onClick()
    expect(mocks.openDownloadFolder).toHaveBeenCalledTimes(1)

    expect(mocks.showDownloadErrorToast).not.toHaveBeenCalled()
    expect(mocks.stage).not.toHaveBeenCalled()
  })

  test("a failure toasts once and stages one report", async () => {
    await mount()
    store().add(row())

    await emit({
      status: "failed",
      progress: 0,
      error: "Video unavailable",
      details: "stderr tail",
      category: "VIDEO_UNAVAILABLE"
    })

    expect(mocks.showDownloadErrorToast).toHaveBeenCalledTimes(1)
    expect(mocks.showDownloadErrorToast.mock.calls[0][0]).toBe(
      en["download.videoFailed"]
    )
    expect(mocks.stage).toHaveBeenCalledTimes(1)
    expect(mocks.stage.mock.calls[0][0]).toMatchObject({
      // english on purpose: the maintainer reading the issue is not the user
      shortMessage: "Video unavailable",
      details: "stderr tail",
      category: "VIDEO_UNAVAILABLE",
      platform: "youtube",
      downloadType: "video",
      videoUrl: "https://youtu.be/abc"
    })
    expect(mocks.successToast).not.toHaveBeenCalled()
  })

  test("a cancellation says nothing: whoever asked has already been told", async () => {
    await mount()
    store().add(row())

    await emit({ status: "cancelled", progress: 0 })

    expect(mocks.successToast).not.toHaveBeenCalled()
    expect(mocks.showDownloadErrorToast).not.toHaveBeenCalled()
    expect(mocks.stage).not.toHaveBeenCalled()
    expect(store().rows[0].status).toBe("cancelled")
  })

  test("each kind is announced in its own words", async () => {
    await mount()
    store().add(row({ downloadId: "a", kind: "audio", label: "mp3" }))
    store().add(
      row({
        downloadId: "s",
        kind: "simple",
        platform: "tiktok",
        label: "tiktok"
      })
    )

    await emit({ downloadId: "a", status: "completed", filename: "song.mp3" })
    await emit({ downloadId: "s", status: "completed", filename: "clip.mp4" })

    expect(mocks.successToast.mock.calls.map((call) => call[0])).toEqual([
      en["download.audioCompleted"],
      en["download.complete"]
    ])
  })

  test("a simple platform's failure is reported as its own platform's", async () => {
    await mount()
    store().add(
      row({
        kind: "simple",
        platform: "pinterest",
        label: "pinterest",
        request: { url: "https://pin.it/abc" }
      })
    )

    await emit({
      status: "failed",
      progress: 0,
      error: "Download failed",
      category: "DOWNLOAD_FAILED"
    })

    expect(mocks.stage.mock.calls[0][0]).toMatchObject({
      platform: "pinterest",
      videoUrl: "https://pin.it/abc"
    })
    // the cookie jar is youtube's, so the toast has to know whose failure it is
    expect(mocks.showDownloadErrorToast.mock.calls[0][3]).toBe("pinterest")
  })

  /**
   * D9: the playlist hook keeps its own listener, its own per-item badges and
   * its own summary, which counts videos rather than naming a file. both
   * listeners see every event, so the only thing keeping the toast from
   * doubling is this check.
   */
  test("a playlist row is updated and never announced", async () => {
    await mount()
    store().add(row({ downloadId: "pl", kind: "playlist", label: "12 videos" }))

    await emit({
      downloadId: "pl",
      status: "completed",
      items_saved: 12,
      items_total: 12
    })

    expect(mocks.successToast).not.toHaveBeenCalled()
    expect(store().rows[0]).toMatchObject({
      status: "completed",
      itemsSaved: 12
    })

    await emit({
      downloadId: "pl",
      status: "failed",
      progress: 0,
      error: "boom"
    })

    expect(mocks.showDownloadErrorToast).not.toHaveBeenCalled()
    expect(mocks.stage).not.toHaveBeenCalled()
  })
})

/**
 * a Stop the panel could not get taken, asked again
 *
 * main reserves an id only after it has prepared the download folder, so a Stop
 * pressed on a row that has only just appeared is answered against nothing. the
 * row records the intent (see `stopDownload` in `DownloadRow`) and this is what
 * carries it out - here rather than in the row, because the panel can be closed
 * and the row unmounted and the download should still stop.
 */
describe("a cancel main was not ready for", () => {
  test("is issued again on the row's first event, once and once only", async () => {
    await mount()
    store().add(row({ status: "starting", progress: 0 }))
    store().rememberCancelIntent("d1")

    await emit({ status: "queued", progress: 0 })

    expect(mocks.cancelDownload).toHaveBeenCalledWith("d1")
    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)
    expect(store().cancelIntents).toEqual([])

    // the run takes its slot before main gets the cancel: the intent has been
    // spent, and every progress line after it is not another cancel
    await emit({ status: "downloading", progress: 12 })

    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)
  })

  test("is dropped when the download turns out to be over", async () => {
    await mount()
    store().add(row())
    store().rememberCancelIntent("d1")

    await emit({ status: "completed", progress: 100 })

    expect(mocks.cancelDownload).not.toHaveBeenCalled()
    expect(store().cancelIntents).toEqual([])
  })

  test("leaves a row nobody stopped alone", async () => {
    await mount()
    store().add(row({ status: "starting", progress: 0 }))

    await emit({ status: "queued", progress: 0 })

    expect(mocks.cancelDownload).not.toHaveBeenCalled()
  })
})
