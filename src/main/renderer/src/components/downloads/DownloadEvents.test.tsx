// @vitest-environment jsdom
//
// the one subscription, and the only place a download's outcome is announced.
// what it has to get right is exactly once per terminal event, whoever started
// the download and whatever screen is up by the time it ends - plus the two
// things the old per-hook listeners could not do: survive the card that started
// the download, and keep its hands off a playlist, which reports itself.

import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"

import type {
  DownloadHistoryRow,
  DownloadProgress,
  DownloadStatus
} from "@/lib/api"

type ProgressListener = (payload: DownloadProgress) => void

const mocks = vi.hoisted(() => ({
  listeners: [] as ProgressListener[],
  /** how many listeners were live when the hydration reads were made */
  listenersAtRead: -1,
  getAllDownloads: vi.fn(),
  getHistory: vi.fn(),
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
    getAllDownloads: () => {
      mocks.listenersAtRead = mocks.listeners.length
      return mocks.getAllDownloads()
    },
    getHistory: () => mocks.getHistory(),
    clearHistory: vi.fn(),
    removeHistory: vi.fn()
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

async function mount() {
  const view = render(<DownloadEvents />)
  // the two hydration reads settle a microtask after mount
  await act(async () => {})

  return view
}

/**
 * mount with the history read left hanging, so the hydration window is open
 *
 * the window is a couple of milliseconds in the app and every event that lands
 * inside it is one main will never send again, so it is held open here on
 * purpose. `landed` closes it with the rows a real answer would have carried.
 */
function mountMidRead(active: Partial<DownloadStatus>[] = []) {
  let resolveHistory!: (rows: DownloadHistoryRow[]) => void
  let rejectHistory!: (error: Error) => void

  mocks.getAllDownloads.mockResolvedValue(active)
  mocks.getHistory.mockReturnValue(
    new Promise<DownloadHistoryRow[]>((resolve, reject) => {
      resolveHistory = resolve
      rejectHistory = reject
    })
  )

  const view = render(<DownloadEvents />)

  return {
    view,
    landed: (history: DownloadHistoryRow[] = []) =>
      act(async () => resolveHistory(history)),
    refused: () => act(async () => rejectHistory(new Error("no list for you")))
  }
}

const live = (overrides: Partial<DownloadStatus> = {}): DownloadStatus => ({
  downloadId: "d1",
  status: "downloading",
  progress: 40,
  type: "combined",
  platform: "youtube",
  title: "My Holiday Video",
  label: "1080p mp4",
  request: { url: "https://youtu.be/abc", height: 1080, container: "mp4" },
  ...overrides
})

beforeEach(() => {
  mocks.listeners.length = 0
  mocks.listenersAtRead = -1
  vi.clearAllMocks()
  mocks.getAllDownloads.mockResolvedValue([])
  mocks.getHistory.mockResolvedValue([])
  store().reset()
})

describe("mounting", () => {
  test("subscribes before it reads, so nothing in between is lost", async () => {
    await mount()

    expect(mocks.listenersAtRead).toBe(1)
    expect(mocks.getHistory).toHaveBeenCalledTimes(1)
    expect(store().hydrated).toBe(true)
  })

  test("unmounting drops the subscription", async () => {
    const view = await mount()
    expect(mocks.listeners).toHaveLength(1)

    view.unmount()
    expect(mocks.listeners).toHaveLength(0)
  })

  test("a list it could not read is an empty panel, not a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.getHistory.mockRejectedValue(new Error("no ipc here"))

    await mount()

    expect(store().rows).toEqual([])
    // and events still land, which is the part that matters
    store().add(row())
    await emit({ status: "downloading", progress: 70 })
    expect(store().rows[0].progress).toBe(70)
  })
})

/**
 * the window between subscribing and the list arriving
 *
 * subscribing first is only half of it. after a reload the store knows nothing,
 * so every download in flight is an id `applyEvent` would drop - and hydration
 * then writes main's snapshot, which that dropped event has already made out of
 * date. a download that failed in the window would sit at "downloading" for the
 * rest of the session, counted as active, its failure never reported.
 */
describe("events that arrive while the list is still loading", () => {
  test("a download that fails in the window keeps its failure, reported once", async () => {
    const { view, landed } = mountMidRead([live()])

    try {
      await emit({ status: "failed", progress: 0, error: "Disk full" })

      // nothing to apply it to yet, and nothing to say about it yet
      expect(store().rows).toEqual([])
      expect(mocks.showDownloadErrorToast).not.toHaveBeenCalled()

      await landed([
        {
          download_id: "d1",
          status: "failed",
          kind: "video",
          error: "Disk full"
        }
      ])

      // ...and main's "downloading" snapshot does not win over it
      expect(store().rows[0]).toMatchObject({
        status: "failed",
        error: "Disk full"
      })
      expect(mocks.showDownloadErrorToast).toHaveBeenCalledTimes(1)
      expect(mocks.stage).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  test("hydration does not undo a completion that already landed", async () => {
    store().add(row({ status: "starting" }))
    const { view, landed } = mountMidRead([live()])

    try {
      await emit({ status: "completed", filename: "clip.mp4" })

      // the row was already there, so this was applied and announced on arrival
      expect(store().rows[0].status).toBe("completed")
      expect(mocks.successToast).toHaveBeenCalledTimes(1)

      await landed()

      expect(store().rows[0]).toMatchObject({
        status: "completed",
        filename: "clip.mp4"
      })
      // the replay must not announce it a second time
      expect(mocks.successToast).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  test("the window's events are replayed in the order they arrived", async () => {
    const { view, landed } = mountMidRead([live({ progress: 5 })])

    try {
      await emit({ status: "downloading", progress: 60, speed: "2.1MiB/s" })
      await emit({ status: "completed", progress: 100, filename: "clip.mp4" })
      await landed()

      expect(store().rows[0]).toMatchObject({
        status: "completed",
        progress: 100,
        filename: "clip.mp4"
      })
      expect(mocks.successToast).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  test("an id neither the list nor the store knows is still dropped", async () => {
    const { view, landed } = mountMidRead([live()])

    try {
      await emit({ downloadId: "from-a-previous-life", status: "completed" })
      await landed()

      expect(store().rows.map((r) => r.downloadId)).toEqual(["d1"])
      expect(mocks.successToast).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })

  /**
   * the window closes on a read that never answers too, and closing it replays
   * what it held - so an event already announced on arrival must not be
   * announced again by the replay
   */
  test("a read that failed closes the window without repeating itself", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    store().add(row({ status: "downloading" }))
    const { view, refused } = mountMidRead([live()])

    try {
      await emit({ status: "completed", filename: "clip.mp4" })
      expect(mocks.successToast).toHaveBeenCalledTimes(1)

      await refused()

      expect(store().rows[0].status).toBe("completed")
      expect(mocks.successToast).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })
})

describe("what an event does to the list", () => {
  test("an id the list does not have is ignored", async () => {
    await mount()

    await emit({ downloadId: "from-a-previous-life" })

    expect(store().rows).toEqual([])
    expect(mocks.successToast).not.toHaveBeenCalled()
  })

  test("every event is applied to the row it names", async () => {
    await mount()
    store().add(row())
    store().add(row({ downloadId: "other", label: "720p mp4" }))

    await emit({ downloadId: "other", status: "downloading", progress: 12 })

    expect(store().rows.find((r) => r.downloadId === "other")?.progress).toBe(
      12
    )
    // the two rows are separate: this is the regression the one store fixes
    expect(store().rows.find((r) => r.downloadId === "d1")?.progress).toBe(40)
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
