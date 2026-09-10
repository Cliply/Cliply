/**
 * the playlist's own state, and the two things it must never get wrong.
 *
 * a selection describes one particular playlist, so it cannot survive a new
 * listing - sending a stale one downloads the wrong videos, under the previous
 * playlist's positions. and an unavailable row cannot be ticked by any route,
 * including select-all: each attempt at a deleted video spends one of yt-dlp's
 * five allowed failures before it gives up on the rest of the playlist.
 */

import { beforeEach, describe, expect, test } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import {
  PLAYLIST_DEFAULT_CEILING,
  isSelectableEntry,
  usePlaylistStore
} from "@/lib/playlistStore"

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

const gone = (index: number): PlaylistEntry =>
  entry(index, {
    id: null,
    title: "Unknown",
    duration: null,
    duration_string: null,
    unavailable: true
  })

const listing = (
  entries: PlaylistEntry[],
  overrides: Partial<PlaylistInfoResponse> = {}
): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "a playlist",
  uploader: "someone",
  count: entries.length,
  listed: entries.length,
  truncated: false,
  entries,
  ...overrides
})

const selected = () => [...usePlaylistStore.getState().selectedIndices].sort((a, b) => a - b)

const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PL123"

const load = (
  entries: PlaylistEntry[],
  url = PLAYLIST_URL,
  overrides: Partial<PlaylistInfoResponse> = {}
) => usePlaylistStore.getState().setLoadedPlaylist(url, listing(entries, overrides))

beforeEach(() => usePlaylistStore.getState().reset())

describe("setLoadedPlaylist", () => {
  test("ticks every row that can be downloaded and no row that cannot", () => {
    load([entry(1), gone(2), entry(3)])

    expect(selected()).toEqual([1, 3])
  })

  /**
   * main takes the link and the playlist id as two separate fields and
   * cross-checks neither, so the two have to be written together or one
   * playlist's positions get sent against another playlist's link
   */
  test("the url and the listing land in the same write", () => {
    load([entry(1)], "https://www.youtube.com/playlist?list=PLABC")

    const state = usePlaylistStore.getState()
    expect(state.url).toBe("https://www.youtube.com/playlist?list=PLABC")
    expect(state.playlistInfo?.playlist_id).toBe("PL123")
  })

  /**
   * the same reason youtubeStore.setVideoInfo drops the previous video's tier:
   * position 3 in this playlist is a different video from position 3 in the
   * last one, and nothing on screen would say so
   */
  test("a new playlist never inherits the previous one's selection", () => {
    const store = usePlaylistStore.getState()

    load([entry(1), entry(2), entry(3)])
    store.selectNone()
    store.toggleIndex(3)
    expect(selected()).toEqual([3])

    load([entry(1), gone(2), gone(3)], PLAYLIST_URL, { playlist_id: "PL456" })

    expect(selected()).toEqual([1])
  })

  test("a new playlist drops the previous run's per-row badges", () => {
    load([entry(1), entry(2)])
    usePlaylistStore.getState().setItemStatus(1, { state: "saved", progress: 100 })

    load([entry(1), entry(2)], PLAYLIST_URL, { playlist_id: "PL456" })

    expect(usePlaylistStore.getState().itemStatus.size).toBe(0)
  })

  test("reset is the only way to empty the view, and it empties both halves", () => {
    load([entry(1), entry(2)])
    usePlaylistStore.getState().reset()

    expect(selected()).toEqual([])
    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(usePlaylistStore.getState().url).toBe("")
  })
})

/**
 * re-pasting the link that is already on screen is a refresh, not a new
 * playlist.
 *
 * every lookup returns a fresh response object, so object identity says
 * "different playlist" every single time. the same link and the same playlist
 * id is the same playlist, and clearing the ticks and the badges for it throws
 * away a selection the user made and a run that may still be going.
 */
describe("re-loading the playlist already on screen", () => {
  test("keeps the selection the user made", () => {
    const store = usePlaylistStore.getState()

    load([entry(1), entry(2), entry(3)])
    store.selectNone()
    store.toggleIndex(2)

    load([entry(1), entry(2), entry(3)])

    expect(selected()).toEqual([2])
  })

  test("keeps the badges of a run that is still going", () => {
    load([entry(1), entry(2)])
    usePlaylistStore
      .getState()
      .setItemStatus(1, { state: "saved", progress: 100, height: 720 })

    load([entry(1), entry(2)])

    expect(usePlaylistStore.getState().itemStatus.get(1)).toEqual({
      state: "saved",
      progress: 100,
      height: 720
    })
  })

  test("takes the newer listing, so a refresh is still a refresh", () => {
    load([entry(1), entry(2)])
    load([entry(1), entry(2), entry(3)], PLAYLIST_URL, { count: 3, listed: 3 })

    expect(usePlaylistStore.getState().playlistInfo?.listed).toBe(3)
    // a row that was not there before is not ticked behind the user's back:
    // what is preserved is the selection they made, not a new default
    expect(selected()).toEqual([1, 2])
  })

  test("drops a row the refresh says can no longer be downloaded", () => {
    load([entry(1), entry(2), entry(3)])
    expect(selected()).toEqual([1, 2, 3])

    // position 2 went private between the two lookups
    load([entry(1), gone(2), entry(3)])

    expect(selected()).toEqual([1, 3])
  })

  test("the same id under a different link is still a different playlist", () => {
    const store = usePlaylistStore.getState()

    load([entry(1), entry(2)])
    store.selectNone()

    // main takes the link and the id as two separate fields and cross-checks
    // neither, so both halves have to match for this to be the same view
    load([entry(1), entry(2)], "https://www.youtube.com/playlist?list=PL123&x=1")

    expect(selected()).toEqual([1, 2])
  })
})

