// @vitest-environment jsdom
//
// the list is where the two rules that matter live: an unavailable video can
// never be selected, by any route including select-all, and once a run starts
// the checkboxes give way to badges that say what each row actually did.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import { usePlaylistStore } from "@/lib/playlistStore"
import { PlaylistList } from "./PlaylistList"

const entry = (index: number, overrides: Partial<PlaylistEntry> = {}): PlaylistEntry => ({
  index,
  id: `video${index}`,
  title: `video ${index}`,
  duration: 60,
  duration_string: "1:00",
  thumbnail: null,
  unavailable: false,
  ...overrides
})

// yt-dlp gives a private entry a null title, and the mapper fills in the
// placeholder. distinct here only so a query can name one of the two
const gone = (index: number, title = "[Private video]"): PlaylistEntry =>
  entry(index, {
    id: null,
    title,
    duration: null,
    duration_string: null,
    unavailable: true
  })

const listing = (entries: PlaylistEntry[]): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "Short talks",
  uploader: "TED",
  count: entries.length,
  listed: entries.length,
  truncated: false,
  entries
})

/** eleven rows, two of which are gone: the shape the mockup is drawn from */
const ELEVEN = listing([
  entry(1),
  entry(2),
  gone(3),
  entry(4),
  entry(5),
  entry(6),
  entry(7),
  gone(8, "[Deleted video]"),
  entry(9),
  entry(10),
  entry(11)
])

const load = (info: PlaylistInfoResponse = ELEVEN) =>
  usePlaylistStore.getState().setLoadedPlaylist("https://youtube.com/playlist?list=PL123", info)

const checkboxes = () => screen.getAllByRole("checkbox")
const checkboxFor = (title: string) => screen.getByRole("checkbox", { name: title })
const rowFor = (index: number) =>
  document.querySelector(`[data-index="${index}"]`) as HTMLElement

beforeEach(() => {
  usePlaylistStore.getState().reset()
  load()
})
afterEach(cleanup)

describe("what starts ticked", () => {
  test("every available row, and nothing that cannot be downloaded", () => {
    render(<PlaylistList phase="picking" />)

    expect(checkboxes()).toHaveLength(11)
    expect(checkboxes().filter((box) => box.getAttribute("aria-checked") === "true"))
      .toHaveLength(9)
    expect(checkboxFor("[Private video]").getAttribute("aria-checked")).toBe("false")
  })

  test("the count is out of what can be picked, not out of what is listed", () => {
    render(<PlaylistList phase="picking" />)

    // "9 of 11" with two rows that can never be ticked reads as a checkbox
    // that does not work
    expect(screen.getByText("9 of 9 selected")).toBeDefined()
  })

  test("the count follows every toggle", () => {
    render(<PlaylistList phase="picking" />)

    fireEvent.click(checkboxFor("video 1"))
    expect(screen.getByText("8 of 9 selected")).toBeDefined()

    fireEvent.click(checkboxFor("video 2"))
    expect(screen.getByText("7 of 9 selected")).toBeDefined()

    fireEvent.click(checkboxFor("video 1"))
    expect(screen.getByText("8 of 9 selected")).toBeDefined()
  })
})

