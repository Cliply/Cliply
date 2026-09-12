// @vitest-environment jsdom
//
// one row per download, and the row is where the seven statuses become
// something to read and something to press. after the second pass a row is its
// title and one action, so what is worth asserting rather than eyeballing is
// that every status offers the action that belongs to it (a finished row with a
// Stop is a button main cannot answer), and that "open folder" reveals the file
// when the row knows where it went and falls back to the folder when it does
// not.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cancelDownload: vi.fn(),
  removeHistory: vi.fn(),
  clearHistory: vi.fn(),
  openDownloadFolder: vi.fn(),
  showInFolder: vi.fn(),
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
    systemApi: {
      openDownloadFolder: mocks.openDownloadFolder,
      showInFolder: mocks.showInFolder
    },
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
  mocks.showInFolder.mockResolvedValue(true)
  mocks.removeHistory.mockResolvedValue([])
  mocks.downloadVideo.mockResolvedValue({ downloadId: "new" })
})

afterEach(cleanup)

describe("what each status offers", () => {
  test("queued says so, and its stop drops the reservation", () => {
    render(<DownloadRow row={row({ status: "queued" })} />)

    expect(screen.getByText(en["downloads.queued"])).toBeTruthy()
    // parked behind the cap, so there is no bar to draw: nothing has started
    expect(screen.queryByRole("progressbar")).toBeNull()

    fireEvent.click(action(en["progress.stop"]))

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

  /**
   * a finished row is its name and one button, which is what the second pass
   * was for: no chip, no size, no "Done" beside them.
   */
  test("completed is a name and one action", async () => {
    render(
      <DownloadRow
        row={row({
          status: "completed",
          progress: 100,
          fileSize: 39845888,
          filePath: "/Users/me/Downloads/sourdough.mp4"
        })}
      />
    )

    expect(screen.queryByText(/38 MB/)).toBeNull()
    expect(screen.getAllByRole("button").length).toBe(1)

    fireEvent.click(action(en["toast.openFolder"]))

    // the file itself, in the folder it landed in
    await waitFor(() =>
      expect(mocks.showInFolder).toHaveBeenCalledWith(
        "/Users/me/Downloads/sourdough.mp4"
      )
    )
    expect(mocks.openDownloadFolder).not.toHaveBeenCalled()
  })

  test("and opens the folder when the row kept no path", async () => {
    // a history file an older version wrote knows the download but not where
    // it went
    render(<DownloadRow row={row({ status: "completed", progress: 100 })} />)

    fireEvent.click(action(en["toast.openFolder"]))

    await waitFor(() => expect(mocks.openDownloadFolder).toHaveBeenCalled())
    expect(mocks.showInFolder).not.toHaveBeenCalled()
  })

  // main refuses a path outside the download folder, and a file that has been
  // moved or deleted cannot be revealed either. both end at the folder
  test("and falls back to the folder when the file cannot be revealed", async () => {
    mocks.showInFolder.mockResolvedValue(false)

    render(
      <DownloadRow
        row={row({
          status: "completed",
          progress: 100,
          filePath: "/somewhere/else/gone.mp4"
        })}
      />
    )

    fireEvent.click(action(en["toast.openFolder"]))

    await waitFor(() => expect(mocks.openDownloadFolder).toHaveBeenCalled())
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

  /**
   * one action per row, whatever the status: the Remove that used to sit beside
   * it is gone, and a row is forgotten by "clear history" rather than one at a
   * time.
   */
  test.each([
    ["queued" as const],
    ["starting" as const],
    ["downloading" as const],
    ["completed" as const],
    ["failed" as const],
    ["cancelled" as const],
    ["interrupted" as const]
  ])("%s draws exactly one button", (status) => {
    render(<DownloadRow row={row({ status })} />)

    expect(screen.getAllByRole("button").length).toBe(1)
  })
})

/**
 * main reserves an id only after it has prepared the download folder, and the
 * row is on screen with a Stop on it from the click - so a Stop pressed in that
 * window is answered `false` against an id main has never heard of. dropping
 * that answer loses the user's Stop and the download runs on.
 */
describe("a Stop main answered false", () => {
  test("is remembered while the row is still live", async () => {
    mocks.cancelDownload.mockResolvedValue(false)
    const starting = row({ status: "starting", progress: 0 })
    store().add(starting)

    render(<DownloadRow row={starting} />)
    fireEvent.click(action(en["progress.stop"]))

    await waitFor(() => expect(store().cancelIntents).toEqual(["d1"]))
  })

  test("is forgotten when the download had already finished", async () => {
    // the other meaning of `false`: main had nothing to cancel because the
    // download completed while the click was in flight. asking again would be
    // asking main to stop a file that is on disk
    mocks.cancelDownload.mockResolvedValue(false)
    const live = row()
    store().add(live)

    render(<DownloadRow row={live} />)
    fireEvent.click(action(en["progress.stop"]))

    store().applyEvent({ downloadId: "d1", status: "completed", progress: 100 })

    await waitFor(() => expect(mocks.cancelDownload).toHaveBeenCalled())
    expect(store().cancelIntents).toEqual([])
  })

  test("is not remembered at all when the cancel took", async () => {
    const starting = row({ status: "starting", progress: 0 })
    store().add(starting)

    render(<DownloadRow row={starting} />)
    fireEvent.click(action(en["progress.stop"]))

    await waitFor(() => expect(mocks.cancelDownload).toHaveBeenCalled())
    expect(store().cancelIntents).toEqual([])
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
   * from the moment the row is live, not from the first video that lands
   *
   * the bar, the speed and the eta describe the file being fetched right now;
   * how far through the playlist the run is is the one thing they cannot say,
   * and a counter that only appears once something has completed leaves the
   * first video of a long list looking like the whole download.
   */
  test.each([["starting" as const], ["downloading" as const]])(
    "%s already counts, from zero",
    (status) => {
      render(<DownloadRow row={playlist({ status, progress: 0 })} />)

      expect(screen.getByText("0 of 12")).toBeTruthy()
    }
  )

  /**
   * the size on a playlist's completed event describes the last file that
   * landed rather than the run (noted on Q2), so a finished playlist says
   * nothing about bytes. after the second pass it says nothing at all beyond
   * its name: the run is over and the folder is the one thing left to offer.
   */
  test("says nothing about bytes once it is done", () => {
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

    expect(screen.queryByText(/3\.81 MB/)).toBeNull()
    expect(screen.getByText("Lo-fi beats to study to")).toBeTruthy()
    expect(action(en["toast.openFolder"])).toBeTruthy()
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
