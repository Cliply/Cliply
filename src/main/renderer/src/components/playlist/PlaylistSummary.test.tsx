// @vitest-environment jsdom
//
// partial success is the outcome this card exists for. a playlist that saved
// eight of nine is eight videos the user now has, and drawing an error over it
// hides that; a playlist that "saved" five it actually skipped through the
// archive is a claim about files we did not write.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import type { PlaylistDownloadState } from "@/lib/hooks/usePlaylistDownload"
import { usePlaylistStore } from "@/lib/playlistStore"
import { PlaylistSummary } from "./PlaylistSummary"

const entry = (index: number, title: string): PlaylistEntry => ({
  index,
  id: `video${index}`,
  title,
  duration: 60,
  duration_string: "1:00",
  thumbnail: null,
  unavailable: false
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

const NINE = listing([
  entry(1, "The Power of Imagination"),
  entry(2, "Why I Love My Bad Days"),
  entry(3, "3 Things I Wish I Knew When I Was Broke"),
  entry(4, "How I Turned Frustration Into Creative Speed"),
  entry(5, "The Secret to Giving Great Feedback"),
  entry(6, "Small Habits, Big Outcomes"),
  entry(7, "What Nobody Tells You About Focus"),
  entry(8, "A Better Way to Say No"),
  entry(9, "The Case for Boredom")
])

const finished = (
  overrides: Partial<PlaylistDownloadState> = {}
): PlaylistDownloadState => ({
  status: "completed",
  progress: 100,
  itemsSaved: 9,
  itemsReused: 0,
  itemsSkipped: 0,
  itemsTotal: 9,
  ...overrides
})

const handlers = () => ({
  onRun: vi.fn(),
  onRetry: vi.fn(),
  onPickAgain: vi.fn()
})

/** mark rows saved, as a finished run would have */
function markSaved(indices: number[], state: "saved" | "reused" = "saved") {
  const store = usePlaylistStore.getState()

  for (const index of indices) {
    store.setItemStatus(index, { state, progress: 100 })
  }
}

beforeEach(() => {
  usePlaylistStore.getState().reset()
  usePlaylistStore.getState().setLoadedPlaylist("https://youtube.com/playlist?list=PL123", NINE)
})
afterEach(cleanup)

describe("a partial run", () => {
  test("reads as what it saved, not as a failure", () => {
    markSaved([1, 2, 4, 5, 6, 7, 8, 9])

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 8, itemsSkipped: 1 })}
        {...handlers()}
      />
    )

    expect(screen.getByText("8 of 9 videos saved, 1 skipped.")).toBeDefined()
    expect(screen.queryByText("Playlist download failed")).toBeNull()
    expect(screen.getByRole("button", { name: "Open folder" })).toBeDefined()
  })

  test("names the video that did not make it", () => {
    markSaved([1, 2, 4, 5, 6, 7, 8, 9])

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 8, itemsSkipped: 1 })}
        {...handlers()}
      />
    )

    // "1 skipped" alone leaves the user to diff a folder against a playlist
    expect(
      screen.getByText(/Not saved: "3 Things I Wish I Knew When I Was Broke"\./)
    ).toBeDefined()
  })

  test("names three and counts the rest", () => {
    markSaved([1, 2, 3, 4, 5])

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 5, itemsSkipped: 4 })}
        {...handlers()}
      />
    )

    const line = screen.getByText(/4 not saved:/)
    expect(line.textContent).toContain('"Small Habits, Big Outcomes"')
    expect(line.textContent).toContain('"What Nobody Tells You About Focus"')
    expect(line.textContent).toContain('"A Better Way to Say No"')
    // the fourth is counted rather than named: the list is right there on the
    // left, and this card is not a second copy of it
    expect(line.textContent).toContain("and 1 more")
    expect(line.textContent).not.toContain("The Case for Boredom")
  })

  test("offers a retry that asks for exactly the ones that failed", () => {
    markSaved([1, 2, 4, 5, 6, 7, 8])
    const on = handlers()

    render(
      <PlaylistSummary state={finished({ itemsSaved: 7, itemsSkipped: 2 })} {...on} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Retry the 2 that failed" }))

    expect(on.onRetry).toHaveBeenCalledWith([3, 9])
  })

  test("a single failure is retried in the singular", () => {
    markSaved([1, 2, 3, 4, 5, 6, 7, 8])

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 8, itemsSkipped: 1 })}
        {...handlers()}
      />
    )

    expect(screen.getByRole("button", { name: "Retry the 1 that failed" })).toBeDefined()
  })
})

