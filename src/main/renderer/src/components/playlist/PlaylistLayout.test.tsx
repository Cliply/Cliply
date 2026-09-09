// @vitest-environment jsdom
//
// the whole screen, driven by the events a real run emits: pick, download,
// finish. one hook owns the run for the whole layout, because the phase it is
// in decides what the list on the left draws as well as what the card on the
// right does.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"

const mocks = vi.hoisted(() => ({
  listeners: [] as ((payload: Record<string, unknown>) => void)[],
  downloadPlaylist: vi.fn(),
  cancelDownload: vi.fn(),
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
      onProgress: (listener: (payload: Record<string, unknown>) => void) => {
        mocks.listeners.push(listener)

        return () => {
          const index = mocks.listeners.indexOf(listener)
          if (index >= 0) mocks.listeners.splice(index, 1)
        }
      },
      cancelDownload: (id: string) => mocks.cancelDownload(id)
    },
    playlistApi: { download: (request: unknown) => mocks.downloadPlaylist(request) },
    systemApi: { openDownloadFolder: mocks.openDownloadFolder }
  }
})

vi.mock("@/lib/reportStore", () => ({ reportActions: { stage: vi.fn() } }))
vi.mock("@/lib/toast-utils", () => ({ showDownloadErrorToast: vi.fn() }))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() }
}))
// the search box reaches into every platform store and none of that is what
// this screen is for
vi.mock("@/components/video/CompactSearch", () => ({
  CompactSearch: () => null
}))

import { usePlaylistStore } from "@/lib/playlistStore"
import { PlaylistLayout } from "./PlaylistLayout"

const entry = (index: number, overrides: Partial<PlaylistEntry> = {}): PlaylistEntry => ({
  index,
  id: `video${index}`,
  title: `video ${index}`,
  duration: 300,
  duration_string: "5:00",
  thumbnail: null,
  unavailable: false,
  ...overrides
})

const listing = (
  overrides: Partial<PlaylistInfoResponse> = {}
): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "Short talks",
  uploader: "TED",
  count: 3,
  listed: 3,
  truncated: false,
  entries: [entry(1), entry(2), entry(3)],
  ...overrides
})

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  })

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const load = (info = listing(), url = "https://youtube.com/playlist?list=PL123") =>
  act(() => {
    usePlaylistStore.getState().setLoadedPlaylist(url, info)
  })

const emit = async (payload: Record<string, unknown>) => {
  await act(async () => {
    for (const listener of [...mocks.listeners]) listener(payload)
  })
}

const sentDownloadId = () =>
  mocks.downloadPlaylist.mock.calls[0][0].download_id as string

const start = async () => {
  fireEvent.click(screen.getByRole("button", { name: /^Download 3 videos$/ }))
  await waitFor(() => expect(mocks.downloadPlaylist).toHaveBeenCalled())
}

const rowFor = (index: number) =>
  document.querySelector(`[data-index="${index}"]`) as HTMLElement

beforeEach(() => {
  mocks.listeners.length = 0
  vi.clearAllMocks()
  usePlaylistStore.getState().reset()
  mocks.downloadPlaylist.mockResolvedValue({ downloadId: "ignored" })
  mocks.cancelDownload.mockResolvedValue(true)
  load()
})

afterEach(cleanup)

