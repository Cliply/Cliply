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

  /**
   * the close button is gone: a click anywhere else is what closes the panel
   * now. it is taken on mousedown so that whatever was clicked still receives
   * its own event - the panel is not a modal and nothing is swallowed.
   */
  test("a click outside closes it", () => {
    render(<DownloadsPanel />)
    open()

    fireEvent.mouseDown(document.body)

    expect(store().panelOpen).toBe(false)
  })

  test("a click inside it does not", () => {
    store().add(row())

    render(<DownloadsPanel />)
    open()

    fireEvent.mouseDown(within(panel()).getByText(en["downloads.title"]))

    expect(store().panelOpen).toBe(true)
  })

  /**
   * the toggle sets the opposite of what it reads, so a panel that closed on
   * its mousedown would be reopened by its own click - and the one control
   * whose job is closing the panel would never close it.
   */
  test("and a click on the toggle is left to the toggle", () => {
    render(
      <>
        <button type="button" data-downloads-toggle="">
          toggle
        </button>
        <DownloadsPanel />
      </>
    )
    open()

    fireEvent.mouseDown(screen.getByRole("button", { name: "toggle" }))

    expect(store().panelOpen).toBe(true)
  })

  // the listener goes with the panel: a click anywhere while it is closed must
  // not be something this is still listening for
  test("and nothing is listening while it is closed", () => {
    render(<DownloadsPanel />)

    expect(() => fireEvent.mouseDown(document.body)).not.toThrow()
    expect(store().panelOpen).toBe(false)
  })
})

describe("the header", () => {
  test("shows the lifetime count and what it counts", () => {
    act(() => store().hydrate([], [], 128))

    render(<DownloadsPanel />)
    open()

    expect(within(panel()).getByText("128")).toBeTruthy()
    expect(
      within(panel()).getByText(en["downloads.mediaDownloaded"].split("|")[1])
    ).toBeTruthy()
  })

  // a fresh install has a true thing to say, and says it rather than hiding
  test("reads zero on an install that has downloaded nothing", () => {
    render(<DownloadsPanel />)
    open()

    expect(within(panel()).getByText("0")).toBeTruthy()
  })

  test("offers nothing to clear while everything is still running", () => {
    store().add(row())

    render(<DownloadsPanel />)
    open()

    expect(
      within(panel())
        .getByRole("button", { name: en["downloads.clearHistory"] })
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
        name: en["downloads.clearHistory"]
      })
    )

    expect(store().rows.map((entry) => entry.downloadId)).toEqual(["live"])
    expect(mocks.clearHistory).toHaveBeenCalled()
  })

  /**
   * the number counts downloads this install finished, not rows it still
   * keeps, so emptying the list is not a reason for it to move.
   */
  test("and the count stays where it was", () => {
    act(() => store().hydrate([], [], 12))
    store().add(row({ downloadId: "done", status: "completed" }))

    render(<DownloadsPanel />)
    open()

    fireEvent.click(
      within(panel()).getByRole("button", {
        name: en["downloads.clearHistory"]
      })
    )

    expect(store().lifetimeCompleted).toBe(12)
    expect(within(panel()).getByText("12")).toBeTruthy()
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
      // a queued row's Stop is the cancel that drops the reservation: there is
      // no Remove on any row any more
      ["queued", en["progress.stop"]],
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
    expect(
      within(panel()).queryByText(en["downloads.nothingToShow"])
    ).toBeNull()

    act(() => store().hydrate([], []))

    expect(
      within(panel()).getByText(en["downloads.nothingToShow"])
    ).toBeTruthy()
  })

  // in the middle of the space the list was given, rather than tucked under the
  // number: the list is the only thing on screen when there is nothing in it
  test("and says it in the middle of the empty list", () => {
    render(<DownloadsPanel />)
    open()
    act(() => store().hydrate([], []))

    const line = within(panel()).getByText(en["downloads.nothingToShow"])

    expect(line.parentElement?.className).toContain("items-center")
    expect(line.parentElement?.className).toContain("justify-center")
    expect(line.parentElement?.className).toContain("flex-1")
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

/**
 * the ring on its own is not the whole answer to a duplicate click: the list is
 * newest first and it scrolls, so the download being pointed at is usually
 * below the fold by the time there are enough of them for anyone to click twice
 * - and a marker nobody sees expires in two seconds.
 *
 * jsdom implements no scrolling at all, so the panel calls through a guard and
 * these stub the prototype. what is asserted is which row was revealed, which
 * is the part jsdom can answer.
 */
describe("revealing the highlighted row", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true
    })

    store().add(row({ downloadId: "older", title: "Older", startedAt: 1 }))
    store().add(row({ downloadId: "newer", title: "Newer", startedAt: 2 }))
  })

  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  test("scrolls the row a duplicate click named into view", () => {
    render(<DownloadsPanel />)
    open()

    // the panel opened on its own has nothing to reveal
    expect(scrollIntoView).not.toHaveBeenCalled()

    act(() => store().setHighlighted("older"))

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    // as little movement as it takes, rather than yanking the row to the middle
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
    expect(
      scrollIntoView.mock.instances[0].getAttribute("data-download-id")
    ).toBe("older")
  })

  /**
   * the duplicate rule opens the panel and highlights in one go
   * (`findLive` in the hooks), so the highlight is usually set before the list
   * has been rendered at all.
   */
  test("and reveals it when the highlight arrives before the panel does", () => {
    render(<DownloadsPanel />)

    act(() => store().setHighlighted("older"))

    expect(scrollIntoView).not.toHaveBeenCalled()

    open()

    expect(
      scrollIntoView.mock.instances[0].getAttribute("data-download-id")
    ).toBe("older")
  })

  test("leaves the list alone for a row it does not know", () => {
    render(<DownloadsPanel />)
    open()

    act(() => store().setHighlighted("never-heard-of-it"))

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  // the panel must not throw where there is no scrolling to do, which is every
  // test in this suite that did not stub the prototype
  test("survives a dom that cannot scroll", () => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView

    render(<DownloadsPanel />)

    expect(() => {
      open()
      act(() => store().setHighlighted("older"))
    }).not.toThrow()
  })
})