/**
 * a listing takes a second or two to arrive, and the user can submit another
 * link or clear the box inside that window. the token is what lets the loader
 * tell an answer it still wants from one it has moved on from.
 */
describe("lookup tokens", () => {
  test("only the newest lookup is current", () => {
    const store = usePlaylistStore.getState()

    const first = store.beginLookup()
    expect(store.isCurrentLookup(first)).toBe(true)

    const second = store.beginLookup()
    expect(store.isCurrentLookup(second)).toBe(true)
    expect(store.isCurrentLookup(first)).toBe(false)
  })

  test("clearing the view abandons the lookup that was in flight", () => {
    const store = usePlaylistStore.getState()

    const token = store.beginLookup()
    store.reset()

    // a listing that arrives now cannot repopulate the screen just emptied
    expect(store.isCurrentLookup(token)).toBe(false)
  })

  test("a token is never handed out twice, even across a reset", () => {
    const store = usePlaylistStore.getState()
    const seen = new Set<number>()

    for (let round = 0; round < 3; round++) {
      seen.add(store.beginLookup())
      store.reset()
      seen.add(store.beginLookup())
    }

    expect(seen.size).toBe(6)
  })
})

describe("selection", () => {
  beforeEach(() => {
    load([entry(1), gone(2), entry(3)])
  })

  test("a tick is a toggle", () => {
    const store = usePlaylistStore.getState()

    store.toggleIndex(1)
    expect(selected()).toEqual([3])

    store.toggleIndex(1)
    expect(selected()).toEqual([1, 3])
  })

  test("an unavailable row cannot be ticked by hand", () => {
    usePlaylistStore.getState().toggleIndex(2)

    expect(selected()).toEqual([1, 3])
  })

  test("select-all does not tick an unavailable row either", () => {
    const store = usePlaylistStore.getState()

    store.selectNone()
    expect(selected()).toEqual([])

    store.selectAll()
    expect(selected()).toEqual([1, 3])
  })

  test("a position the listing does not hold cannot be ticked", () => {
    usePlaylistStore.getState().toggleIndex(99)

    expect(selected()).toEqual([1, 3])
  })

  /**
   * the id travels with the selection and main refuses a request without one -
   * it is what the resume archive is matched on - so a row that has no id is
   * not something we can ask for, whatever its `unavailable` flag says
   */
  test("a row with no video id is not selectable", () => {
    load([entry(1), entry(2, { id: null })])

    expect(selected()).toEqual([1])
    expect(isSelectableEntry(entry(2, { id: null }))).toBe(false)
  })
})

describe("the choices that are one per playlist", () => {
  test("open on 1080p, mp3 and the video tab", () => {
    const state = usePlaylistStore.getState()

    expect(state.selectedCeiling).toBe(PLAYLIST_DEFAULT_CEILING)
    expect(PLAYLIST_DEFAULT_CEILING).toBe(1080)
    expect(state.selectedAudioMode).toBe("mp3")
    expect(state.activeTab).toBe("video")
  })

  test("a new listing does not move the ceiling the user picked", () => {
    const store = usePlaylistStore.getState()

    store.setSelectedCeiling(2160)
    load([entry(1)])

    expect(usePlaylistStore.getState().selectedCeiling).toBe(2160)
  })
})

describe("per-row status", () => {
  test("settling only touches the row that was in flight", () => {
    const store = usePlaylistStore.getState()

    store.setItemStatus(1, { state: "saved", progress: 100 })
    store.setItemStatus(2, { state: "downloading", progress: 62 })
    store.setItemStatus(3, { state: "pending", progress: 0 })

    store.settleInFlightItems("skipped")

    const status = usePlaylistStore.getState().itemStatus
    expect(status.get(1)?.state).toBe("saved")
    expect(status.get(2)?.state).toBe("skipped")
    expect(status.get(3)?.state).toBe("pending")
  })

  test("each write is a new map, so a subscriber sees it", () => {
    const store = usePlaylistStore.getState()
    const before = usePlaylistStore.getState().itemStatus

    store.setItemStatus(1, { state: "downloading", progress: 10 })

    expect(usePlaylistStore.getState().itemStatus).not.toBe(before)
  })
})

describe("reset", () => {
  test("puts every field back where it started", () => {
    const store = usePlaylistStore.getState()

    load([entry(1)])
    store.setIsLoadingPlaylistInfo(true)
    store.setSelectedCeiling(360)
    store.setSelectedAudioMode("m4a")
    store.setActiveTab("audio")
    store.setItemStatus(1, { state: "downloading", progress: 5 })
    store.setIsDownloading(true)

    store.reset()

    const state = usePlaylistStore.getState()
    expect(state.url).toBe("")
    expect(state.playlistInfo).toBeNull()
    expect(state.isLoadingPlaylistInfo).toBe(false)
    expect(state.selectedIndices.size).toBe(0)
    expect(state.selectedCeiling).toBe(PLAYLIST_DEFAULT_CEILING)
    expect(state.selectedAudioMode).toBe("mp3")
    expect(state.activeTab).toBe("video")
    expect(state.itemStatus.size).toBe(0)
    expect(state.isDownloading).toBe(false)
  })
})
