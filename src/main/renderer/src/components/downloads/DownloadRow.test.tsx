// @vitest-environment jsdom
//
// one row per download, and the row is where the seven statuses become
// something to read and something to press. two things in particular are worth
// asserting rather than eyeballing: that every status offers the action that
// belongs to it (a finished row with a Stop is a button main cannot answer),
// and that the chip and the finished line are built from the request rather
// than from main's english label.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cancelDownload: vi.fn(),
  removeHistory: vi.fn(),
  clearHistory: vi.fn(),
  openDownloadFolder: vi.fn(),
  downloadVideo: vi.fn(),
  downloadAudio: vi.fn(),
  downloadPlaylist: vi.fn(),
  showDownloadErrorToast: vi.fn()
}))

vi.mock("@/lib/api", () => {
  class DownloadError extends Error {
    details?: string
    category?: string
  }

  return {
    DownloadError,
    downloadApi: {
      cancelDownload: mocks.cancelDownload,
      removeHistory: mocks.removeHistory,
      clearHistory: mocks.clearHistory
    },
    systemApi: { openDownloadFolder: mocks.openDownloadFolder },
    videoApi: {
      downloadVideo: mocks.downloadVideo,
      downloadAudio: mocks.downloadAudio
    },
    playlistApi: { download: mocks.downloadPlaylist },
    tiktokApi: { download: vi.fn() },
    pinterestApi: { download: vi.fn() }
  }
})

vi.mock("@/lib/toast-utils", () => ({
  showDownloadErrorToast: mocks.showDownloadErrorToast
}))

import { en } from "@/lib/i18n/en"
import {
  useDownloadsStore,
  type DownloadRow as Row
} from "@/lib/stores/downloadsStore"

import { DownloadRow } from "./DownloadRow"

const store = () => useDownloadsStore.getState()

const row = (overrides: Partial<Row> = {}): Row => ({
  downloadId: "d1",
  kind: "video",
  platform: "youtube",
  title: "How to bake sourdough at home",
  label: "1080p mp4",
  status: "downloading",
  progress: 62,
  startedAt: 1000,
  request: { url: "https://youtu.be/abc", height: 1080, container: "mp4" },
  ...overrides
})

const action = (label: string) => screen.getByRole("button", { name: label })

beforeEach(() => {
  store().reset()
  vi.clearAllMocks()
  mocks.cancelDownload.mockResolvedValue(true)
  mocks.openDownloadFolder.mockResolvedValue(true)
  mocks.removeHistory.mockResolvedValue([])
  mocks.downloadVideo.mockResolvedValue({ downloadId: "new" })
})

afterEach(cleanup)

