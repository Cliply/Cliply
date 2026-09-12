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
  getDownloadCount: vi.fn(),
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
    getAllDownloads: () => {
      mocks.listenersAtRead = mocks.listeners.length
      return mocks.getAllDownloads()
    },
    getHistory: () => mocks.getHistory(),
    cancelDownload: (downloadId: string) => mocks.cancelDownload(downloadId),
    clearHistory: () => mocks.clearHistory(),
    removeHistory: vi.fn()
  },
  systemApi: { openDownloadFolder: mocks.openDownloadFolder },
  // the lifetime number the panel shows, read in the same window as the two
  // lists (see the Promise.all in DownloadEvents)
  settingsApi: { getDownloadCount: () => mocks.getDownloadCount() }
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

/** let a re-read of main's snapshot, and the replay behind it, land */
const settled = () => act(async () => {})

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
  mocks.getDownloadCount.mockResolvedValue(0)
  mocks.clearHistory.mockResolvedValue([])
  mocks.cancelDownload.mockResolvedValue(true)
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
  test("an id neither the list nor main has is ignored", async () => {
    await mount()

    await emit({ downloadId: "from-a-previous-life" })
    await settled()

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

/**
 * a download main admitted after this window had already read its list
 *
 * the hole the final review reproduced: a start whose acknowledgement never
 * reached a renderer (main was still preparing the download folder when the
 * window reloaded), so neither snapshot mentioned it and it was reserved
 * afterwards. Its events name an id the store has no row for, `applyEvent`
 * drops those by design, and the download holds a slot with nothing on screen
 * to stop it.
 */
describe("a download admitted after the list was read", () => {
  test("an unknown id is asked about, and becomes a row", async () => {
    await mount()
    mocks.getAllDownloads.mockResolvedValue([live({ downloadId: "late" })])

    await emit({ downloadId: "late", status: "downloading", progress: 12 })
    await settled()

    const adopted = store().rows.find((r) => r.downloadId === "late")

    expect(adopted?.title).toBe("My Holiday Video")
    // main's row, with the event that provoked the read replayed over it: the
    // snapshot is already out of date by the time it arrives
    expect(adopted?.progress).toBe(12)
    // and it can be stopped, which is the whole point: the request came with it
    expect(adopted?.request).toMatchObject({ url: "https://youtu.be/abc" })
  })

  test("and an unknown completion becomes a finished row, announced once", async () => {
    await mount()
    mocks.getHistory.mockResolvedValue([
      {
        download_id: "late",
        status: "completed",
        kind: "video",
        platform: "youtube",
        title: "Landed while we were away",
        label: "1080p mp4",
        started_at: 10
      } as DownloadHistoryRow
    ])

    await emit({
      downloadId: "late",
      status: "completed",
      progress: 100,
      filename: "late.mp4"
    })
    await settled()

    expect(store().rows.map((r) => r.downloadId)).toEqual(["late"])
    expect(store().rows[0].status).toBe("completed")
    expect(mocks.successToast).toHaveBeenCalledTimes(1)
  })

  /**
   * main's snapshot wins at startup because the store has nothing better. Here
   * it does: every row it holds has been kept current by the events since, and
   * an older snapshot landing on top of them would undo a completion or drag a
   * bar backwards.
   */
  test("the answer adds rows and overwrites none", async () => {
    await mount()
    store().add(row())
    mocks.getAllDownloads.mockResolvedValue([
      live({ downloadId: "d1", progress: 5, title: "An older title" }),
      live({ downloadId: "late" })
    ])

    await emit({ downloadId: "late", status: "downloading", progress: 12 })
    await settled()

    const known = store().rows.find((r) => r.downloadId === "d1")

    expect(known?.progress).toBe(40)
    expect(known?.title).toBe("My Holiday Video")
  })

  /**
   * a snapshot can be built a moment before a reservation, so one answer
   * without the id does not prove main has never heard of it. Two do, and then
   * it is let go: twenty more events for a dead id are not twenty more reads.
   */
  test("an id main does not know either is dropped, after two reads and no more", async () => {
    await mount()
    const reads = mocks.getHistory.mock.calls.length

    for (let percent = 1; percent <= 20; percent += 1) {
      await emit({
        downloadId: "ghost",
        status: "downloading",
        progress: percent
      })
      await settled()
    }

    expect(store().rows).toEqual([])
    expect(mocks.successToast).not.toHaveBeenCalled()
    expect(mocks.getHistory).toHaveBeenCalledTimes(reads + 2)
  })

  /**
   * finding 2, the startup half: a clear while the first read is still in
   * flight. Throwing that whole answer away cost the session its lifetime
   * count, the download that was still running and the flag the panel needs
   * before it can say it is empty.
   */
  test("a clear during startup keeps the count, the live row and the flag", async () => {
    // the count is read in the same window as the two lists, so it is set
    // before the mount rather than after it
    mocks.getDownloadCount.mockResolvedValue(128)
    const hydration = mountMidRead([live({ downloadId: "running" })])

    // a start this window refused locally leaves a finished row, which is
    // enough to enable "clear history" before hydration has settled
    store().add(row({ downloadId: "refused", status: "failed" }))

    await act(async () => {
      store().clearFinished()
    })

    await hydration.landed([
      { download_id: "old", status: "completed" } as DownloadHistoryRow
    ])
    await settled()

    // the cleared rows stay gone, and everything else the answer carried lands
    expect(store().rows.map((r) => r.downloadId)).toEqual(["running"])
    expect(store().lifetimeCompleted).toBe(128)
    expect(store().hydrated).toBe(true)
  })

  /**
   * finding 1, first ordering: everything that arrives while the answer is
   * coming belongs to the same download. Keeping only the event that provoked
   * the read left the row at 1% with no toast, because the completion that
   * arrived behind it was dropped by `applyEvent` and never buffered.
   */
  test("every event that arrives during the read is kept, in order", async () => {
    await mount()

    let answer!: (rows: DownloadHistoryRow[]) => void
    mocks.getAllDownloads.mockResolvedValue([live({ downloadId: "late" })])
    mocks.getHistory.mockReturnValue(
      new Promise<DownloadHistoryRow[]>((resolve) => {
        answer = resolve
      })
    )

    await emit({ downloadId: "late", status: "downloading", progress: 1 })
    await emit({
      downloadId: "late",
      status: "completed",
      progress: 100,
      filename: "late.mp4"
    })

    await act(async () => {
      answer([])
    })
    await settled()

    expect(store().rows[0]).toMatchObject({
      downloadId: "late",
      status: "completed"
    })
    expect(mocks.successToast).toHaveBeenCalledTimes(1)
  })

  /**
   * finding 1, second ordering: the same two events inside the startup window,
   * with main's history already describing the download as finished. Replaying
   * the first one over that row turned a completed download back into a live
   * one, with a Stop on a file that was on disk.
   */
  test("and a replay cannot turn a finished row live again", async () => {
    const hydration = mountMidRead()

    await emit({ downloadId: "late", status: "downloading", progress: 1 })
    await emit({
      downloadId: "late",
      status: "completed",
      progress: 100,
      filename: "late.mp4"
    })

    mocks.getAllDownloads.mockResolvedValue([])
    mocks.getHistory.mockResolvedValue([
      {
        download_id: "late",
        status: "completed",
        kind: "video",
        platform: "youtube",
        title: "Landed while we were away",
        started_at: 10
      } as DownloadHistoryRow
    ])

    // the startup snapshots know nothing about it, so it goes to the same
    // pending map every later unknown id uses
    await hydration.landed([])
    await settled()

    expect(store().rows[0]).toMatchObject({
      downloadId: "late",
      status: "completed"
    })
    expect(mocks.successToast).toHaveBeenCalledTimes(1)
  })

  /**
   * finding 3: an id admitted after a read was issued cannot be concluded by
   * that read. The answer was built before main had heard of it, so its absence
   * says nothing at all.
   */
  test("an id admitted after the read was issued gets its own read", async () => {
    await mount()

    let answer!: (rows: DownloadStatus[]) => void
    mocks.getAllDownloads.mockReturnValue(
      new Promise<DownloadStatus[]>((resolve) => {
        answer = resolve
      })
    )

    await emit({ downloadId: "a", status: "downloading", progress: 1 })
    // b is admitted while the first read is in flight, so that read's answer
    // will not mention it
    await emit({ downloadId: "b", status: "downloading", progress: 1 })

    mocks.getAllDownloads.mockResolvedValue([live({ downloadId: "b" })])

    await act(async () => {
      answer([live({ downloadId: "a" })])
    })
    await settled()

    expect(
      store()
        .rows.map((r) => r.downloadId)
        .sort()
    ).toEqual(["a", "b"])
  })

  // the same for a read that never answered: a refused bridge is not proof
  // that main has no such download
  test("a rejected read is retried once, and then let go", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await mount()
    const reads = mocks.getHistory.mock.calls.length
    mocks.getAllDownloads.mockRejectedValue(new Error("no list for you"))

    await emit({ downloadId: "late", status: "downloading", progress: 1 })
    await settled()
    await settled()

    expect(mocks.getHistory).toHaveBeenCalledTimes(reads + 2)

    // and then it stops asking, however many more events arrive
    await emit({ downloadId: "late", status: "downloading", progress: 2 })
    await settled()

    expect(mocks.getHistory).toHaveBeenCalledTimes(reads + 2)
  })

  /**
   * finding 2, adoption half: a clear while a live id is being adopted used to
   * throw the whole answer away, and the id was never asked about again.
   */
  test("a clear during the read keeps the live row it was asked for", async () => {
    await mount()
    store().add(row({ downloadId: "old", status: "completed" }))

    let answer!: (rows: DownloadStatus[]) => void
    mocks.getAllDownloads.mockReturnValue(
      new Promise<DownloadStatus[]>((resolve) => {
        answer = resolve
      })
    )

    await emit({ downloadId: "late", status: "downloading", progress: 1 })

    await act(async () => {
      store().clearFinished()
    })

    await act(async () => {
      answer([live({ downloadId: "late" })])
    })
    await settled()

    expect(store().rows.map((r) => r.downloadId)).toEqual(["late"])
  })

  // a run reports four times a second: a read per event would be a read per
  // percent, and two unknown ids at once are still one question
  test("everything that arrives during the read shares it", async () => {
    await mount()
    const reads = mocks.getHistory.mock.calls.length

    let answer!: (rows: DownloadStatus[]) => void
    mocks.getAllDownloads.mockReturnValue(
      new Promise<DownloadStatus[]>((resolve) => {
        answer = resolve
      })
    )

    await emit({ downloadId: "late", status: "downloading", progress: 1 })
    await emit({ downloadId: "later", status: "downloading", progress: 1 })
    await emit({ downloadId: "late", status: "downloading", progress: 2 })

    expect(mocks.getHistory).toHaveBeenCalledTimes(reads + 1)

    await act(async () => {
      answer([live({ downloadId: "late" }), live({ downloadId: "later" })])
    })
    await settled()

    expect(
      store()
        .rows.map((r) => r.downloadId)
        .sort()
    ).toEqual(["late", "later"])
  })

  // the read is one more thing that can fail, and a panel missing a row is not
  // a reason to break the app
  test("a read that fails leaves the list alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await mount()
    mocks.getAllDownloads.mockRejectedValue(new Error("no list for you"))

    await emit({ downloadId: "late", status: "downloading", progress: 1 })
    await settled()

    expect(store().rows).toEqual([])
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
