// @vitest-environment jsdom
//
// the one list every download ends up in. what it has to get right is which
// events it accepts, what a reload rebuilds, and when two clicks are the same
// download - the last of which is the difference between one process and two
// writing the same .part file.

import { beforeEach, describe, expect, test, vi } from "vitest"

import type {
  DownloadHistoryRow,
  DownloadListSnapshot,
  DownloadProgress
} from "@/lib/api"

const mocks = vi.hoisted(() => ({
  clearHistory: vi.fn(),
  removeHistory: vi.fn()
}))

/**
 * main answers `{epoch, rows}`; a bare array is what most of these fixtures
 * hand back, and it reads as epoch 0 exactly as `api.ts` reads it
 */
const asSnapshot = (rows: unknown) =>
  Array.isArray(rows) ? { epoch: 0, rows } : rows

vi.mock("@/lib/api", () => ({
  downloadApi: {
    clearHistory: () => Promise.resolve(mocks.clearHistory()).then(asSnapshot),
    removeHistory: (downloadId: string) =>
      Promise.resolve(mocks.removeHistory(downloadId)).then(asSnapshot)
  }
}))

import { useDownloadsStore, type DownloadRow } from "./downloadsStore"

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

const event = (
  overrides: Partial<DownloadProgress> = {}
): DownloadProgress => ({
  downloadId: "d1",
  status: "downloading",
  progress: 40,
  ...overrides
})

const store = () => useDownloadsStore.getState()

/**
 * one of main's pushes
 *
 * the list is main's to build and this side replaces what it has with it, so
 * every test that used to hydrate or adopt now hands over one of these.
 */
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

/** let a reply from main, and the reconciliation behind it, land */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const rowOf = (downloadId: string) =>
  store().rows.find((known) => known.downloadId === downloadId)

beforeEach(() => {
  seq = 0
  vi.clearAllMocks()
  mocks.clearHistory.mockResolvedValue([])
  mocks.removeHistory.mockResolvedValue([])
  store().reset()
})

describe("adding rows", () => {
  test("the newest download is at the front", () => {
    store().add(row({ downloadId: "first" }))
    store().add(row({ downloadId: "second" }))

    expect(store().rows.map((known) => known.downloadId)).toEqual([
      "second",
      "first"
    ])
  })

  test("the same id twice is one row", () => {
    store().add(row({ downloadId: "d1", label: "720p mp4" }))
    store().add(row({ downloadId: "d1", label: "1080p mp4" }))

    expect(store().rows).toHaveLength(1)
    expect(rowOf("d1")?.label).toBe("1080p mp4")
  })
})

describe("applying events", () => {
  test("an event for an id nobody knows creates nothing", () => {
    store().applyEvent(event({ downloadId: "from-a-previous-life" }))

    expect(store().rows).toEqual([])
  })

  test("progress, speed and the queue are all merged", () => {
    store().add(row())

    store().applyEvent(event({ status: "queued", progress: 0 }))
    expect(rowOf("d1")?.status).toBe("queued")

    store().applyEvent(event({ progress: 40, speed: "2.1MiB/s", eta: "00:12" }))

    expect(rowOf("d1")).toMatchObject({
      status: "downloading",
      progress: 40,
      speed: "2.1MiB/s",
      eta: "00:12"
    })
  })

  test("a completed event carries the file and stamps the finish", () => {
    store().add(row())

    store().applyEvent(
      event({
        status: "completed",
        progress: 100,
        filename: "clip.mp4",
        file_size: 12345
      })
    )

    expect(rowOf("d1")).toMatchObject({
      status: "completed",
      progress: 100,
      filename: "clip.mp4",
      fileSize: 12345
    })
  })

  /**
   * a failure and a cancel both report 0, and a download that got 60% of the
   * way through did not un-download it. the panel draws no bar for a settled
   * row, but the number is the difference between "nothing happened" and
   * "stopped most of the way in"
   */
  test("a terminal event at zero keeps the progress the row had", () => {
    store().add(row())
    store().applyEvent(event({ progress: 60 }))
    store().applyEvent(event({ status: "failed", progress: 0, error: "boom" }))

    expect(rowOf("d1")).toMatchObject({
      status: "failed",
      progress: 60,
      error: "boom"
    })
  })

  test("a playlist row keeps its counts", () => {
    store().add(row({ downloadId: "pl", kind: "playlist", itemsTotal: 12 }))

    store().applyEvent(
      event({ downloadId: "pl", items_completed: 3, items_total: 12 })
    )
    expect(rowOf("pl")).toMatchObject({ itemsCompleted: 3, itemsTotal: 12 })

    store().applyEvent(
      event({
        downloadId: "pl",
        status: "completed",
        progress: 100,
        items_saved: 9,
        items_reused: 3,
        items_skipped: 0
      })
    )

    expect(rowOf("pl")).toMatchObject({
      itemsSaved: 9,
      itemsReused: 3,
      itemsSkipped: 0,
      // the event named no new total, so the one from the selection stands
      itemsTotal: 12
    })
  })
})