describe("the whole screen, end to end", () => {
  test("opens on the picker with everything ticked", () => {
    render(<PlaylistLayout />, { wrapper })

    expect(screen.getByText("Short talks")).toBeDefined()
    expect(screen.getByText(/TED/)).toBeDefined()
    expect(screen.getAllByRole("checkbox")).toHaveLength(3)
    expect(screen.getByText("3 of 3 selected")).toBeDefined()
    expect(screen.getByRole("button", { name: "Download 3 videos" })).toBeDefined()
  })

  test("a truncated listing says how much it is not showing", () => {
    load(listing({ listed: 3, count: 5283, truncated: true }))
    render(<PlaylistLayout />, { wrapper })

    expect(screen.getByText(/Showing the first 3 of 5,283 videos/)).toBeDefined()
  })

  test("pressing download swaps the checkboxes for badges and two bars", async () => {
    render(<PlaylistLayout />, { wrapper })
    await start()

    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      progress: 33,
      item_progress: 62,
      item_index: 1,
      items_completed: 0,
      items_total: 3,
      playlist_index: 1,
      video_id: "video1"
    })

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
    expect(screen.getByText("Video 1 of 3")).toBeDefined()
    expect(screen.getByText("This video")).toBeDefined()
    expect(within(rowFor(1)).getByText("62%")).toBeDefined()
    expect(within(rowFor(2)).getByText("queued")).toBeDefined()
    expect(screen.getByRole("button", { name: "Cancel remaining" })).toBeDefined()

    await emit({ downloadId: sentDownloadId(), status: "completed", progress: 100 })
  })

  /**
   * the run finished with one video missing, one it already had and one it
   * wrote. all three of those are different things and the screen has to say
   * so, on the rows and in the summary
   */
  test("a partial run ends on a summary, not on an error", async () => {
    render(<PlaylistLayout />, { wrapper })
    await start()

    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      progress: 100,
      files: ["/dl/PL/001 - One [video1] 720p.mp4"],
      items_saved: 1,
      items_reused: 1,
      items_skipped: 1,
      items_total: 3,
      reused_indices: [2]
    })

    expect(
      screen.getByText("1 of 3 videos saved, 1 already downloaded, 1 skipped.")
    ).toBeDefined()
    expect(screen.getByText(/Not saved: "video 3"\./)).toBeDefined()

    // the height this one really came down at, under a 1080p ceiling
    expect(within(rowFor(1)).getByText("saved · 720p")).toBeDefined()
    expect(within(rowFor(2)).getByText("already downloaded")).toBeDefined()
    expect(within(rowFor(3)).getByText("not saved")).toBeDefined()

    expect(screen.getByRole("button", { name: "Open folder" })).toBeDefined()
    expect(screen.getByRole("button", { name: "Retry the 1 that failed" })).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Download everything again" })
    ).toBeDefined()
  })

  test("a cancel keeps the rows that were already saved", async () => {
    render(<PlaylistLayout />, { wrapper })
    await start()

    // the first video's file landed, the second was still going
    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      progress: 33,
      item_index: 1,
      items_completed: 1,
      items_total: 3,
      item_progress: 100,
      playlist_index: 1
    })
    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      progress: 40,
      item_index: 2,
      items_completed: 1,
      items_total: 3,
      item_progress: 20,
      playlist_index: 2
    })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel remaining" }))
    })

    await waitFor(() =>
      expect(screen.getByText(/Videos already saved are kept/)).toBeDefined()
    )

    // nothing is claimed about what it saved until the run says so
    expect(screen.queryByText(/videos saved/)).toBeNull()

    // the run's own terminal event, which is the only thing carrying the
    // counts, the heights and the rows the archive had already accounted for
    await emit({
      downloadId: sentDownloadId(),
      status: "cancelled",
      files: ["/dl/PL/001 - One [video1] 720p.mp4"],
      items_saved: 1,
      items_reused: 1,
      items_skipped: 1,
      items_total: 3,
      reused_indices: [3]
    })

    // a cancel is a kill, and the videos it had already finished are on disk
    expect(within(rowFor(1)).getByText("saved · 720p")).toBeDefined()
    expect(within(rowFor(3)).getByText("already downloaded")).toBeDefined()
    expect(within(rowFor(2)).getByText("not saved")).toBeDefined()

    expect(
      screen.getByText("1 of 3 videos saved, 1 already downloaded, 1 skipped.")
    ).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Download everything again" })
    ).toBeDefined()
  })

  /**
   * accepting a cancel is main saying it found the id and asked the process to
   * stop. it is not the outcome, and settling on it dropped the listener
   * before the run said what it had written
   */
  test("a cancel acknowledgement does not throw away the evidence still coming", async () => {
    render(<PlaylistLayout />, { wrapper })
    await start()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel remaining" }))
    })

    expect(mocks.listeners).toHaveLength(1)
    expect(screen.getByText("Playlist download cancelled")).toBeDefined()
    // and never "0 of 3 videos saved" over a run that had not reported yet
    expect(screen.queryByText(/0 of 3/)).toBeNull()

    await emit({
      downloadId: sentDownloadId(),
      status: "cancelled",
      files: [],
      items_saved: 0,
      items_reused: 3,
      items_skipped: 0,
      items_total: 3,
      reused_indices: [1, 2, 3]
    })

    expect(
      screen.getByText("0 of 3 videos saved, 3 already downloaded.")
    ).toBeDefined()
    expect(within(rowFor(2)).getByText("already downloaded")).toBeDefined()
    // three rows the user already has, and nothing to retry
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull()
  })

  /**
   * a playlist can hold one video at two positions and the template writes a
   * file for each. one file certifies one row: the other has to stay retryable
   */
  test("one file does not certify a duplicate position that never landed", async () => {
    load(listing({ entries: [entry(1), entry(2, { id: "video1" }), entry(3)] }))

    render(<PlaylistLayout />, { wrapper })
    await start()

    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      progress: 100,
      files: ["/dl/PL/001 - One [video1] 720p.mp4"],
      items_saved: 1,
      items_reused: 0,
      items_skipped: 2,
      items_total: 3,
      reused_indices: []
    })

    expect(usePlaylistStore.getState().itemStatus.get(2)?.state).not.toBe("saved")
    expect(within(rowFor(1)).getByText("saved · 720p")).toBeDefined()
    expect(within(rowFor(2)).getByText("not saved")).toBeDefined()
    expect(screen.getByRole("button", { name: "Retry the 2 that failed" })).toBeDefined()
  })

  /**
   * pasting a second playlist replaces the listing in place: nothing unmounts
   * this screen, so without a reset the new playlist would open on the last
   * run's summary, over rows it says nothing about
   */
  test("a new playlist opens on its own picker, not on the last one's summary", async () => {
    render(<PlaylistLayout />, { wrapper })
    await start()

    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      progress: 100,
      files: [],
      items_saved: 3,
      items_reused: 0,
      items_skipped: 0,
      items_total: 3
    })

    expect(screen.getByText("3 of 3 videos saved.")).toBeDefined()

    load(
      listing({
        playlist_id: "PL999",
        title: "Another list",
        entries: [entry(1), entry(2)],
        count: 2,
        listed: 2
      }),
      "https://youtube.com/playlist?list=PL999"
    )

    expect(screen.getByText("Another list")).toBeDefined()
    expect(screen.queryByText("3 of 3 videos saved.")).toBeNull()
    expect(screen.getAllByRole("checkbox")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Download 2 videos" })).toBeDefined()
  })

  /**
   * every lookup returns a fresh response object, so an object comparison
   * calls the link already on screen a different playlist. re-pasting it would
   * then detach the run the user is watching: the bars gone, Cancel gone, and
   * the job still going where nothing can reach it
   */
  test("re-pasting the same playlist leaves its run alone", async () => {
    render(<PlaylistLayout />, { wrapper })
    await start()

    await emit({
      downloadId: sentDownloadId(),
      status: "downloading",
      progress: 20,
      item_index: 1,
      items_completed: 0,
      items_total: 3,
      item_progress: 60,
      playlist_index: 1
    })

    // the same link, listed again: a fresh object for the same playlist
    load(listing())

    expect(mocks.listeners).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Cancel remaining" })).toBeDefined()
    expect(screen.getByText("Video 1 of 3")).toBeDefined()
    expect(within(rowFor(1)).getByText("60%")).toBeDefined()

    // and it is still the run that answers, not a stranded one
    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      progress: 100,
      files: ["/dl/PL/001 - One [video1] 1080p.mp4"],
      items_saved: 1,
      items_reused: 0,
      items_skipped: 2,
      items_total: 3
    })

    expect(screen.getByText("1 of 3 videos saved, 2 skipped.")).toBeDefined()
  })

  /**
   * the other half of the same window: a start that is still pending when the
   * view moves on keeps its own callbacks, and its failure would land on the
   * playlist now on screen
   */
  test("a stranded start failure cannot overwrite the next playlist", async () => {
    let rejectStart: (error: Error) => void = () => {}
    mocks.downloadPlaylist.mockImplementation(
      () => new Promise((_resolve, reject) => (rejectStart = reject))
    )

    render(<PlaylistLayout />, { wrapper })
    await start()

    load(
      listing({ playlist_id: "PL999", title: "Another list" }),
      "https://youtube.com/playlist?list=PL999"
    )

    await act(async () => {
      rejectStart(new Error("A cannot start"))
    })

    expect(screen.getByText("Another list")).toBeDefined()
    expect(screen.queryByText("Playlist download failed")).toBeNull()
    expect(screen.getByRole("button", { name: "Download 3 videos" })).toBeDefined()
  })

  test("nothing on the screen uses an em-dash", async () => {
    render(<PlaylistLayout />, { wrapper })

    expect(document.body.textContent).not.toContain("—")

    await start()
    await emit({
      downloadId: sentDownloadId(),
      status: "completed",
      progress: 100,
      files: [],
      items_saved: 2,
      items_reused: 1,
      items_skipped: 0,
      items_total: 3,
      reused_indices: [3]
    })

    expect(document.body.textContent).not.toContain("—")
  })
})
