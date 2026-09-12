// @vitest-environment jsdom
//
// the panel is the one place a download can be seen once the screen that
// started it is gone, so it is mounted above the routes and reads everything
// from the store. what it owes: the list in the order the store keeps it, a
// "clear finished" that only offers itself when there is something to clear,
// an empty state that waits for the one read that could fill it, and a way out
// that is not a click on a scrim, because there is no scrim.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cancelDownload: vi.fn(),
  removeHistory: vi.fn(),
  clearHistory: vi.fn(),
  openDownloadFolder: vi.fn()
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
    videoApi: { downloadVideo: vi.fn(), downloadAudio: vi.fn() },
    playlistApi: { download: vi.fn() },
    tiktokApi: { download: vi.fn() },
    pinterestApi: { download: vi.fn() }
  }
})

vi.mock("@/lib/toast-utils", () => ({ showDownloadErrorToast: vi.fn() }))

import { en } from "@/lib/i18n/en"
import {
  useDownloadsStore,
  type DownloadRow
} from "@/lib/stores/downloadsStore"

import { DownloadsPanel } from "./DownloadsPanel"

const store = () => useDownloadsStore.getState()

const row = (overrides: Partial<DownloadRow> = {}): DownloadRow => ({
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

const panel = () => screen.getByRole("complementary")

const open = () => act(() => store().setPanelOpen(true))

beforeEach(() => {
  store().reset()
  vi.clearAllMocks()
  mocks.cancelDownload.mockResolvedValue(true)
  mocks.clearHistory.mockResolvedValue([])
  mocks.removeHistory.mockResolvedValue([])
})

afterEach(cleanup)

describe("opening and closing", () => {
  test("nothing is rendered while it is closed", () => {
    store().add(row())

    render(<DownloadsPanel />)

    expect(screen.queryByRole("complementary")).toBeNull()
  })

  test("the store is what opens it, from anywhere", () => {
    render(<DownloadsPanel />)

    open()

    expect(within(panel()).getByText(en["downloads.title"])).toBeTruthy()
  })

  test("escape closes it", () => {
    render(<DownloadsPanel />)
    open()

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" })
    })

    expect(store().panelOpen).toBe(false)
  })

  // the listener goes with the panel, so a stray Escape while it is closed
  // must not be something this is still listening for
  test("and does nothing while it is already closed", () => {
    render(<DownloadsPanel />)

    fireEvent.keyDown(window, { key: "Escape" })

    expect(store().panelOpen).toBe(false)
  })

  test("another key does not", () => {
    render(<DownloadsPanel />)
    open()

    fireEvent.keyDown(window, { key: "Enter" })

    expect(store().panelOpen).toBe(true)
  })

  test("the close button closes it", () => {
    render(<DownloadsPanel />)
    open()

    fireEvent.click(
      within(panel()).getByRole("button", { name: en["downloads.close"] })
    )

    expect(store().panelOpen).toBe(false)
  })
})

describe("the header", () => {
  test("counts what the user is still waiting on", () => {
    store().add(row({ downloadId: "a", status: "queued" }))
    store().add(row({ downloadId: "b" }))
    store().add(row({ downloadId: "c", status: "completed" }))

    render(<DownloadsPanel />)
    open()

    expect(within(panel()).getByText("2 active")).toBeTruthy()
  })

  test("says nothing about a count of zero", () => {
    store().add(row({ status: "completed" }))

    render(<DownloadsPanel />)
    open()

    expect(within(panel()).queryByText(/active/)).toBeNull()
  })

  test("offers nothing to clear while everything is still running", () => {
    store().add(row())

    render(<DownloadsPanel />)
    open()

    expect(
      within(panel())
        .getByRole("button", { name: en["downloads.clearFinished"] })
        .hasAttribute("disabled")
    ).toBe(true)
  })

  test("clears the finished rows and the history with them", () => {
    store().add(row({ downloadId: "live" }))
    store().add(row({ downloadId: "done", status: "completed" }))

    render(<DownloadsPanel />)
    open()

    fireEvent.click(
      within(panel()).getByRole("button", {
        name: en["downloads.clearFinished"]
      })
    )

    expect(store().rows.map((entry) => entry.downloadId)).toEqual(["live"])
    expect(mocks.clearHistory).toHaveBeenCalled()
  })
})

describe("the body", () => {
  test("lists the rows in the order the store keeps them", () => {
    store().add(row({ downloadId: "older", title: "Older", startedAt: 1 }))
    store().add(row({ downloadId: "newer", title: "Newer", startedAt: 2 }))

    render(<DownloadsPanel />)
    open()

    const titles = Array.from(
      panel().querySelectorAll("[data-download-id]")
    ).map((node) => node.getAttribute("data-download-id"))

    expect(titles).toEqual(["newer", "older"])
  })

  /**
   * every status has exactly one action that belongs to it, and drawing the
   * wrong one is a button main cannot answer: a Stop on a finished row, a
   * Retry on one that is still going.
   */
  test("gives each status the action that belongs to it", () => {
    const statuses: [DownloadRow["status"], string][] = [
      ["queued", en["downloads.remove"]],
      ["starting", en["progress.stop"]],
      ["downloading", en["progress.stop"]],
      ["completed", en["toast.openFolder"]],
      ["failed", en["downloads.retry"]],
      ["cancelled", en["downloads.retry"]],
      ["interrupted", en["downloads.retry"]]
    ]

    for (const [index, [status]] of statuses.entries()) {
      store().add(row({ downloadId: status, status, startedAt: index }))
    }

    render(<DownloadsPanel />)
    open()

    for (const [status, label] of statuses) {
      const rendered = panel().querySelector(`[data-download-id="${status}"]`)

      expect([
        status,
        Boolean(
          within(rendered as HTMLElement).getByRole("button", { name: label })
        )
      ]).toEqual([status, true])
    }
  })

  test("says the list is empty once the one read that could fill it has landed", () => {
    render(<DownloadsPanel />)
    open()

    // before hydration: an empty panel, but nothing claimed about it
    expect(within(panel()).queryByText(en["downloads.emptyTitle"])).toBeNull()

    act(() => store().hydrate([], []))

    expect(within(panel()).getByText(en["downloads.emptyTitle"])).toBeTruthy()
  })
})

describe("the highlight", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("rings the row it names, then clears itself", () => {
    store().add(row())

    render(<DownloadsPanel />)
    open()

    act(() => store().setHighlighted("d1"))

    const rendered = panel().querySelector(
      '[data-download-id="d1"]'
    ) as HTMLElement

    expect(rendered.className).toContain("ring-2")

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(store().highlightedId).toBeNull()
    expect(
      (panel().querySelector('[data-download-id="d1"]') as HTMLElement)
        .className
    ).not.toContain("ring-2")
  })

  /**
   * the timer runs from the panel rather than from the row, because a panel
   * closed a moment after a duplicate click opened it would otherwise keep the
   * highlight set and put the ring on a download that ended long ago the next
   * time it was opened.
   */
  test("clears even while the panel is shut", () => {
    store().add(row())

    render(<DownloadsPanel />)

    act(() => store().setHighlighted("d1"))
    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(store().highlightedId).toBeNull()
  })
})