describe("taking main's list", () => {
  const rows: DownloadHistoryRow[] = [
    {
      download_id: "live",
      status: "downloading",
      kind: "video",
      platform: "youtube",
      title: "Still going",
      label: "1080p mp4",
      started_at: 5000,
      request: { url: "https://youtu.be/live", height: 1080, container: "mp4" }
    },
    {
      download_id: "done",
      status: "completed",
      kind: "audio",
      platform: "youtube",
      title: "Finished a while ago",
      label: "mp3",
      started_at: 3000,
      finished_at: 3500,
      filename: "song.mp3",
      file_size: 999
    },
    {
      download_id: "stopped",
      status: "interrupted",
      kind: "simple",
      platform: "tiktok",
      title: "Never finished",
      started_at: 4000
    }
  ]

  test("the rows are main's, newest first, and the list is hydrated", () => {
    store().applySnapshot(snapshot({ rows, lifetimeCompleted: 12 }))

    expect(store().rows.map((known) => known.downloadId)).toEqual([
      "live",
      "stopped",
      "done"
    ])
    expect(store().hydrated).toBe(true)
    expect(store().lifetimeCompleted).toBe(12)
    expect(rowOf("stopped")).toMatchObject({
      kind: "simple",
      platform: "tiktok",
      status: "interrupted",
      progress: 0
    })
    expect(rowOf("done")).toMatchObject({
      kind: "audio",
      status: "completed",
      // the history keeps no percentages: a finished download is at 100
      progress: 100,
      fileSize: 999
    })
  })

  /**
   * main pushes the list when it changes, not four times a second, so the bar
   * lives on this side. A push must not send it back to where the download was
   * accepted.
   */
  test("what the events know is kept over the rows it replaces", () => {
    store().applySnapshot(snapshot({ rows }))
    store().applyEvent(
      event({
        downloadId: "live",
        status: "downloading",
        progress: 62,
        speed: "4.2MiB/s",
        eta: "00:31"
      })
    )

    store().applySnapshot(snapshot({ rows }))

    expect(rowOf("live")).toMatchObject({
      progress: 62,
      speed: "4.2MiB/s",
      eta: "00:31"
    })
  })

  test("and dropped once main lists that download as over", () => {
    store().applySnapshot(snapshot({ rows }))
    store().applyEvent(event({ downloadId: "live", progress: 62 }))

    store().applySnapshot(
      snapshot({
        rows: rows.map((entry) =>
          entry.download_id === "live"
            ? { ...entry, status: "completed", finished_at: 6000 }
            : entry
        )
      })
    )

    expect(rowOf("live")).toMatchObject({ status: "completed", progress: 100 })
    expect(store().overlay.live).toBeUndefined()
  })

  /**
   * the window between the click and main's first push is a window the user is
   * looking at: the hooks draw the row, and it stays until main's list names
   * it - or for ever, if main refused the start, because no list will.
   */
  test("a row this window drew survives a list that does not name it yet", () => {
    store().add(row({ downloadId: "just-clicked", startedAt: 9000 }))

    store().applySnapshot(snapshot({ rows }))

    expect(rowOf("just-clicked")).toMatchObject({ status: "starting" })
    expect(store().rows[0].downloadId).toBe("just-clicked")
  })

  test("...and gives way to main's row the moment one names it", () => {
    store().add(row({ downloadId: "just-clicked", startedAt: 9000 }))

    store().applySnapshot({
      seq: 1,
      lifetimeCompleted: 0,
      rows: [
        {
          download_id: "just-clicked",
          status: "queued",
          kind: "video",
          platform: "youtube",
          title: "My Holiday Video",
          label: "1080p mp4",
          started_at: 9000
        } as DownloadHistoryRow
      ]
    })

    expect(store().rows).toHaveLength(1)
    expect(rowOf("just-clicked")?.status).toBe("queued")
    expect(rowOf("just-clicked")?.local).toBeUndefined()
  })

  /**
   * a push can overtake the reply to the one read a window makes, and both
   * carry main's own count of them.
   */
  test("an older list than the one already applied changes nothing", () => {
    store().applySnapshot(snapshot({ rows, at: 4 }))

    store().applySnapshot(snapshot({ rows: [], at: 3 }))

    expect(store().rows).toHaveLength(3)
    expect(store().lastSeq).toBe(4)
  })

  test("an interrupted playlist with no stored total falls back to its selection", () => {
    store().applySnapshot(
      snapshot({
        rows: [
          {
            download_id: "pl",
            kind: "playlist",
            platform: "youtube",
            status: "interrupted",
            title: "Short talks",
            label: "2 videos",
            started_at: 1000,
            request: {
              url: "https://youtube.com/playlist?list=PL1",
              playlist_id: "PL1",
              entries: [
                { index: 1, id: "a" },
                { index: 2, id: "b" }
              ]
            }
          } as DownloadHistoryRow
        ]
      })
    )

    expect(rowOf("pl")).toMatchObject({ status: "interrupted", itemsTotal: 2 })
  })
})

