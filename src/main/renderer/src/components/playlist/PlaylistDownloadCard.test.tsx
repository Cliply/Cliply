// @vitest-environment jsdom
//
// the right-hand column, in all three of the states it has to be: pick,
// download, finish. the thing it must never grow is a control a playlist
// cannot honour, and the thing it must never say is that those controls are
// missing: each tab carries one sentence on how a run works instead.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import { en } from "@/lib/i18n/en"
import type {
  PlaylistDownloadState,
  usePlaylistDownload
} from "@/lib/hooks/usePlaylistDownload"
import { usePlaylistStore } from "@/lib/playlistStore"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { PlaylistDownloadCard } from "./PlaylistDownloadCard"

const entry = (
  index: number,
  overrides: Partial<PlaylistEntry> = {}
): PlaylistEntry => ({
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

    expect(
      screen.getByRole("button", { name: "Download 2 videos" })
    ).toBeDefined()
  })

  test("one video is downloaded in the singular", () => {
    usePlaylistStore.getState().toggleIndex(2)

    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(
      screen.getByRole("button", { name: "Download 1 video" })
    ).toBeDefined()
  })

  test("nothing ticked disables the button rather than sending an empty spec", () => {
    // yt-dlp reads the absence of a selection as "the whole playlist", which
    // is the largest download available
    usePlaylistStore.getState().selectNone()

    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    const button = screen.getByRole("button", {
      name: en["playlist.pickVideosFirst"]
    })
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

    expect(
      screen.getByRole("button", { name: "Download 2 tracks" })
    ).toBeDefined()

    // the same three-mode menu the video screen uses, writing to the
    // playlist's own selection rather than to the single-video store
    fireEvent.click(
      screen.getAllByRole("button", { name: /plays everywhere/ })[0]
    )
    fireEvent.click(screen.getByRole("button", { name: /Original/ }))

    expect(usePlaylistStore.getState().selectedAudioMode).toBe("original")
    expect(useYouTubeStore.getState().selectedAudioMode).toBe("mp3")
  })
})

/**
 * the three controls a playlist cannot honour are still absent from both tabs.
 * what changed is that the card no longer lists them: the user's words were
 * "we do not need to tell what we cannot do", so each tab carries one short
 * sentence saying how a run works and nothing about what it is missing.
 */
describe("what a playlist does not offer", () => {
  test("no trim control on either tab", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    // the two headings the video screens use for their trim controls
    expect(screen.queryByRole("heading", { name: "Time Range" })).toBeNull()
    expect(
      screen.queryByRole("heading", { name: "Time Range Selection" })
    ).toBeNull()
    expect(screen.queryByText(/Precise Cut/i)).toBeNull()

    selectAudioTab()

    expect(screen.queryByRole("heading", { name: "Time Range" })).toBeNull()
    expect(
      screen.queryByRole("heading", { name: "Time Range Selection" })
    ).toBeNull()
  })

  test("no dub picker on either tab", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(screen.queryByRole("heading", { name: "Audio Language" })).toBeNull()

    selectAudioTab()

    expect(screen.queryByRole("heading", { name: "Audio Language" })).toBeNull()
  })

  test("no container choice", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(screen.queryByText(/MKV/)).toBeNull()
  })
})

describe("what each tab says about a run", () => {
  test("the video tab says it in one sentence, under the picker", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    expect(
      screen.getByText(
        "Each video is saved as MP4 at its best quality up to 1080p, with its original audio."
      )
    ).toBeDefined()
  })

  test("and the audio tab in one of its own", () => {
    const { playlist } = fakePlaylist()
    render(<PlaylistDownloadCard playlist={playlist} phase="picking" />)

    selectAudioTab()

    expect(screen.getByText(en["playlist.audioNote"])).toBeDefined()
  })

  /**
   * the line the user actually objected to. a card that spends three bullets
   * on controls it does not have reads as a list of apologies, and none of it
   * is anything they can act on
   */
  test("no screen tells the user what a playlist cannot do", () => {
    for (const phase of ["picking", "running", "finished"] as const) {
      for (const audio of [false, true]) {
        cleanup()

        const { playlist } = fakePlaylist({
          status: phase === "finished" ? "completed" : "downloading",
          itemsSaved: 1,
          itemsSkipped: 1,
          itemsTotal: 2
        })
        render(<PlaylistDownloadCard playlist={playlist} phase={phase} />)

        if (audio && phase === "picking") selectAudioTab()

        const text = document.body.textContent ?? ""

        expect(text).not.toContain("No trimming")
        expect(text).not.toContain("No language picker")
        expect(text).not.toMatch(/\bcannot\b/)
      }
    }
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

    expect(screen.getByText(en["playlist.thisVideo"])).toBeDefined()
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

    fireEvent.click(
      screen.getByRole("button", { name: en["playlist.cancelRemaining"] })
    )

    expect(calls.cancelDownload).toHaveBeenCalled()
    expect(screen.getByText(/Videos already saved are kept/)).toBeDefined()
  })

  test("cancel is inert until the engine has handed back an id", () => {
    const { playlist } = fakePlaylist({ status: "starting", progress: 0 })
    render(<PlaylistDownloadCard playlist={playlist} phase="running" />)

    const button = screen.getByRole("button", {
      name: en["playlist.cancelRemaining"]
    })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(en["progress.startingUp"])).toBeDefined()
  })

  test("no quality menu while it runs: the run is already going at one", () => {
    const { playlist } = running()
    render(<PlaylistDownloadCard playlist={playlist} phase="running" />)

    expect(screen.queryByText(en["playlist.qualityHeading"])).toBeNull()
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

    fireEvent.click(
      screen.getByRole("button", { name: "Retry the 1 that failed" })
    )

    expect([...usePlaylistStore.getState().selectedIndices]).toEqual([2])
    expect(calls.mutateAsync).toHaveBeenCalledWith({})
  })

  test("picking again puts the checkboxes back", () => {
    usePlaylistStore
      .getState()
      .setItemStatus(1, { state: "saved", progress: 100 })

    const { playlist, calls } = fakePlaylist({
      status: "completed",
      progress: 100
    })
    render(<PlaylistDownloadCard playlist={playlist} phase="finished" />)

    fireEvent.click(
      screen.getByRole("button", { name: en["playlist.pickAgain"] })
    )

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