describe("what each status offers", () => {
  test("queued says so, and offers to drop it", () => {
    render(<DownloadRow row={row({ status: "queued" })} />)

    expect(screen.getByText(en["downloads.queued"])).toBeTruthy()
    // parked behind the cap, so there is no bar to draw: nothing has started
    expect(screen.queryByRole("progressbar")).toBeNull()

    fireEvent.click(action(en["downloads.remove"]))

    // dropping a reservation is the same cancel as stopping a process
    expect(mocks.cancelDownload).toHaveBeenCalledWith("d1")
  })

  test("downloading draws the bar, the percentage and a stop", () => {
    render(<DownloadRow row={row({ speed: "4.2 MB/s", eta: "0:41" })} />)

    const bar = screen.getByRole("progressbar")

    expect(bar.getAttribute("aria-valuenow")).toBe("62")
    expect(screen.getByText("62%")).toBeTruthy()
    expect(screen.getByText(/4\.2 MB\/s/)).toBeTruthy()
    expect(screen.getByText(/ETA 0:41/)).toBeTruthy()

    fireEvent.click(action(en["progress.stop"]))

    expect(mocks.cancelDownload).toHaveBeenCalledWith("d1")
  })

  test("starting has a bar with no position yet", () => {
    render(<DownloadRow row={row({ status: "starting", progress: 0 })} />)

    const bar = screen.getByRole("progressbar")

    expect(bar.getAttribute("aria-valuenow")).toBeNull()
    expect(screen.getByText(en["progress.startingUp"])).toBeTruthy()
  })

  test("completed says how big the file was, and opens the folder", () => {
    render(
      <DownloadRow
        row={row({ status: "completed", progress: 100, fileSize: 39845888 })}
      />
    )

    expect(screen.getByText(/Done · 38 MB/)).toBeTruthy()

    fireEvent.click(action(en["toast.openFolder"]))

    expect(mocks.openDownloadFolder).toHaveBeenCalled()
  })

  test("completed with no size known still says it is done", () => {
    render(<DownloadRow row={row({ status: "completed", progress: 100 })} />)

    expect(screen.getByText(en["downloads.done"])).toBeTruthy()
  })

  test("failed reads main's sentence and offers to try again", () => {
    render(
      <DownloadRow
        row={row({
          status: "failed",
          error: "YouTube asked us to confirm you're not a bot.",
          category: "BOT_DETECTION"
        })}
      />
    )

    expect(
      screen.getByText("YouTube asked us to confirm you're not a bot.")
    ).toBeTruthy()

    fireEvent.click(action(en["downloads.retry"]))

    expect(mocks.downloadVideo).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://youtu.be/abc", height: 1080 })
    )
  })

  test("a failure that arrived with no sentence still says something", () => {
    render(<DownloadRow row={row({ status: "failed" })} />)

    expect(screen.getByText(en["download.wentWrong"])).toBeTruthy()
  })

  test.each([
    ["cancelled" as const, en["downloads.cancelled"]],
    ["interrupted" as const, en["downloads.interrupted"]]
  ])("%s says so and offers to try again", (status, expected) => {
    render(<DownloadRow row={row({ status })} />)

    expect(screen.getByText(expected)).toBeTruthy()
    expect(action(en["downloads.retry"]).hasAttribute("disabled")).toBe(false)
  })

  /**
   * a history file an older version wrote kept no request, so there is nothing
   * to re-send. the button stays where it is and says why rather than
   * disappearing, which would leave the row looking like it had no outcome.
   */
  test("a row with no request cannot be retried", () => {
    render(<DownloadRow row={row({ status: "failed", request: undefined })} />)

    const retry = action(en["downloads.retry"])

    expect(retry.hasAttribute("disabled")).toBe(true)
    expect(retry.getAttribute("title")).toBe(en["downloads.retryUnavailable"])
  })

  test.each([
    ["queued" as const],
    ["starting" as const],
    ["downloading" as const]
  ])("%s has nothing to forget yet", (status) => {
    render(<DownloadRow row={row({ status })} />)

    // removing a live row would leave main downloading something the panel no
    // longer shows, and main refuses to forget one anyway
    expect(
      screen.queryAllByRole("button", { name: en["downloads.remove"] }).length
    ).toBe(status === "queued" ? 1 : 0)
  })

  test("a finished row is forgotten here and on disk", () => {
    store().add(row({ status: "completed" }))

    render(<DownloadRow row={row({ status: "completed" })} />)

    fireEvent.click(action(en["downloads.remove"]))

    expect(store().rows).toEqual([])
    expect(mocks.removeHistory).toHaveBeenCalledWith("d1")
  })
})