describe("the duplicate rule", () => {
  const candidate = {
    kind: "video" as const,
    label: "1080p mp4",
    request: {
      url: "https://youtu.be/abc",
      height: 1080,
      container: "mp4" as const
    }
  }

  test("an identical request that is still running is found", () => {
    store().add(row())

    expect(store().findLive(candidate)?.downloadId).toBe("d1")
  })

  test("a queued one counts too", () => {
    store().add(row({ status: "queued" }))

    expect(store().findLive(candidate)).toBeDefined()
  })

  test("a finished one does not", () => {
    store().add(row({ status: "completed" }))

    expect(store().findLive(candidate)).toBeUndefined()
  })

  test("a different quality is a different download", () => {
    store().add(row({ label: "720p mp4" }))

    expect(store().findLive(candidate)).toBeUndefined()
  })

  test("the same quality of a different video is a different download", () => {
    store().add(
      row({
        request: {
          url: "https://youtu.be/xyz",
          height: 1080,
          container: "mp4"
        }
      })
    )

    expect(store().findLive(candidate)).toBeUndefined()
  })

  test("the same video trimmed differently is a different download", () => {
    store().add(
      row({
        request: { ...candidate.request, time_range: { start: 10, end: 30 } }
      })
    )

    expect(store().findLive(candidate)).toBeUndefined()
    expect(
      store().findLive({
        ...candidate,
        request: { ...candidate.request, time_range: { start: 10, end: 30 } }
      })
    ).toBeDefined()
  })

  test("audio of the same video is a different download", () => {
    store().add(row({ kind: "audio", label: "mp3" }))

    expect(store().findLive(candidate)).toBeUndefined()
  })

  /**
   * a playlist's label counts videos and says nothing about what they arrive
   * as, so the request is the only thing that separates the two tabs: the same
   * selection as m4a while it downloads as video writes different files and is
   * a different download.
   */
  test("the same playlist asked for as audio is a different download", () => {
    const playlist = {
      kind: "playlist" as const,
      label: "2 videos",
      request: {
        url: "https://youtube.com/playlist?list=PL1",
        playlist_id: "PL1",
        entries: [{ index: 1, id: "a" }],
        type: "video" as const,
        height: 1080
      }
    }

    store().add(
      row({ kind: "playlist", label: "2 videos", request: playlist.request })
    )

    expect(store().findLive(playlist)?.downloadId).toBe("d1")
    expect(
      store().findLive({
        ...playlist,
        request: {
          ...playlist.request,
          type: "audio",
          height: undefined,
          audio_mode: "m4a"
        }
      })
    ).toBeUndefined()
  })

  /**
   * the label counts videos, so two one-video selections of the same playlist
   * read identically: same url, same count, same height, same range. they are
   * different videos and different files, and the second click has to start.
   */
  test("a different selection of the same playlist is a different download", () => {
    const playlist = (entries: { index: number; id: string }[]) => ({
      kind: "playlist" as const,
      label: "1 video",
      request: {
        url: "https://youtube.com/playlist?list=PL1",
        playlist_id: "PL1",
        entries,
        type: "video" as const,
        height: 1080
      }
    })

    const first = playlist([{ index: 1, id: "a" }])
    store().add(row({ ...first, status: "downloading" }))

    expect(store().findLive(playlist([{ index: 2, id: "b" }]))).toBeUndefined()
    // ...and the same selection still is the same download, whichever order
    // the boxes were ticked in
    expect(store().findLive(first)?.downloadId).toBe("d1")
  })

  test("the order the selection was ticked in is not part of it", () => {
    const entries = [
      { index: 3, id: "c" },
      { index: 1, id: "a" }
    ]
    const request = {
      url: "https://youtube.com/playlist?list=PL1",
      playlist_id: "PL1",
      entries,
      type: "video" as const,
      height: 1080
    }

    store().add(
      row({ kind: "playlist", label: "2 videos", request, status: "queued" })
    )

    expect(
      store().findLive({
        kind: "playlist",
        label: "2 videos",
        request: { ...request, entries: [...entries].reverse() }
      })?.downloadId
    ).toBe("d1")
  })

  /**
   * D3 is about identical requests, and a dub is not the same file as the
   * original track. no label mentions the language, so the request is the only
   * thing that can tell the two apart.
   */
  test("the same video in another language is a different download", () => {
    store().add(
      row({ request: { ...candidate.request, audio_language: "es" } })
    )

    expect(store().findLive(candidate)).toBeUndefined()
    expect(
      store().findLive({
        ...candidate,
        request: { ...candidate.request, audio_language: "es" }
      })?.downloadId
    ).toBe("d1")
  })

  /**
   * nothing to be identical to. refusing to start would be worse than starting
   * twice, and a row with no request is one a retry cannot re-send either
   */
  test("a candidate with no request matches nothing", () => {
    store().add(row())

    expect(
      store().findLive({
        kind: "video",
        label: "1080p mp4",
        request: undefined
      })
    ).toBeUndefined()
  })
})

