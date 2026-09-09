// @vitest-environment jsdom
//
// which of the two youtube things a submitted link is sent to.
//
// a link that names both is the third case, and it is asked about rather than
// routed: `useMediaSearch.mixed.test.tsx` owns it. what is left here is the two
// unambiguous shapes, and the rule that a lookup in flight never writes over a
// newer one.

import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"

import type { PlaylistInfoResponse, VideoInfoResponse } from "@/lib/api"

const mocks = vi.hoisted(() => ({
  getVideoInfo: vi.fn(),
  getPlaylistInfo: vi.fn(),
  successToast: vi.fn(),
  errorToast: vi.fn()
}))

vi.mock("@/lib/api", () => {
  class DownloadError extends Error {
    details?: string
    category?: string
  }

  return {
    DownloadError,
    videoApi: { getVideoInfo: (url: string) => mocks.getVideoInfo(url) },
    playlistApi: {
      getPlaylistInfo: (url: string) => mocks.getPlaylistInfo(url)
    },
    pinterestApi: { getInfo: vi.fn() },
    tiktokApi: { getInfo: vi.fn() }
  }
})

vi.mock("sonner", () => ({
  toast: {
    success: mocks.successToast,
    error: mocks.errorToast,
    info: vi.fn()
  }
}))

import { useMediaSearch } from "./useMediaSearch"
import { useMixedLinkStore } from "@/lib/mixedLinkStore"
import { usePlaylistStore } from "@/lib/playlistStore"
import { useAppStore } from "@/lib/store"
import { useYouTubeStore } from "@/lib/youtubeStore"

const videoInfo: VideoInfoResponse = {
  title: "a video",
  duration: 60,
  duration_string: "1:00",
  uploader: "someone",
  quality_tiers: [],
  audio_tracks: []
}

const playlistInfo: PlaylistInfoResponse = {
  playlist_id: "PL123",
  title: "a playlist",
  uploader: "someone",
  count: 2,
  listed: 2,
  truncated: false,
  entries: [
    {
      index: 1,
      id: "video1",
      title: "one",
      duration: 60,
      duration_string: "1:00",
      thumbnail: null,
      unavailable: false
    },
    {
      index: 2,
      id: "video2",
      title: "two",
      duration: 60,
      duration_string: "1:00",
      thumbnail: null,
      unavailable: false
    }
  ]
}

async function submit(url: string) {
  const { result, unmount } = renderHook(() => useMediaSearch("youtube"))

  await act(async () => {
    await result.current.onSubmit({ url })
  })

  unmount()
}

/**
 * start a submit without waiting for it, so two can be in flight at once
 *
 * the hook instance stays mounted until the caller unmounts it: a lookup whose
 * view went away is a different case from two lookups racing.
 */
function submitConcurrently(url: string) {
  const { result, unmount } = renderHook(() => useMediaSearch("youtube"))
  const settled = result.current.onSubmit({ url })

  return { settled, unmount, result }
}

/** a lookup whose answer the test decides the timing of */
function deferredListing() {
  let resolve!: (info: PlaylistInfoResponse) => void
  let reject!: (error: Error) => void
  const promise = new Promise<PlaylistInfoResponse>((res, rej) => {
    resolve = res
    reject = rej
  })

  mocks.getPlaylistInfo.mockReturnValueOnce(promise)

  return { resolve, reject }
}

const listingOf = (id: string): PlaylistInfoResponse => ({
  ...playlistInfo,
  playlist_id: id,
  title: `playlist ${id}`
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  usePlaylistStore.getState().reset()
  useMixedLinkStore.getState().reset()
  useYouTubeStore.getState().reset()
  useAppStore.getState().setShowMediaDetails(false)
  mocks.getVideoInfo.mockResolvedValue(videoInfo)
  mocks.getPlaylistInfo.mockResolvedValue(playlistInfo)
})

