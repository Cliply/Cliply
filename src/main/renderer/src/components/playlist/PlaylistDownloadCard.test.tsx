// @vitest-environment jsdom
//
// the right-hand column, in all three of the states it has to be: pick,
// download, finish. the thing it must never grow is a control a playlist
// cannot honour, and the thing it must never lose is the explanation of why
// those controls are not there.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import type {
  PlaylistDownloadState,
  usePlaylistDownload
} from "@/lib/hooks/usePlaylistDownload"
import { usePlaylistStore } from "@/lib/playlistStore"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { PlaylistDownloadCard } from "./PlaylistDownloadCard"

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

const listing = (entries: PlaylistEntry[]): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "Short talks",
  uploader: "TED",
  count: entries.length,
  listed: entries.length,
  truncated: false,
  entries
})

type Playlist = ReturnType<typeof usePlaylistDownload>

/**
 * a stand-in for the hook. the card is handed the run rather than owning it,
 * because the phase it is in also decides what the list on the left draws
 */
function fakePlaylist(state: Partial<PlaylistDownloadState> = {}) {
  const calls = {
    mutateAsync: vi.fn().mockResolvedValue({ downloadId: "d1" }),
    cancelDownload: vi.fn(),
    reset: vi.fn()
  }

  const playlist = {
    ...calls,
    isPending: false,
    downloadState: { status: "idle", progress: 0, ...state }
  } as unknown as Playlist

  return { playlist, calls }
}

// radix activates a tab on focus rather than on click, so a bare click event
// leaves the panel where it was
const selectAudioTab = () => {
  const tab = screen.getByRole("tab", { name: /Audio Only/ })
  fireEvent.mouseDown(tab)
  fireEvent.focus(tab)
}

beforeEach(() => {
  usePlaylistStore.getState().reset()
  usePlaylistStore
    .getState()
    .setLoadedPlaylist(
      "https://youtube.com/playlist?list=PL123",
      listing([entry(1), entry(2), entry(3, { id: null, unavailable: true })])
    )
})
afterEach(cleanup)

describe("picking", () => {
  test("the button counts what is ticked", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(screen.getByRole("button", { name: "Download 2 videos" })).toBeDefined()
  })

  test("one video is downloaded in the singular", () => {
    usePlaylistStore.getState().toggleIndex(2)

    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(screen.getByRole("button", { name: "Download 1 video" })).toBeDefined()
  })

  test("nothing ticked disables the button rather than sending an empty spec", () => {
    // yt-dlp reads the absence of a selection as "the whole playlist", which
    // is the largest download available
    usePlaylistStore.getState().selectNone()

    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    const button = screen.getByRole("button", { name: /Pick some videos first/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  test("pressing it starts a run", () => {
    const { playlist, calls } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    fireEvent.click(screen.getByRole("button", { name: "Download 2 videos" }))

    expect(calls.mutateAsync).toHaveBeenCalledWith({})
  })

  test("the audio tab keeps its own format and downloads tracks", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    selectAudioTab()

    expect(screen.getByRole("button", { name: "Download 2 tracks" })).toBeDefined()

    // the same three-mode menu the video screen uses, writing to the
    // playlist's own selection rather than to the single-video store
    fireEvent.click(screen.getAllByRole("button", { name: /plays everywhere/ })[0])
    fireEvent.click(screen.getByRole("button", { name: /Original/ }))

    expect(usePlaylistStore.getState().selectedAudioMode).toBe("original")
    expect(useYouTubeStore.getState().selectedAudioMode).toBe("mp3")
  })
})

/**
 * the three controls a playlist cannot honour. a control that is simply
 * missing reads as a bug or as something the user failed to find, so each
 * absence says which, and none of them is reachable on either tab.
 */
describe("what a playlist does not offer", () => {
  test("no trim control, and a line saying why", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(screen.getByText(/No trimming\./)).toBeDefined()
    // the two headings the video screens use for their trim controls
    expect(screen.queryByRole("heading", { name: "Time Range" })).toBeNull()
    expect(
      screen.queryByRole("heading", { name: "Time Range Selection" })
    ).toBeNull()
    expect(screen.queryByText(/Precise Cut/i)).toBeNull()
  })

  test("no dub picker, and a line saying why", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(screen.getByText(/No language picker\./)).toBeDefined()
    expect(screen.queryByRole("heading", { name: "Audio Language" })).toBeNull()
  })

  test("no container choice, and a line saying what it will be", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(screen.getByText(/Every video is saved as MP4/)).toBeDefined()
    expect(screen.queryByText(/MKV/)).toBeNull()
  })

  test("and the audio tab offers none of them either", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    selectAudioTab()

    expect(screen.getByText(/No trimming\./)).toBeDefined()
    expect(screen.getByText(/No language picker\./)).toBeDefined()
    // the two headings the video screens use for their trim controls
    expect(screen.queryByRole("heading", { name: "Time Range" })).toBeNull()
    expect(
      screen.queryByRole("heading", { name: "Time Range Selection" })
    ).toBeNull()
    expect(screen.queryByRole("heading", { name: "Audio Language" })).toBeNull()
  })
})

