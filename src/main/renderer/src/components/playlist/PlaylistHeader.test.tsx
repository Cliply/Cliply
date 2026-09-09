// @vitest-environment jsdom
//
// the header says what was pasted and, once a run is going, where the files
// are landing. that last line used to be the literal "~/Downloads/Cliply",
// which was a lie to everybody who had ever changed the folder, so what is
// under test is that it names the real one or says nothing at all.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { DownloadPathInfo, PlaylistInfoResponse } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { PlaylistHeader } from "./PlaylistHeader"

const mocks = vi.hoisted(() => ({
  downloadPath: null as DownloadPathInfo | null
}))

// the hook reads the folder over ipc, which this component only consumes
vi.mock("@/lib/hooks/useDownloadPath", () => ({
  useDownloadPath: () => ({
    downloadPath: mocks.downloadPath,
    isLoading: false,
    selectFolder: vi.fn()
  })
}))

const at = (path: string): DownloadPathInfo => ({
  path,
  exists: true,
  writable: true
})

const listing = (
  overrides: Partial<PlaylistInfoResponse> = {}
): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "Short talks",
  uploader: "TED",
  count: 11,
  listed: 11,
  truncated: false,
  entries: [],
  ...overrides
})

beforeEach(() => {
  mocks.downloadPath = at("/Volumes/Media/Talks")
})
afterEach(cleanup)

describe("what was pasted", () => {
  test("is named, counted and measured", () => {
    render(<PlaylistHeader info={listing()} phase="picking" />)

    expect(screen.getByText("Short talks")).toBeDefined()
    expect(screen.getByText(/TED/)).toBeDefined()
    expect(screen.getByText(/11 videos/)).toBeDefined()
  })
})

describe("where the files are going", () => {
  test("is the folder the user actually chose", () => {
    render(<PlaylistHeader info={listing()} phase="running" />)

    expect(screen.getByText("/Volumes/Media/Talks")).toBeDefined()
    expect(screen.getByText(new RegExp(en["layout.downloadsAt"]))).toBeDefined()
    // the default this line used to print whatever the folder really was
    expect(document.body.textContent).not.toContain("~/Downloads/Cliply")
  })

  /**
   * the folder is read over ipc and the answer can be late, or not come at
   * all. a line naming the wrong folder is worse than no line, so there is
   * no fallback to guess with.
   */
  test("says nothing at all until the path is known", () => {
    mocks.downloadPath = null

    render(<PlaylistHeader info={listing()} phase="running" />)

    expect(screen.queryByText(new RegExp(en["layout.downloadsAt"]))).toBeNull()
    expect(screen.getByText("Short talks")).toBeDefined()
  })

  // while the user is still picking, nothing has landed anywhere
  test("and nothing before the run starts", () => {
    render(<PlaylistHeader info={listing()} phase="picking" />)

    expect(screen.queryByText("/Volumes/Media/Talks")).toBeNull()
  })

  test("in russian too", () => {
    useLocale.getState().setLocale("ru")

    try {
      render(<PlaylistHeader info={listing()} phase="finished" />)

      expect(screen.getByText(/загрузки сохраняются в/)).toBeDefined()
      expect(screen.getByText("/Volumes/Media/Talks")).toBeDefined()
      expect(screen.getByText(/11 видео/)).toBeDefined()
    } finally {
      useLocale.getState().setLocale("en")
    }
  })
})