describe("clearing and removing", () => {
  test("clear finished keeps what is still going, and tells main", () => {
    store().add(row({ downloadId: "running", status: "downloading" }))
    store().add(row({ downloadId: "queued", status: "queued" }))
    store().add(row({ downloadId: "done", status: "completed" }))
    store().add(row({ downloadId: "failed", status: "failed" }))
    store().setHighlighted("done")

    store().clearFinished()

    expect(
      store()
        .rows.map((known) => known.downloadId)
        .sort()
    ).toEqual(["queued", "running"])
    // the highlight was on a row that is gone
    expect(store().highlightedId).toBeNull()
    expect(mocks.clearHistory).toHaveBeenCalledTimes(1)
  })

  /**
   * main answers with the list as it stands afterwards, and that answer is
   * applied like any other push: whatever it does not name is not in the list,
   * and there is nothing here that has to work out which rows it covered.
   */
  test("and the list becomes main's answer", async () => {
    store().add(row({ downloadId: "running", status: "downloading" }))
    mocks.clearHistory.mockResolvedValue(
      snapshot({
        rows: [
          {
            download_id: "running",
            status: "downloading",
            kind: "video",
            title: "My Holiday Video",
            started_at: 1000
          } as DownloadHistoryRow
        ]
      })
    )

    store().clearFinished()
    await flush()

    expect(store().rows.map((known) => known.downloadId)).toEqual(["running"])
  })

  /**
   * the ordering four rounds of renderer-side reconciliation could not settle:
   * a download that finishes between the click and main handling the clear is
   * live for this side and terminal for main, which removes it. Main's answer
   * does not name it, so it goes.
   */
  test("a completion crossing the clear goes with main's answer", async () => {
    store().add(row({ downloadId: "crossing", status: "downloading" }))
    // main has listed it: it is main's row now, not one this window drew
    store().applySnapshot(
      snapshot({
        rows: [
          {
            download_id: "crossing",
            status: "downloading",
            kind: "video",
            title: "My Holiday Video",
            started_at: 1000
          } as DownloadHistoryRow
        ]
      })
    )
    mocks.clearHistory.mockResolvedValue(snapshot({ rows: [] }))

    store().clearFinished()
    store().applyEvent(
      event({
        downloadId: "crossing",
        status: "completed",
        progress: 100,
        lifetimeCompleted: 6
      })
    )
    await flush()

    expect(store().rows).toEqual([])
    // the clear never touches the number; the completion is what moved it
    expect(store().lifetimeCompleted).toBe(6)
  })

  /**
   * a row this window drew for a click main has not answered for is not part of
   * any list main can send, so no answer of main's can take it away.
   */
  test("a row this window drew after the clear survives the answer", async () => {
    store().add(row({ downloadId: "old", status: "completed" }))
    mocks.clearHistory.mockResolvedValue(snapshot({ rows: [] }))

    store().clearFinished()
    store().add(row({ downloadId: "new", status: "downloading" }))
    await flush()

    expect(store().rows.map((known) => known.downloadId)).toEqual(["new"])
  })

  test("removing one row forgets it here and on disk", async () => {
    store().add(row({ downloadId: "done", status: "completed" }))
    store().setHighlighted("done")
    mocks.removeHistory.mockResolvedValue(snapshot({ rows: [] }))

    store().remove("done")
    await flush()

    expect(store().rows).toEqual([])
    expect(store().highlightedId).toBeNull()
    expect(mocks.removeHistory).toHaveBeenCalledWith("done")
  })

  /**
   * an answer from before a clear cannot put back what it removed: it is an
   * older list, and an older list is ignored outright.
   */
  test("a list read before the clear cannot restore what it removed", async () => {
    const older = snapshot({
      rows: [{ download_id: "old", status: "completed" } as DownloadHistoryRow],
      at: 1
    })

    store().applySnapshot(older)
    mocks.clearHistory.mockResolvedValue(snapshot({ rows: [], at: 2 }))

    store().clearFinished()
    await flush()

    // the read that was in flight when the clear went out, arriving late
    store().applySnapshot(older)

    expect(store().rows).toEqual([])
  })

  /**
   * and neither can one that still calls the download active: main builds its
   * list after the change it announces, so the newer list is the true one
   * whatever an older one says about the same download.
   */
  test("even when the older list still calls it active", async () => {
    const older = snapshot({
      rows: [
        {
          download_id: "unseen",
          status: "downloading",
          kind: "video",
          title: "Never had a row here",
          started_at: 1000
        } as DownloadHistoryRow
      ],
      at: 1
    })

    mocks.clearHistory.mockResolvedValue(snapshot({ rows: [], at: 2 }))

    store().clearFinished()
    await flush()
    store().applySnapshot(older)

    expect(store().rows).toEqual([])
  })

  test("a history write that fails costs nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.clearHistory.mockRejectedValue(new Error("disk full"))

    store().add(row({ downloadId: "done", status: "completed" }))
    store().clearFinished()

    await flush()
    expect(store().rows).toEqual([])
  })
})