/**
 * an archive skip records that a download once succeeded, not that the file is
 * on disk now: a new destination or a deleted file skips exactly the same. so
 * it is never folded into the saves, and the way out of it is offered.
 */
describe("videos the archive already had", () => {
  test("are counted separately from what this run wrote", () => {
    markSaved([1, 2, 3])
    markSaved([4, 5], "reused")

    render(
      <PlaylistSummary
        state={finished({
          itemsSaved: 3,
          itemsReused: 2,
          itemsSkipped: 1,
          itemsTotal: 6
        })}
        {...handlers()}
      />
    )

    expect(
      screen.getByText("3 of 6 videos saved, 2 already downloaded, 1 skipped.")
    ).toBeDefined()
    // never a merged "5 saved"
    expect(screen.queryByText(/5 of 6/)).toBeNull()
  })

  test("do not count as unsaved, so they are not offered for retry", () => {
    markSaved([1, 2, 3, 4, 5, 6, 7])
    markSaved([8, 9], "reused")

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 7, itemsReused: 2 })}
        {...handlers()}
      />
    )

    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull()
    expect(screen.queryByText(/not saved/i)).toBeNull()
  })

  test("offer download everything again, which drops the archive", () => {
    markSaved([1, 2, 3, 4, 5, 6, 7, 8, 9], "reused")
    const on = handlers()

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 0, itemsReused: 9 })}
        {...on}
      />
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Download everything again" })
    )

    expect(on.onRun).toHaveBeenCalledWith({ ignoreArchive: true })
  })

  test("and a run that reused nothing does not offer it", () => {
    markSaved([1, 2, 3, 4, 5, 6, 7, 8, 9])

    render(<PlaylistSummary state={finished()} {...handlers()} />)

    expect(
      screen.queryByRole("button", { name: "Download everything again" })
    ).toBeNull()
  })
})

describe("the other two endings", () => {
  test("a failure says so, with the advice it came with", () => {
    render(
      <PlaylistSummary
        state={finished({
          status: "failed",
          itemsSaved: undefined,
          itemsTotal: undefined,
          error: "Cliply couldn't prepare its record of this download.",
          suggestion: "Check that Cliply can write to its app data folder."
        })}
        {...handlers()}
      />
    )

    expect(screen.getByText("Playlist download failed")).toBeDefined()
    expect(
      screen.getByText(/Check that Cliply can write to its app data folder/)
    ).toBeDefined()
  })

  test("a cancel keeps what it saved and says the next run resumes", () => {
    markSaved([1, 2, 3])

    render(
      <PlaylistSummary
        state={finished({
          status: "cancelled",
          itemsSaved: 3,
          itemsSkipped: 6
        })}
        {...handlers()}
      />
    )

    expect(screen.getByText("3 of 9 videos saved, 6 skipped.")).toBeDefined()
    expect(screen.getByText(/Videos already saved are kept/)).toBeDefined()
  })
})

describe("getting back to the list", () => {
  test("picking again is always available", () => {
    const on = handlers()
    render(<PlaylistSummary state={finished()} {...on} />)

    fireEvent.click(screen.getByRole("button", { name: "Pick videos again" }))

    expect(on.onPickAgain).toHaveBeenCalled()
  })

  test("the copy uses no em-dash", () => {
    markSaved([1, 2])
    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 2, itemsReused: 1, itemsSkipped: 6 })}
        {...handlers()}
      />
    )

    expect(document.body.textContent).not.toContain("—")
  })
})
