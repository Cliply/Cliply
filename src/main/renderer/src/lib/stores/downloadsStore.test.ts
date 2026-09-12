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
 * main owns the counter (`downloads_completed`, written by
 * `noteCompletedDownload` in ipc-handlers.js) and this side keeps it moving, so
 * what matters here is that it is read once, bumped once per download, and
 * never walked backwards by anything else the panel does.
 */
describe("the lifetime count", () => {
  test("comes in with the hydration read", () => {
    store().hydrate([], [], 128)

    expect(store().lifetimeCompleted).toBe(128)
  })

  test("moves with a completion, without a second read", () => {
    store().add(row({ downloadId: "d1", status: "downloading" }))

    store().applyEvent(event({ status: "completed", progress: 100 }))

    expect(store().lifetimeCompleted).toBe(1)
  })

  /**
   * `DownloadEvents` replays every event that landed during the hydration
   * window, so the same completion is applied twice. a row that was already
   * completed is not a download that completed twice.
   */
  test("and not twice for the same download", () => {
    store().add(row({ downloadId: "d1", status: "downloading" }))
    const completed = event({ status: "completed", progress: 100 })

    store().applyEvent(completed)
    store().applyEvent(completed)

    expect(store().lifetimeCompleted).toBe(1)
  })

  test("a failure or a cancel does not count", () => {
    store().add(row({ downloadId: "d1", status: "downloading" }))

    store().applyEvent(event({ status: "failed", error: "no" }))
    store().applyEvent(event({ status: "cancelled" }))

    expect(store().lifetimeCompleted).toBe(0)
  })

  /**
   * a download that finished while the three hydration reads were in flight has
   * already been counted here, and main's answer was taken before its own write
   * landed. the number must not go backwards under the user.
   */
  test("a late read cannot walk it back", () => {
    store().add(row({ downloadId: "d1", status: "downloading" }))
    store().applyEvent(event({ status: "completed", progress: 100 }))

    store().hydrate([], [], 0)

    expect(store().lifetimeCompleted).toBe(1)
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