describe("what the youtube box does with a link", () => {
  test("a playlist link is listed rather than looked up as a video", async () => {
    await submit("https://www.youtube.com/playlist?list=PL123")

    expect(mocks.getPlaylistInfo).toHaveBeenCalledWith(
      "https://www.youtube.com/playlist?list=PL123"
    )
    expect(mocks.getVideoInfo).not.toHaveBeenCalled()

    const state = usePlaylistStore.getState()
    expect(state.playlistInfo?.playlist_id).toBe("PL123")
    // everything available opens ticked
    expect([...state.selectedIndices]).toEqual([1, 2])
    expect(useAppStore.getState().showMediaDetails).toBe(true)
  })

  // main refuses a link with no scheme, so one is put back before it is sent
  test("a protocol-less playlist link is given a scheme", async () => {
    await submit("youtube.com/playlist?list=PL123")

    expect(mocks.getPlaylistInfo).toHaveBeenCalledWith(
      "https://youtube.com/playlist?list=PL123"
    )
  })

  /**
   * this used to assert that a link carrying both silently downloaded the
   * single video, which is what Cliply had always done with one. it does not
   * any more: the listing is fetched so the user can be asked which of the two
   * they meant, and neither view opens until they answer. the flow itself is
   * covered in `useMediaSearch.mixed.test.tsx`; what is pinned here is that the
   * two unambiguous shapes on either side of it were left alone.
   */
  test("a link carrying both is asked about rather than routed", async () => {
    await submit("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123")

    expect(mocks.getVideoInfo).not.toHaveBeenCalled()
    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(useYouTubeStore.getState().videoInfo).toBeNull()
    expect(useAppStore.getState().showMediaDetails).toBe(false)
  })

  test("a plain video link is untouched", async () => {
    await submit("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    expect(mocks.getVideoInfo).toHaveBeenCalledTimes(1)
    expect(mocks.getPlaylistInfo).not.toHaveBeenCalled()
  })

  // one answer to "what did I just paste" at a time, whichever way round
  test("loading a playlist drops the video that was on screen", async () => {
    await submit("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()

    await submit("https://www.youtube.com/playlist?list=PL123")

    expect(useYouTubeStore.getState().videoInfo).toBeNull()
    expect(usePlaylistStore.getState().playlistInfo).not.toBeNull()
  })

  test("loading a video drops the playlist that was on screen", async () => {
    await submit("https://www.youtube.com/playlist?list=PL123")
    expect(usePlaylistStore.getState().playlistInfo).not.toBeNull()

    await submit("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()
  })

  test("a listing that fails says so and shows nothing", async () => {
    mocks.getPlaylistInfo.mockRejectedValueOnce(
      new Error("This playlist is private.")
    )

    await submit("https://www.youtube.com/playlist?list=PL123")

    expect(mocks.errorToast).toHaveBeenCalledTimes(1)
    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(usePlaylistStore.getState().isLoadingPlaylistInfo).toBe(false)
    expect(useAppStore.getState().showMediaDetails).toBe(false)
  })

  test("a listing that fails does not take the video on screen with it", async () => {
    await submit("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    mocks.getPlaylistInfo.mockRejectedValueOnce(
      new Error("This playlist is private.")
    )

    await submit("https://www.youtube.com/playlist?list=PL123")

    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()
  })

  test("clearing the box clears both of the things it can hold", async () => {
    await submit("https://www.youtube.com/playlist?list=PL123")

    const { result, unmount } = renderHook(() => useMediaSearch("youtube"))
    await act(async () => {
      result.current.handleClear()
    })
    unmount()

    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(usePlaylistStore.getState().url).toBe("")
  })
})

/**
 * the url and the listing are one fact, and a lookup takes a second or two.
 *
 * main takes the link and the playlist id as two separate fields and
 * cross-checks neither: the link goes to the engine and the id names the resume
 * archive. so a url that arrives in the store ahead of its listing, or without
 * one, is not a cosmetic problem - it is one playlist's positions downloaded
 * against another playlist's link.
 */
describe("two lookups racing", () => {
  test("a failed replacement leaves the loaded playlist whole", async () => {
    await submit("https://www.youtube.com/playlist?list=PLGOOD")
    const loaded = usePlaylistStore.getState()

    mocks.getPlaylistInfo.mockRejectedValueOnce(new Error("This playlist is private."))
    await submit("https://www.youtube.com/playlist?list=PLBAD")

    const after = usePlaylistStore.getState()
    // the url the failed lookup asked for is nowhere in the store
    expect(after.url).toBe("https://www.youtube.com/playlist?list=PLGOOD")
    expect(after.url).toBe(loaded.url)
    expect(after.playlistInfo).toBe(loaded.playlistInfo)
    expect([...after.selectedIndices]).toEqual([...loaded.selectedIndices])
  })

  test("the newest link wins even when its answer comes back first", async () => {
    const first = deferredListing()
    const a = submitConcurrently("https://www.youtube.com/playlist?list=PLFIRST")

    const second = deferredListing()
    const b = submitConcurrently("https://www.youtube.com/playlist?list=PLSECOND")

    // the second link answers first, then the first one finally lands
    await act(async () => {
      second.resolve(listingOf("PLSECOND"))
      await b.settled
    })
    await act(async () => {
      first.resolve(listingOf("PLFIRST"))
      await a.settled
    })

    const state = usePlaylistStore.getState()
    expect(state.url).toBe("https://www.youtube.com/playlist?list=PLSECOND")
    expect(state.playlistInfo?.playlist_id).toBe("PLSECOND")

    a.unmount()
    b.unmount()
  })

  test("a stale answer cannot repopulate a view the user cleared", async () => {
    const pending = deferredListing()
    const a = submitConcurrently("https://www.youtube.com/playlist?list=PL123")

    await act(async () => {
      a.result.current.handleClear()
    })

    await act(async () => {
      pending.resolve(playlistInfo)
      await a.settled
    })

    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(usePlaylistStore.getState().url).toBe("")
    expect(usePlaylistStore.getState().isLoadingPlaylistInfo).toBe(false)

    a.unmount()
  })

  test("a stale failure does not shout over the lookup that replaced it", async () => {
    const first = deferredListing()
    const a = submitConcurrently("https://www.youtube.com/playlist?list=PLFIRST")

    const second = deferredListing()
    const b = submitConcurrently("https://www.youtube.com/playlist?list=PLSECOND")

    await act(async () => {
      second.resolve(listingOf("PLSECOND"))
      await b.settled
    })
    await act(async () => {
      first.reject(new Error("This playlist is private."))
      await a.settled
    })

    expect(mocks.errorToast).not.toHaveBeenCalled()
    expect(usePlaylistStore.getState().playlistInfo?.playlist_id).toBe("PLSECOND")
    // the spinner belongs to the newest lookup, which finished
    expect(usePlaylistStore.getState().isLoadingPlaylistInfo).toBe(false)

    a.unmount()
    b.unmount()
  })

  test("a failed playlist lookup leaves the single video's url alone", async () => {
    await submit("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    expect(useYouTubeStore.getState().url).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )

    mocks.getPlaylistInfo.mockRejectedValueOnce(new Error("This playlist is private."))
    await submit("https://www.youtube.com/playlist?list=PL123")

    // the video view is still on screen, and it would download its own link
    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()
    expect(useYouTubeStore.getState().url).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )
  })
})

describe("the box after a playlist loads", () => {
  test("both stores end up on the link that actually loaded", async () => {
    await submit("https://www.youtube.com/playlist?list=PL123")

    // the store's url is the resolved one, and the box shows the same link
    expect(usePlaylistStore.getState().url).toBe(
      "https://www.youtube.com/playlist?list=PL123"
    )
    expect(useYouTubeStore.getState().url).toBe(
      "https://www.youtube.com/playlist?list=PL123"
    )
  })
})