describe("what a terminal row accepts", () => {
  test("nothing that would make it live again", () => {
    store().add(row({ downloadId: "d1", status: "completed", progress: 100 }))

    store().applyEvent(event({ status: "downloading", progress: 1 }))

    expect(rowOf("d1")).toMatchObject({ status: "completed", progress: 100 })
  })

  test("and not a second ending", () => {
    store().add(
      row({ downloadId: "d1", status: "failed", error: "the first reason" })
    )

    store().applyEvent(event({ status: "completed", progress: 100 }))

    expect(rowOf("d1")).toMatchObject({
      status: "failed",
      error: "the first reason"
    })
  })

  // the count is main's, not the row's: a completion it carries has happened
  // whatever this window has already written down about the row
  test("but the count on it is still taken", () => {
    store().add(row({ downloadId: "d1", status: "completed", progress: 100 }))

    store().applyEvent(
      event({ status: "completed", progress: 100, lifetimeCompleted: 7 })
    )

    expect(store().lifetimeCompleted).toBe(7)
  })

  // the row itself is untouched: an event that can change nothing about it
  // leaves the object it is drawn from exactly as it was
  test("and the row is left as it was", () => {
    store().add(row({ downloadId: "d1", status: "completed", progress: 100 }))
    const before = rowOf("d1")

    store().applyEvent(event({ status: "downloading", progress: 1 }))

    expect(rowOf("d1")).toEqual(before)
  })
})

/**
 * the three orderings the panel v2 review reproduced, each of which used to end
 * the session with the wrong total. `DownloadEvents` applies an event on
 * arrival, hydrates over the rows with main's snapshot, and then replays every
 * event that landed inside that window - so a completion is applied twice, with
 * a snapshot older than it in between.
 */
/**
 * the one number at the top of the panel: downloads finished since install.
 *
 * main owns it outright - it counts the completion, stamps the total onto the
 * completed event and carries it on every snapshot - and this side only ever
 * takes the larger of what it has and what arrives.
 */