describe("the row that cannot be downloaded", () => {
  test("is marked unavailable and greyed rather than silently unticked", () => {
    render(<PlaylistList phase="picking" />)

    const row = rowFor(3)
    expect(within(row).getByText("unavailable")).toBeDefined()
    expect(row.className).toContain("opacity-60")
  })

  test("its checkbox is disabled, and clicking it changes nothing", () => {
    render(<PlaylistList phase="picking" />)

    const box = checkboxFor("[Private video]")
    expect((box as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(box)

    expect(usePlaylistStore.getState().selectedIndices.has(3)).toBe(false)
    expect(screen.getByText("9 of 9 selected")).toBeDefined()
  })

  /**
   * the one that matters most: each attempt at a private video spends one of
   * yt-dlp's five allowed failures before it gives up on the rest of the
   * playlist, so select-all reaching one would cost the run itself
   */
  test("select all does not reach it", () => {
    render(<PlaylistList phase="picking" />)

    fireEvent.click(screen.getByText("Select none"))
    expect(screen.getByText("0 of 9 selected")).toBeDefined()

    fireEvent.click(screen.getByText("Select all"))

    const selected = usePlaylistStore.getState().selectedIndices
    expect(selected.size).toBe(9)
    expect(selected.has(3)).toBe(false)
    expect(selected.has(8)).toBe(false)
  })

  test("a row whose id never arrived is unselectable too", () => {
    // the id travels with the selection and is what the resume archive is
    // matched on, so main refuses a request carrying a row without one
    load(listing([entry(1), entry(2, { id: null })]))
    render(<PlaylistList phase="picking" />)

    fireEvent.click(screen.getByText("Select all"))

    expect([...usePlaylistStore.getState().selectedIndices]).toEqual([1])
    expect(screen.getByText("1 of 1 selected")).toBeDefined()
  })
})

describe("once the run starts", () => {
  test("the checkboxes are gone, because the selection is fixed now", () => {
    render(<PlaylistList phase="running" />)

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
    expect(screen.queryByText("Select all")).toBeNull()
    expect(screen.getByText("Per video status")).toBeDefined()
  })

  test("each row shows what it is doing", () => {
    const store = usePlaylistStore.getState()
    store.setItemStatus(1, { state: "saved", progress: 100, height: 1080 })
    store.setItemStatus(2, { state: "saved", progress: 100, height: 720 })
    store.setItemStatus(4, { state: "downloading", progress: 62 })

    render(<PlaylistList phase="running" />)

    // the same run under one ceiling, two different delivered heights: this is
    // what "best available up to the limit" looks like from the outside
    expect(within(rowFor(1)).getByText("saved · 1080p")).toBeDefined()
    expect(within(rowFor(2)).getByText("saved · 720p")).toBeDefined()
    expect(within(rowFor(4)).getByText("62%")).toBeDefined()
    // never announced yet
    expect(within(rowFor(5)).getByText("queued")).toBeDefined()
    // and the one that never could be
    expect(within(rowFor(3)).getByText("unavailable")).toBeDefined()
  })

  test("a video the archive already had is not called saved", () => {
    usePlaylistStore.getState().setItemStatus(1, { state: "reused", progress: 100 })

    render(<PlaylistList phase="running" />)

    // an archive skip records that a download once succeeded, not that this
    // run wrote a file
    expect(within(rowFor(1)).getByText("already downloaded")).toBeDefined()
    expect(within(rowFor(1)).queryByText(/^saved/)).toBeNull()
  })

  test("the toolbar counts the badges rather than the ticks", () => {
    const store = usePlaylistStore.getState()
    store.setItemStatus(1, { state: "saved", progress: 100 })
    store.setItemStatus(2, { state: "reused", progress: 100 })
    store.setItemStatus(4, { state: "downloading", progress: 10 })

    render(<PlaylistList phase="running" />)

    expect(screen.getByText("2 done · 1 downloading")).toBeDefined()
  })

  /**
   * the window between main accepting a Cancel and the run reporting how it
   * ended. every other ending settles its in-flight rows on the terminal
   * event, so a row still downloading on a finished screen is only ever one
   * being stopped, and its last percentage would read as one still going
   */
  test("a row still in flight when the run ended reads as stopping", () => {
    usePlaylistStore.getState().setItemStatus(4, { state: "downloading", progress: 62 })

    render(<PlaylistList phase="finished" />)

    expect(within(rowFor(4)).getByText("stopping")).toBeDefined()
    expect(within(rowFor(4)).queryByText("62%")).toBeNull()
  })

  test("a saved row keeps its badge once the run has ended", () => {
    const store = usePlaylistStore.getState()
    store.setItemStatus(1, { state: "saved", progress: 100, height: 480 })
    store.setItemStatus(2, { state: "skipped", progress: 0 })

    render(<PlaylistList phase="finished" />)

    expect(within(rowFor(1)).getByText("saved · 480p")).toBeDefined()
    expect(within(rowFor(2)).getByText("not saved")).toBeDefined()
    // nothing is queued once there is nothing left to wait for
    expect(within(rowFor(5)).getByText("not saved")).toBeDefined()
    expect(screen.queryByText("queued")).toBeNull()
  })
})

describe("the copy", () => {
  test("uses no em-dash, in any phase", () => {
    for (const phase of ["picking", "running", "finished"] as const) {
      cleanup()
      render(<PlaylistList phase={phase} />)
      expect(document.body.textContent).not.toContain("—")
    }
  })
})