describe("a playlist row", () => {
  const playlist = (overrides: Partial<Row> = {}): Row =>
    row({
      kind: "playlist",
      label: "12 videos",
      title: "Lo-fi beats to study to",
      itemsTotal: 12,
      request: {
        url: "https://youtube.com/playlist?list=PL1",
        playlist_id: "PL1",
        entries: [{ index: 1, id: "a" }],
        type: "video",
        height: 1080
      },
      ...overrides
    })

  test("counts where it is inside its own run", () => {
    render(<DownloadRow row={playlist({ itemsCompleted: 3 })} />)

    expect(screen.getByText("3 of 12")).toBeTruthy()
  })

  /**
   * the size on a playlist's completed event describes the last file that
   * landed rather than the run (noted on Q2), so a finished playlist counts
   * videos: eight of nine saved is a success, and saying "Done · 4 MB" over it
   * would be describing one video out of eight.
   */
  test("says what it saved rather than how big the last file was", () => {
    render(
      <DownloadRow
        row={playlist({
          status: "completed",
          progress: 100,
          itemsSaved: 8,
          itemsTotal: 9,
          fileSize: 4_000_000
        })}
      />
    )

    expect(screen.getByText("8 of 9 videos saved")).toBeTruthy()
    expect(screen.queryByText(/3\.81 MB/)).toBeNull()
  })

  test("falls back to done when the run counted nothing", () => {
    render(
      <DownloadRow
        row={playlist({
          status: "completed",
          progress: 100,
          itemsTotal: undefined
        })}
      />
    )

    expect(screen.getByText(en["downloads.done"])).toBeTruthy()
  })
})

/**
 * main writes a label at reserve and it is english by design, so the chip is
 * rebuilt here from the request main built that label from. the fallback is
 * main's own, which is all a row read from an older history file has.
 */
describe("the chip beside the title", () => {
  test.each([
    [row(), "1080p mp4"],
    [
      row({
        kind: "audio",
        label: "mp3",
        request: { url: "https://youtu.be/abc", audio_mode: "mp3" }
      }),
      en["format.mp3"]
    ],
    [
      row({
        kind: "audio",
        label: "original",
        request: { url: "https://youtu.be/abc", audio_mode: "original" }
      }),
      en["dropdown.original"]
    ],
    [
      row({
        kind: "simple",
        platform: "tiktok",
        label: "tiktok",
        request: { url: "https://tiktok.com/@a/video/1" }
      }),
      "TikTok"
    ],
    [
      row({
        kind: "simple",
        platform: "pinterest",
        label: "pinterest",
        request: { url: "https://pin.it/abc" }
      }),
      "Pinterest"
    ],
    [
      row({
        kind: "playlist",
        label: "12 videos",
        itemsTotal: 12,
        request: {
          url: "https://youtube.com/playlist?list=PL1",
          playlist_id: "PL1",
          entries: []
        }
      }),
      "12 videos"
    ]
  ])("reads $1 for the request it was started from", (given, expected) => {
    render(<DownloadRow row={given} />)

    expect(screen.getByText(expected)).toBeTruthy()
  })

  test("keeps main's label when the request is gone", () => {
    render(<DownloadRow row={row({ request: undefined })} />)

    expect(screen.getByText("1080p mp4")).toBeTruthy()
  })

  test("and when the request kept no height", () => {
    render(
      <DownloadRow
        row={row({
          label: "720p mkv",
          request: { url: "https://youtu.be/abc" } as never
        })}
      />
    )

    expect(screen.getByText("720p mkv")).toBeTruthy()
  })
})

describe("the title", () => {
  test("names a download main never learned a title for", () => {
    render(<DownloadRow row={row({ title: "", status: "completed" })} />)

    expect(screen.getByText(en["downloads.untitled"])).toBeTruthy()
  })

  // the bar names itself with the title so its aria-labelledby points at
  // something, which is why a running row says it twice - once hidden
  test("names the bar of a running download after it too", () => {
    render(<DownloadRow row={row({ title: "" })} />)

    expect(screen.getAllByText(en["downloads.untitled"]).length).toBe(2)
  })
})

describe("the highlight", () => {
  test("rings the row a duplicate click was sent to", () => {
    const { container } = render(<DownloadRow row={row()} highlighted />)

    expect(container.firstElementChild?.className).toContain("ring-2")
  })

  test("and leaves every other row alone", () => {
    const { container } = render(<DownloadRow row={row()} />)

    expect(container.firstElementChild?.className).not.toContain("ring-2")
  })
})
