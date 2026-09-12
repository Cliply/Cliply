// @vitest-environment jsdom
//
// the badge is the only thing on any screen that says a download is running
// once the card that started it is gone, so what it counts matters: the rows
// the user is still waiting on, and nothing else.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  downloadApi: { removeHistory: vi.fn(), clearHistory: vi.fn() }
}))

import { en } from "@/lib/i18n/en"
import {
  useDownloadsStore,
  type DownloadRow
} from "@/lib/stores/downloadsStore"

import { DownloadsToggle } from "./DownloadsToggle"

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
  ...overrides
})

beforeEach(() => {
  store().reset()
})

afterEach(cleanup)

describe("the badge", () => {
  test("is absent while nothing is running", () => {
    store().add(row({ downloadId: "done", status: "completed" }))
    store().add(row({ downloadId: "gone", status: "cancelled" }))

    render(<DownloadsToggle />)

    // the whole button is the icon plus its hidden name: no number anywhere
    expect(screen.getByRole("button").textContent).toBe(en["downloads.toggle"])
  })

  test("counts queued, starting and downloading together", () => {
    store().add(row({ downloadId: "a", status: "queued" }))
    store().add(row({ downloadId: "b", status: "starting" }))
    store().add(row({ downloadId: "c", status: "downloading" }))
    store().add(row({ downloadId: "d", status: "completed" }))
    store().add(row({ downloadId: "e", status: "interrupted" }))

    render(<DownloadsToggle />)

    expect(screen.getByText("3")).toBeTruthy()
  })

  test("follows the store without a remount", () => {
    render(<DownloadsToggle />)

    expect(screen.queryByText("1")).toBeNull()

    act(() => store().add(row()))

    expect(screen.getByText("1")).toBeTruthy()
  })
})

describe("the button", () => {
  test("opens the panel, and closes it again", () => {
    render(<DownloadsToggle />)

    fireEvent.click(screen.getByRole("button"))
    expect(store().panelOpen).toBe(true)

    fireEvent.click(screen.getByRole("button"))
    expect(store().panelOpen).toBe(false)
  })

  test("says whether the panel is open", () => {
    render(<DownloadsToggle />)

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false"
    )

    fireEvent.click(screen.getByRole("button"))

    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true"
    )
  })
})