describe("the lifetime count", () => {
  test("comes in with the list", () => {
    store().applySnapshot(snapshot({ lifetimeCompleted: 128 }))

    expect(store().lifetimeCompleted).toBe(128)
  })

  test("moves with the number on a completed event", () => {
    store().applySnapshot(snapshot({ lifetimeCompleted: 4 }))
    store().add(row({ downloadId: "d1", status: "downloading" }))

    store().applyEvent(
      event({ status: "completed", progress: 100, lifetimeCompleted: 5 })
    )

    expect(store().lifetimeCompleted).toBe(5)
  })

  test("even for a download this window has no row for", () => {
    store().applySnapshot(snapshot({ lifetimeCompleted: 4 }))

    store().applyEvent(
      event({
        downloadId: "someone-else",
        status: "completed",
        progress: 100,
        lifetimeCompleted: 5
      })
    )

    expect(store().lifetimeCompleted).toBe(5)
  })

  test("an event without one leaves it where it was", () => {
    store().applySnapshot(snapshot({ lifetimeCompleted: 4 }))
    store().add(row({ downloadId: "d1", status: "downloading" }))

    store().applyEvent(event({ status: "downloading", progress: 40 }))

    expect(store().lifetimeCompleted).toBe(4)
  })

  // a list built before the completion was counted cannot walk it back
  test("and an older number never lowers it", () => {
    store().applySnapshot(snapshot({ lifetimeCompleted: 129 }))

    store().applySnapshot(snapshot({ lifetimeCompleted: 128 }))

    expect(store().lifetimeCompleted).toBe(129)
  })

  test("clearing the history leaves it alone", async () => {
    store().applySnapshot(snapshot({ lifetimeCompleted: 12 }))
    store().add(row({ downloadId: "done", status: "completed" }))
    mocks.clearHistory.mockResolvedValue(
      snapshot({ rows: [], lifetimeCompleted: 12 })
    )

    store().clearFinished()
    await flush()

    expect(store().rows).toEqual([])
    expect(store().lifetimeCompleted).toBe(12)
  })
})

/**
 * a finished row reveals the file it made rather than only opening the folder,
 * which it can only do while it still knows where the file went. It arrives on
 * the completion event and again in main's list, and either is enough.
 */
describe("where the file landed", () => {
  test("is kept off the completion event", () => {
    store().add(row({ downloadId: "d1" }))

    store().applyEvent(
      event({
        status: "completed",
        progress: 100,
        file_path: "/Users/me/Downloads/holiday.mp4"
      })
    )

    expect(rowOf("d1")?.filePath).toBe("/Users/me/Downloads/holiday.mp4")
  })

  test("and read back from main's list", () => {
    store().applySnapshot(
      snapshot({
        rows: [
          {
            download_id: "old",
            status: "completed",
            file_path: "/Users/me/Downloads/old.mp4"
          } as DownloadHistoryRow
        ]
      })
    )

    expect(rowOf("old")?.filePath).toBe("/Users/me/Downloads/old.mp4")
  })

  // a row from a history file written before the path was kept: the panel falls
  // back to opening the download folder, which is why this stays undefined
  test("and is absent when the row never had one", () => {
    store().applySnapshot(
      snapshot({
        rows: [
          { download_id: "old", status: "completed" } as DownloadHistoryRow
        ]
      })
    )

    expect(rowOf("old")?.filePath).toBeUndefined()
  })
})

describe("the panel's own state", () => {
  test("open and highlighted are session-only flags", () => {
    store().setPanelOpen(true)
    store().setHighlighted("d1")

    expect(store().panelOpen).toBe(true)
    expect(store().highlightedId).toBe("d1")

    store().reset()

    expect(store().panelOpen).toBe(false)
    expect(store().highlightedId).toBeNull()
  })
})

/**
 * a Stop pressed before main has reserved the id, kept until there is an id to
 * cancel. the panel records it and `DownloadEvents` issues it again; the store
 * only has to hold it, once, and hand it over exactly once.
 */
describe("a cancel main could not take yet", () => {
  test("is held until somebody takes it, and only once", () => {
    store().rememberCancelIntent("d1")
    store().rememberCancelIntent("d1")

    expect(store().cancelIntents).toEqual(["d1"])
    expect(store().takeCancelIntent("d1")).toBe(true)
    expect(store().takeCancelIntent("d1")).toBe(false)
    expect(store().cancelIntents).toEqual([])
  })

  test("belongs to the download it was pressed on", () => {
    store().rememberCancelIntent("d1")

    expect(store().takeCancelIntent("d2")).toBe(false)
    expect(store().cancelIntents).toEqual(["d1"])
  })
})
