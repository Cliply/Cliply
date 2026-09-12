// @vitest-environment jsdom
//
// the one list every download ends up in. what it has to get right is which
// events it accepts, what a reload rebuilds, and when two clicks are the same
// download - the last of which is the difference between one process and two
// writing the same .part file.

import { beforeEach, describe, expect, test, vi } from "vitest"

import type {
  DownloadHistoryRow,
  DownloadProgress,
  DownloadStatus
} from "@/lib/api"

const mocks = vi.hoisted(() => ({
  clearHistory: vi.fn(),
  removeHistory: vi.fn()
}))

vi.mock("@/lib/api", () => ({
  downloadApi: {
    clearHistory: () => mocks.clearHistory(),
    removeHistory: (downloadId: string) => mocks.removeHistory(downloadId)
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

/** let a reply from main, and the reconciliation behind it, land */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const rowOf = (downloadId: string) =>
  store().rows.find((known) => known.downloadId === downloadId)

beforeEach(() => {
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
    expect(rowOf("d1")?.finishedAt).toEqual(expect.any(Number))
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

describe("hydrating after a reload", () => {
  const active: DownloadStatus[] = [
    {
      downloadId: "live",
      status: "downloading",
      progress: 30,
      type: "combined",
      title: "Still going",
      platform: "youtube",
      label: "1080p mp4",
      startTime: 5000,
      request: {
        url: "https://youtu.be/live",
        height: 1080,
        container: "mp4"
      }
    }
  ]

  const history: DownloadHistoryRow[] = [
    {
      download_id: "live",
      status: "downloading",
      kind: "video",
      title: "Still going",
      started_at: 5000
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

  test("a row in both lists appears once, as main has it now", () => {
    useDownloadsStore.getState().hydrate(active, history)

    expect(store().rows).toHaveLength(3)
    expect(store().hydrated).toBe(true)
    expect(rowOf("live")).toMatchObject({
      status: "downloading",
      progress: 30,
      label: "1080p mp4"
    })
  })

  test("rows come back newest first, with their platform and their file", () => {
    store().hydrate(active, history)

    expect(store().rows.map((known) => known.downloadId)).toEqual([
      "live",
      "stopped",
      "done"
    ])
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
   * the window between subscribing and the two reads landing is a window a
   * click can fall into, and main has not heard of that download yet
   */
  test("a row added while the read was in flight survives it", () => {
    store().add(row({ downloadId: "just-clicked", startedAt: 9000 }))
    store().hydrate(active, history)

    expect(rowOf("just-clicked")).toMatchObject({ status: "starting" })
    expect(store().rows[0].downloadId).toBe("just-clicked")
  })

  test("a queued playlist counts the videos its request asked for", () => {
    store().hydrate(
      [
        {
          downloadId: "pl",
          status: "queued",
          progress: 0,
          type: "combined",
          playlist: true,
          platform: "youtube",
          title: "Short talks",
          label: "3 videos",
          request: {
            url: "https://youtube.com/playlist?list=PL1",
            playlist_id: "PL1",
            entries: [
              { index: 1, id: "a" },
              { index: 2, id: "b" },
              { index: 3, id: "c" }
            ]
          }
        }
      ],
      []
    )

    expect(rowOf("pl")).toMatchObject({ kind: "playlist", itemsTotal: 3 })
  })

  /**
   * main has written the total at reserve since the history was added, so this
   * is a row from a file an older version wrote - and the selection it stored
   * is the same number. it matters on the way out rather than on the way in: a
   * Retry copies this row, and one with no total counts from nothing until the
   * first event of the new run arrives.
   */
  test("an interrupted playlist with no stored total falls back to its selection", () => {
    store().hydrate(
      [],
      [
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

  test("removing one row forgets it here and on disk", () => {
    store().add(row({ downloadId: "done", status: "completed" }))
    store().setHighlighted("done")

    store().remove("done")

    expect(store().rows).toEqual([])
    expect(store().highlightedId).toBeNull()
    expect(mocks.removeHistory).toHaveBeenCalledWith("done")
  })

  /**
   * the clear and main's clear do not always mean the same rows: a download
   * that finishes between the click and main handling the request is live on
   * this side and terminal on that one, so main drops it and this keeps it -
   * and the row sat in the panel until the next launch lost it.
   */
  test("a completion crossing the clear goes with main's answer", async () => {
    store().hydrate([], [], 5)
    store().add(row({ downloadId: "crossing", status: "downloading" }))
    // main saw the completion first, so its answer holds nothing at all
    mocks.clearHistory.mockResolvedValue([])

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

  test("a row that arrived after the clear was sent survives it", async () => {
    store().add(row({ downloadId: "old", status: "completed" }))
    mocks.clearHistory.mockResolvedValue([])

    store().clearFinished()
    // main had not heard of this one when it built that answer
    store().add(row({ downloadId: "new", status: "downloading" }))
    await flush()

    expect(store().rows.map((known) => known.downloadId)).toEqual(["new"])
  })

  test("and a row main still has is kept", async () => {
    store().add(row({ downloadId: "live", status: "downloading" }))
    mocks.clearHistory.mockResolvedValue([
      { download_id: "live", status: "downloading" } as DownloadHistoryRow
    ])

    store().clearFinished()
    await flush()

    expect(store().rows.map((known) => known.downloadId)).toEqual(["live"])
  })

  /**
   * a snapshot asked for before the clear still names what the clear removed,
   * and landing it afterwards put every one of those rows back.
   */
  test("a snapshot read before the clear cannot restore what it removed", async () => {
    store().add(row({ downloadId: "old", status: "completed" }))
    mocks.clearHistory.mockResolvedValue([])

    store().clearFinished()
    await flush()

    store().hydrate(
      [],
      [{ download_id: "old", status: "completed" } as DownloadHistoryRow],
      0
    )

    expect(store().rows).toEqual([])
  })

  test("and neither can a re-read that was in flight", async () => {
    store().add(row({ downloadId: "old", status: "completed" }))
    mocks.clearHistory.mockResolvedValue([])

    store().clearFinished()
    await flush()

    store().adopt(
      [],
      [{ download_id: "old", status: "completed" } as DownloadHistoryRow]
    )

    expect(store().rows).toEqual([])
  })

  /**
   * the case the tombstones exist for: the snapshot was taken while the
   * download was still running, so it comes back in the *active* half. Keeping
   * it because "a clear never removes a live row" put a finished, counted,
   * cleared download back on screen with a Stop on it and no event left to
   * settle it.
   */
  test("even when the stale snapshot still calls it active", async () => {
    store().add(row({ downloadId: "done", status: "downloading" }))
    mocks.clearHistory.mockResolvedValue([])

    store().applyEvent(
      event({ downloadId: "done", status: "completed", progress: 100 })
    )
    store().clearFinished()
    await flush()

    store().adopt(
      [
        {
          downloadId: "done",
          status: "downloading",
          progress: 40,
          type: "combined",
          platform: "youtube",
          title: "My Holiday Video",
          label: "1080p mp4"
        } as DownloadStatus
      ],
      []
    )

    expect(store().rows).toEqual([])
  })

  // ...and the same for one row forgotten on its own
  test("a removed row is not brought back by a reply that still names it", async () => {
    store().add(row({ downloadId: "done", status: "completed" }))

    store().remove("done")
    store().adopt(
      [],
      [{ download_id: "done", status: "completed" } as DownloadHistoryRow]
    )

    expect(store().rows).toEqual([])
  })

  /**
   * ...and everything else in that reply is still true. The count is a number
   * no clear touches, a download the user did not clear is still theirs, and
   * the flag has to be set either way: throwing the whole answer away left the
   * session with no count, no live rows and a panel that could never say it was
   * empty.
   */
  test("a late hydration still brings its count, its live rows and the flag", async () => {
    store().add(row({ downloadId: "old", status: "completed" }))
    mocks.clearHistory.mockResolvedValue([])

    store().clearFinished()
    await flush()

    store().hydrate(
      [
        {
          downloadId: "running",
          status: "downloading",
          progress: 40,
          type: "combined",
          platform: "youtube",
          title: "Still going",
          label: "1080p mp4"
        } as DownloadStatus
      ],
      [{ download_id: "old", status: "completed" } as DownloadHistoryRow],
      128
    )

    expect(store().rows.map((known) => known.downloadId)).toEqual(["running"])
    expect(store().lifetimeCompleted).toBe(128)
    expect(store().hydrated).toBe(true)
  })

  test("and a late re-read still brings the live row it was asked for", async () => {
    store().add(row({ downloadId: "old", status: "completed" }))
    mocks.clearHistory.mockResolvedValue([])

    store().clearFinished()
    await flush()

    store().adopt(
      [
        {
          downloadId: "late",
          status: "downloading",
          progress: 1,
          type: "combined",
          platform: "youtube",
          title: "Admitted while we were clearing",
          label: "1080p mp4"
        } as DownloadStatus
      ],
      [{ download_id: "old", status: "completed" } as DownloadHistoryRow]
    )

    expect(store().rows.map((known) => known.downloadId)).toEqual(["late"])
  })

  /**
   * the rows the tombstones cannot name: a finished download this window never
   * held, which exists only inside a history reply that was already in flight
   * when the user cleared. Main cleared it at the same moment as the rest, so
   * the only thing that can tell it apart from a download that has since
   * finished is when it ended.
   */
  test("a reply's finished rows are covered by the clear too", async () => {
    const before = Date.now() - 60_000
    mocks.clearHistory.mockResolvedValue([])

    store().add(row({ downloadId: "held", status: "completed" }))
    store().clearFinished()
    await flush()

    store().hydrate(
      [],
      [
        {
          download_id: "never-seen",
          status: "completed",
          finished_at: before
        } as DownloadHistoryRow
      ],
      0
    )

    expect(store().rows).toEqual([])
  })

  test("and one that finished after the clear still lands", async () => {
    mocks.clearHistory.mockResolvedValue([])

    store().add(row({ downloadId: "held", status: "completed" }))
    store().clearFinished()
    await flush()

    store().adopt(
      [],
      [
        {
          download_id: "after",
          status: "completed",
          started_at: 10,
          finished_at: Date.now() + 60_000
        } as DownloadHistoryRow
      ]
    )

    expect(store().rows.map((known) => known.downloadId)).toEqual(["after"])
  })

  // a row with no finish time comes from a history file written before main
  // recorded one, which is to say from a run that is long over
  test("and one with no finish time at all is treated as older", async () => {
    mocks.clearHistory.mockResolvedValue([])

    store().add(row({ downloadId: "held", status: "completed" }))
    store().clearFinished()
    await flush()

    store().adopt(
      [],
      [{ download_id: "ancient", status: "completed" } as DownloadHistoryRow]
    )

    expect(store().rows).toEqual([])
  })

  // nothing has been cleared, so nothing in a reply is old news
  test("and an install that has never cleared keeps everything", () => {
    store().hydrate(
      [],
      [
        {
          download_id: "old",
          status: "completed",
          finished_at: 1
        } as DownloadHistoryRow
      ],
      0
    )

    expect(store().rows.map((known) => known.downloadId)).toEqual(["old"])
  })

  test("a history write that fails costs nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.clearHistory.mockRejectedValue(new Error("disk full"))

    store().add(row({ downloadId: "done", status: "completed" }))
    store().clearFinished()

    await Promise.resolve()
    expect(store().rows).toEqual([])
  })
})

/**
 * the one number at the top of the panel: downloads finished since install.
 *
 * main owns it outright: it counts the completion, stamps the new total onto
 * the completed event and answers the hydration read from the same number. This
 * side only ever adopts what arrives, which is what makes the replays below
 * harmless - the first pass counted here, and every ordering hydration can
 * produce was either one too many or one too few.
 */
describe("the lifetime count", () => {
  test("comes in with the hydration read", () => {
    store().hydrate([], [], 128)

    expect(store().lifetimeCompleted).toBe(128)
  })

  test("moves with the number on a completed event", () => {
    store().hydrate([], [], 4)
    store().add(row({ downloadId: "d1", status: "downloading" }))

    store().applyEvent(
      event({ status: "completed", progress: 100, lifetimeCompleted: 5 })
    )

    expect(store().lifetimeCompleted).toBe(5)
  })

  test("an event without one leaves it where it was", () => {
    store().hydrate([], [], 4)
    store().add(row({ downloadId: "d1", status: "downloading" }))

    store().applyEvent(event({ status: "downloading", progress: 40 }))

    expect(store().lifetimeCompleted).toBe(4)
  })

  test("a failure or a cancel carries none, so it does not count", () => {
    store().hydrate([], [], 4)
    store().add(row({ downloadId: "d1", status: "downloading" }))

    store().applyEvent(event({ status: "failed", error: "no" }))
    store().applyEvent(event({ status: "cancelled" }))

    expect(store().lifetimeCompleted).toBe(4)
  })

  test("clearing the history leaves it alone", () => {
    store().hydrate([], [], 12)
    store().add(row({ downloadId: "done", status: "completed" }))

    store().clearFinished()

    expect(store().rows).toEqual([])
    expect(store().lifetimeCompleted).toBe(12)
  })
})

/**
 * a row that has finished is finished
 *
 * events are replayed - over the hydration snapshot, and over a row a re-read
 * has just brought in - and what they are replayed onto is sometimes newer than
 * they are. A `downloading` landing on a completed row puts a Stop back on a
 * file that is already on disk.
 */
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

  test("and the list is left alone rather than rebuilt", () => {
    store().add(row({ downloadId: "d1", status: "completed", progress: 100 }))
    const before = store().rows

    store().applyEvent(event({ status: "downloading", progress: 1 }))

    expect(store().rows).toBe(before)
  })
})

/**
 * the three orderings the panel v2 review reproduced, each of which used to end
 * the session with the wrong total. `DownloadEvents` applies an event on
 * arrival, hydrates over the rows with main's snapshot, and then replays every
 * event that landed inside that window - so a completion is applied twice, with
 * a snapshot older than it in between.
 */
describe("the lifetime count across the hydration window", () => {
  const completion = (lifetimeCompleted: number) =>
    event({ status: "completed", progress: 100, lifetimeCompleted })

  test("a completion, an older snapshot of its row, and the replay", () => {
    store().add(row({ downloadId: "d1", status: "downloading" }))

    store().applyEvent(completion(1))
    // main's snapshot was taken before the completion: the row goes back to
    // running, which is exactly what used to let the replay count it again
    store().hydrate(
      [
        {
          downloadId: "d1",
          status: "downloading",
          progress: 40
        } as DownloadStatus
      ],
      [],
      0
    )
    store().applyEvent(completion(1))

    expect(store().lifetimeCompleted).toBe(1)
  })

  test("a reload whose read already includes the completion", () => {
    store().hydrate(
      [
        {
          downloadId: "d1",
          status: "downloading",
          progress: 40
        } as DownloadStatus
      ],
      [],
      1
    )
    store().applyEvent(completion(1))

    expect(store().lifetimeCompleted).toBe(1)
  })

  /**
   * the one a counted-id set could not have fixed: the download belongs to no
   * snapshot at all, so nothing on this side can tell whether the number it
   * read already includes it. The event says so itself.
   */
  test("a download neither snapshot knows, finishing during the reads", () => {
    store().applyEvent(completion(129))
    store().hydrate([], [], 128)

    expect(store().lifetimeCompleted).toBe(129)
  })

  test("and the same, when the event arrives after the read", () => {
    store().hydrate([], [], 128)
    store().applyEvent(completion(129))

    expect(store().lifetimeCompleted).toBe(129)
  })
})

/**
 * a finished row reveals the file it made rather than only opening the folder,
 * which it can only do while it still knows where the file went. main sends the
 * path on the completion and writes it into the history, so both paths in are
 * pinned here.
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

  test("and read back from the history", () => {
    store().hydrate(
      [],
      [
        {
          download_id: "old",
          status: "completed",
          file_path: "/Users/me/Downloads/old.mp4"
        } as DownloadHistoryRow
      ]
    )

    expect(rowOf("old")?.filePath).toBe("/Users/me/Downloads/old.mp4")
  })

  // a row from a history file written before the path was kept: the panel falls
  // back to opening the download folder, which is why this stays undefined
  // rather than becoming an empty string
  test("and is absent when the row never had one", () => {
    store().hydrate(
      [],
      [{ download_id: "old", status: "completed" } as DownloadHistoryRow]
    )

    expect(rowOf("old")?.filePath).toBeUndefined()
  })
})

/**
 * the answer to a download main admitted after this window read its list: ask
 * again, and take only what is missing. `hydrate`'s "main wins" rule is right
 * at startup, when the store has nothing better, and wrong afterwards, when
 * every row it holds has been kept current by the events since.
 */
describe("adopting rows main has and this list does not", () => {
  test("adds an active row the store never heard of", () => {
    store().adopt(
      [
        {
          downloadId: "late",
          status: "downloading",
          progress: 12,
          type: "combined",
          platform: "youtube",
          title: "Admitted after the read",
          label: "1080p mp4"
        } as DownloadStatus
      ],
      []
    )

    expect(rowOf("late")).toMatchObject({
      title: "Admitted after the read",
      status: "downloading"
    })
  })

  test("and a finished one out of the history", () => {
    store().adopt(
      [],
      [
        {
          download_id: "late",
          status: "completed",
          title: "Landed while we were away"
        } as DownloadHistoryRow
      ]
    )

    expect(rowOf("late")?.status).toBe("completed")
  })

  test("leaves every row it already has exactly as it is", () => {
    store().add(row({ downloadId: "d1", status: "completed", progress: 100 }))

    store().adopt(
      [
        {
          downloadId: "d1",
          status: "downloading",
          progress: 5,
          type: "combined",
          platform: "youtube",
          title: "An older title",
          label: "1080p mp4"
        } as DownloadStatus
      ],
      []
    )

    expect(rowOf("d1")).toMatchObject({
      status: "completed",
      progress: 100,
      title: "My Holiday Video"
    })
  })

  test("and says nothing when there is nothing to add", () => {
    store().add(row({ downloadId: "d1" }))
    const before = store().rows

    store().adopt([], [])

    // the same array, so nothing that reads the list re-renders for an answer
    // that told it nothing
    expect(store().rows).toBe(before)
  })

  test("the newest download is still first", () => {
    store().add(row({ downloadId: "older", startedAt: 1 }))

    store().adopt(
      [],
      [
        {
          download_id: "newer",
          status: "completed",
          started_at: 9
        } as DownloadHistoryRow
      ]
    )

    expect(store().rows.map((known) => known.downloadId)).toEqual([
      "newer",
      "older"
    ])
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