describe("downloading", () => {
  const running = () =>
    fakePlaylist({
      status: "downloading",
      downloadId: "d1",
      progress: 41,
      itemProgress: 62,
      itemIndex: 4,
      itemsCompleted: 3,
      itemsTotal: 9,
      playlistIndex: 2,
      speed: "6.40MiB/s",
      eta: "00:12"
    })

  test("two bars: where the run is, and where this video is", () => {
    const { playlist } = running()
    render(<PlaylistDownloadCard playlist={playlist} phase="running" />)

    const bars = screen.getAllByRole("progressbar")
    expect(bars).toHaveLength(2)

    expect(screen.getByText("Video 4 of 9")).toBeDefined()
    expect(bars[0].getAttribute("aria-valuenow")).toBe("41")

    expect(screen.getByText("This video")).toBeDefined()
    expect(bars[1].getAttribute("aria-valuenow")).toBe("62")
  })

  test("the run's bar names the video it is on, and this video's carries speed and eta", () => {
    const { playlist } = running()
    render(<PlaylistDownloadCard playlist={playlist} phase="running" />)

    expect(screen.getByText("video 2")).toBeDefined()
    expect(screen.getByText(/6\.40MiB\/s/)).toBeDefined()
    expect(screen.getByText(/ETA 00:12/)).toBeDefined()
  })

  test("one cancel, and it says what a cancel keeps", () => {
    const { playlist, calls } = running()
    render(<PlaylistDownloadCard playlist={playlist} phase="running" />)

    fireEvent.click(screen.getByRole("button", { name: "Cancel remaining" }))

    expect(calls.cancelDownload).toHaveBeenCalled()
    expect(screen.getByText(/Videos already saved are kept/)).toBeDefined()
  })

  test("cancel is inert until the engine has handed back an id", () => {
    const { playlist } = fakePlaylist({ status: "starting", progress: 0 })
    render(<PlaylistDownloadCard playlist={playlist} phase="running" />)

    const button = screen.getByRole("button", { name: "Cancel remaining" })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("Starting up")).toBeDefined()
  })

  test("no quality menu while it runs: the run is already going at one", () => {
    const { playlist } = running()
    render(<PlaylistDownloadCard playlist={playlist} phase="running" />)

    expect(screen.queryByText("Quality")).toBeNull()
    expect(screen.queryByRole("tab")).toBeNull()
  })
})

describe("finished", () => {
  test("hands the summary a retry that re-ticks exactly the failures", () => {
    const store = usePlaylistStore.getState()
    store.setItemStatus(1, { state: "saved", progress: 100 })
    store.setItemStatus(2, { state: "skipped", progress: 0 })

    const { playlist, calls } = fakePlaylist({
      status: "completed",
      progress: 100,
      itemsSaved: 1,
      itemsSkipped: 1,
      itemsTotal: 2
    })
    render(<PlaylistDownloadCard playlist={playlist} phase="finished" />)

    fireEvent.click(screen.getByRole("button", { name: "Retry the 1 that failed" }))

    expect([...usePlaylistStore.getState().selectedIndices]).toEqual([2])
    expect(calls.mutateAsync).toHaveBeenCalledWith({})
  })

  test("picking again puts the checkboxes back", () => {
    usePlaylistStore.getState().setItemStatus(1, { state: "saved", progress: 100 })

    const { playlist, calls } = fakePlaylist({ status: "completed", progress: 100 })
    render(<PlaylistDownloadCard playlist={playlist} phase="finished" />)

    fireEvent.click(screen.getByRole("button", { name: "Pick videos again" }))

    expect(usePlaylistStore.getState().itemStatus.size).toBe(0)
    expect(calls.reset).toHaveBeenCalled()
  })
})

describe("the copy", () => {
  test("uses no em-dash in any of the three states", () => {
    for (const phase of ["picking", "running", "finished"] as const) {
      cleanup()
      const { playlist } = fakePlaylist({
        status: phase === "finished" ? "completed" : "downloading",
        itemsSaved: 1,
        itemsTotal: 2,
        itemsSkipped: 1
      })
      render(<PlaylistDownloadCard playlist={playlist} phase={phase} />)
      expect(document.body.textContent).not.toContain("—")
    }
  })
})
