// @vitest-environment jsdom
//
// the link that names two things at once.
//
// `watch?v=…&list=…` is what youtube hands out from inside a playlist, and it
// is genuinely ambiguous: it points at one video *and* at the playlist holding
// it. Cliply has always quietly taken the video. this asks instead, and what is
// under test is mostly what the asking must not cost: a plain video link never
// sees the question, a listing that fails never blocks the video, and choosing
// the playlist never pays for a second lookup.

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
import { useMixedLinkStore } from "@/lib/stores/mixedLinkStore"
import { usePlaylistStore } from "@/lib/stores/playlistStore"
import { useAppStore } from "@/lib/stores/store"
import { useYouTubeStore } from "@/lib/stores/youtubeStore"

const MIXED = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123"
const MIXED_SHORT = "https://youtu.be/dQw4w9WgXcQ?list=PL123"
const PLAIN_VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

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
  title: "Short talks to watch during your coffee break",
  uploader: "TED",
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

const prompt = () => useMixedLinkStore.getState().question

/** answer the prompt the way the dialog's two buttons do */
async function choose(choice: "video" | "playlist") {
  await act(async () => {
    useMixedLinkStore.getState().answer(choice)
    // the video branch is a fetch the answer does not wait for
    await Promise.resolve()
    await Promise.resolve()
  })
}

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

describe("which links are asked about", () => {
  test("a link carrying both is asked about, once its playlist has a name", async () => {
    await submit(MIXED)

    // the listing comes first so the question can name the playlist and its
    // real size, which is the whole reason the question is worth asking
    expect(mocks.getPlaylistInfo).toHaveBeenCalledWith(MIXED)
    expect(prompt()?.info.title).toBe(
      "Short talks to watch during your coffee break"
    )

    // and nothing is decided yet: no video looked up, no playlist on screen
    expect(mocks.getVideoInfo).not.toHaveBeenCalled()
    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(useAppStore.getState().showMediaDetails).toBe(false)
  })

  test("the share-sheet form of the same link is asked about too", async () => {
    await submit(MIXED_SHORT)

    expect(mocks.getPlaylistInfo).toHaveBeenCalledWith(MIXED_SHORT)
    expect(prompt()).not.toBeNull()
  })

  test("a plain video link is never asked about, and costs no listing", async () => {
    await submit(PLAIN_VIDEO)

    expect(prompt()).toBeNull()
    expect(mocks.getPlaylistInfo).not.toHaveBeenCalled()
    expect(mocks.getVideoInfo).toHaveBeenCalledTimes(1)
    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()
  })

  test("a plain playlist link is never asked about either", async () => {
    await submit("https://www.youtube.com/playlist?list=PL123")

    expect(prompt()).toBeNull()
    expect(usePlaylistStore.getState().playlistInfo).not.toBeNull()
  })

  test("the spinner is not left running under the question", async () => {
    await submit(MIXED)

    expect(usePlaylistStore.getState().isLoadingPlaylistInfo).toBe(false)
  })
})

describe("what the two answers do", () => {
  test('"Just this video" is exactly the single video Cliply always downloaded', async () => {
    await submit(MIXED)
    await choose("video")

    expect(mocks.getVideoInfo).toHaveBeenCalledTimes(1)
    expect(mocks.getVideoInfo).toHaveBeenCalledWith(MIXED)
    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()
    expect(useYouTubeStore.getState().url).toBe(MIXED)
    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(useAppStore.getState().showMediaDetails).toBe(true)
    expect(prompt()).toBeNull()
  })

  test('"All N videos" opens the playlist on the listing already in hand', async () => {
    await submit(MIXED)
    await choose("playlist")

    // the listing was paid for before the question. asking for it again would
    // be a second second of waiting for an answer we are holding
    expect(mocks.getPlaylistInfo).toHaveBeenCalledTimes(1)
    expect(usePlaylistStore.getState().playlistInfo?.playlist_id).toBe("PL123")
    expect(usePlaylistStore.getState().url).toBe(MIXED)
    // everything available opens ticked, as it does for a plain playlist link
    expect([...usePlaylistStore.getState().selectedIndices]).toEqual([1, 2])
    expect(useYouTubeStore.getState().videoInfo).toBeNull()
    expect(useAppStore.getState().showMediaDetails).toBe(true)
    expect(prompt()).toBeNull()
  })

  test("dismissing leaves the screen exactly as the paste found it", async () => {
    await submit(MIXED)

    await act(async () => {
      useMixedLinkStore.getState().dismiss()
    })

    expect(prompt()).toBeNull()
    expect(mocks.getVideoInfo).not.toHaveBeenCalled()
    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(useAppStore.getState().showMediaDetails).toBe(false)
  })
})

describe("a listing that does not arrive", () => {
  test("degrades to the video rather than blocking on it", async () => {
    mocks.getPlaylistInfo.mockRejectedValueOnce(
      new Error("This playlist is private.")
    )

    await submit(MIXED)

    expect(prompt()).toBeNull()
    expect(mocks.getVideoInfo).toHaveBeenCalledTimes(1)
    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()
    expect(useAppStore.getState().showMediaDetails).toBe(true)
    expect(usePlaylistStore.getState().isLoadingPlaylistInfo).toBe(false)
  })

  test("says nothing about a lookup the user never asked for", async () => {
    mocks.getPlaylistInfo.mockRejectedValueOnce(
      new Error("This playlist is private.")
    )

    await submit(MIXED)

    // the user pasted a video link and got their video. an error toast over it
    // would be about an enrichment they did not request
    expect(mocks.errorToast).not.toHaveBeenCalled()
  })

  test("an empty listing has no second choice to offer", async () => {
    mocks.getPlaylistInfo.mockResolvedValueOnce({
      ...playlistInfo,
      count: 0,
      listed: 0,
      entries: []
    })

    await submit(MIXED)

    expect(prompt()).toBeNull()
    expect(mocks.getVideoInfo).toHaveBeenCalledTimes(1)
  })
})

describe("the answer is remembered for the session, per link", () => {
  test("the same link is not asked about twice", async () => {
    await submit(MIXED)
    await choose("video")

    await submit(MIXED)

    expect(prompt()).toBeNull()
    expect(mocks.getVideoInfo).toHaveBeenCalledTimes(2)
    // and the listing that made the question answerable is not paid for again
    expect(mocks.getPlaylistInfo).toHaveBeenCalledTimes(1)
  })

  test("a remembered playlist answer goes straight to the playlist", async () => {
    await submit(MIXED)
    await choose("playlist")

    usePlaylistStore.getState().reset()
    await submit(MIXED)

    expect(prompt()).toBeNull()
    expect(mocks.getVideoInfo).not.toHaveBeenCalled()
    expect(usePlaylistStore.getState().playlistInfo?.playlist_id).toBe("PL123")
  })

  test("the two shapes of one ambiguous link share their answer", async () => {
    await submit(MIXED)
    await choose("video")

    await submit(MIXED_SHORT)

    expect(prompt()).toBeNull()
    expect(mocks.getVideoInfo).toHaveBeenCalledTimes(2)
  })

  test("another link is its own question", async () => {
    await submit(MIXED)
    await choose("video")

    await submit("https://www.youtube.com/watch?v=otherVid&list=PLOTHER")

    expect(prompt()).not.toBeNull()
  })

  test("a dismissed question is asked again", async () => {
    await submit(MIXED)
    await act(async () => {
      useMixedLinkStore.getState().dismiss()
    })

    await submit(MIXED)

    expect(prompt()).not.toBeNull()
  })
})

/**
 * the lookup token is the same one a plain playlist link answers to.
 *
 * main takes the link and the playlist id as two separate fields and
 * cross-checks neither, so a listing written under a url the user has already
 * replaced is one playlist's positions downloaded against another's link. the
 * question sits between the listing and the write, which only widens the window.
 */
describe("a question about a link the user has moved on from", () => {
  test("a stale listing never gets to ask", async () => {
    let resolve!: (info: PlaylistInfoResponse) => void
    mocks.getPlaylistInfo.mockReturnValueOnce(
      new Promise<PlaylistInfoResponse>((res) => {
        resolve = res
      })
    )

    const { result, unmount } = renderHook(() => useMediaSearch("youtube"))
    const pending = result.current.onSubmit({ url: MIXED })

    // the user gives up on it and clears the box
    await act(async () => {
      result.current.handleClear()
    })

    await act(async () => {
      resolve(playlistInfo)
      await pending
    })
    unmount()

    expect(prompt()).toBeNull()
    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(mocks.getVideoInfo).not.toHaveBeenCalled()
  })

  test("an answer to a superseded question writes nothing", async () => {
    await submit(MIXED)
    expect(prompt()).not.toBeNull()

    // whatever the question was about, the store is somebody else's now
    await submit("https://www.youtube.com/playlist?list=PLOTHER")
    await choose("playlist")

    expect(usePlaylistStore.getState().url).toBe(
      "https://www.youtube.com/playlist?list=PLOTHER"
    )
    expect(prompt()).toBeNull()
    // and it is not remembered either: an answer that was not applied is not
    // an answer, and the next paste of this link must ask again
    expect(useMixedLinkStore.getState().answers.size).toBe(0)
  })

  /**
   * the guard, on its own, without a submission to move the token for it.
   *
   * every path that supersedes a question retires it outright today, so the
   * check inside `choose` is unreachable through the UI. it is still what makes
   * "remembered" mean "applied": the two must not be able to disagree, whatever
   * a later caller does to the token.
   */
  test("a token that moves under an open question decides nothing", async () => {
    await submit(MIXED)

    usePlaylistStore.getState().beginLookup()
    await choose("playlist")

    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(useMixedLinkStore.getState().answers.size).toBe(0)
  })
})

/**
 * a submission owns the two youtube views from the moment it starts.
 *
 * not from the moment it succeeds, which is the older rule and the one T6
 * cannot live with: a plain video used to advance the token only once its
 * response came back, so a listing resolving in that window was still "current"
 * and got to interrupt the user with a question about a link they had already
 * replaced. worse, a video that *failed* left the old listing current
 * indefinitely, and answering its question wrote a playlist under a url nothing
 * on screen was showing.
 */
describe("a submission that has been overtaken", () => {
  /** a submit whose api answer the test decides the timing of */
  function deferred<T>() {
    let settle!: (value: T) => void
    const promise = new Promise<T>((resolve) => {
      settle = resolve
    })

    return { promise, settle }
  }

  test("a newer video submission retires a listing still in flight", async () => {
    const listing = deferred<PlaylistInfoResponse>()
    const video = deferred<VideoInfoResponse>()
    mocks.getPlaylistInfo.mockReturnValueOnce(listing.promise)
    mocks.getVideoInfo.mockReturnValueOnce(video.promise)

    const { result, unmount } = renderHook(() => useMediaSearch("youtube"))

    let mixed!: Promise<void>
    let plain!: Promise<void>
    act(() => {
      mixed = result.current.onSubmit({ url: MIXED })
    })
    act(() => {
      plain = result.current.onSubmit({ url: PLAIN_VIDEO })
    })

    // the listing lands while the video it was replaced by is still going
    await act(async () => {
      listing.settle(playlistInfo)
      await mixed
    })

    expect(prompt()).toBeNull()

    await act(async () => {
      video.settle(videoInfo)
      await plain
    })
    unmount()

    expect(prompt()).toBeNull()
    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()
  })

  test("even when the newer video is the one that fails", async () => {
    const listing = deferred<PlaylistInfoResponse>()
    mocks.getPlaylistInfo.mockReturnValueOnce(listing.promise)

    const { result, unmount } = renderHook(() => useMediaSearch("youtube"))

    let mixed!: Promise<void>
    act(() => {
      mixed = result.current.onSubmit({ url: MIXED })
    })

    mocks.getVideoInfo.mockRejectedValueOnce(new Error("video unavailable"))
    await act(async () => {
      await result.current.onSubmit({ url: PLAIN_VIDEO })
    })

    await act(async () => {
      listing.settle(playlistInfo)
      await mixed
    })
    unmount()

    // a submission that failed still replaced the one before it. the question
    // is about a link the user has moved on from either way
    await choose("playlist")

    expect(prompt()).toBeNull()
    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(useAppStore.getState().showMediaDetails).toBe(false)
  })

  /**
   * the shortcut takes no listing of its own, which is the point of it. that
   * does not make it a lesser submission: it puts a video on screen, so a
   * listing still in flight behind it is as obsolete as it would be behind any
   * other paste.
   */
  test("a remembered answer is a submission like any other", async () => {
    await submit(MIXED)
    await choose("video")

    const listing = deferred<PlaylistInfoResponse>()
    const video = deferred<VideoInfoResponse>()
    mocks.getPlaylistInfo.mockReturnValueOnce(listing.promise)
    mocks.getVideoInfo.mockReturnValueOnce(video.promise)

    const { result, unmount } = renderHook(() => useMediaSearch("youtube"))

    let plOther!: Promise<void>
    let shortcut!: Promise<void>
    act(() => {
      plOther = result.current.onSubmit({
        url: "https://www.youtube.com/playlist?list=PLOTHER"
      })
    })

    // the remembered link goes straight to its video, with no listing at all
    act(() => {
      shortcut = result.current.onSubmit({ url: MIXED })
    })

    // and the listing lands while that video is still in flight, which is the
    // window a shortcut that took no token of its own would have left open
    await act(async () => {
      listing.settle({ ...playlistInfo, playlist_id: "PLOTHER" })
      await plOther
    })

    expect(usePlaylistStore.getState().playlistInfo).toBeNull()

    await act(async () => {
      video.settle(videoInfo)
      await shortcut
    })
    unmount()

    expect(usePlaylistStore.getState().playlistInfo).toBeNull()
    expect(useYouTubeStore.getState().videoInfo).not.toBeNull()
  })

  test("a newer playlist submission retires a question already on screen", async () => {
    await submit(MIXED)
    expect(prompt()).not.toBeNull()

    await submit("https://www.youtube.com/playlist?list=PLOTHER")

    expect(prompt()).toBeNull()
  })

  test("clearing the box retires a question already on screen", async () => {
    const { result, unmount } = renderHook(() => useMediaSearch("youtube"))

    await act(async () => {
      await result.current.onSubmit({ url: MIXED })
    })
    expect(prompt()).not.toBeNull()

    act(() => {
      result.current.handleClear()
    })
    unmount()

    expect(prompt()).toBeNull()
    expect(useMixedLinkStore.getState().answers.size).toBe(0)
  })

  test("the spinner goes with the submission that was overtaken", async () => {
    const listing = deferred<PlaylistInfoResponse>()
    mocks.getPlaylistInfo.mockReturnValueOnce(listing.promise)

    const { result, unmount } = renderHook(() => useMediaSearch("youtube"))

    let mixed!: Promise<void>
    act(() => {
      mixed = result.current.onSubmit({ url: MIXED })
    })
    expect(usePlaylistStore.getState().isLoadingPlaylistInfo).toBe(true)

    // the abandoned lookup's own guard will not clear this: it is not current
    // any more, and the spinner belongs to whoever is
    await act(async () => {
      await result.current.onSubmit({ url: PLAIN_VIDEO })
    })

    await act(async () => {
      listing.settle(playlistInfo)
      await mixed
    })
    unmount()

    expect(usePlaylistStore.getState().isLoadingPlaylistInfo).toBe(false)
  })

  test("two listings in flight only ever ask about the newer one", async () => {
    const first = deferred<PlaylistInfoResponse>()
    mocks.getPlaylistInfo.mockReturnValueOnce(first.promise)

    const { result, unmount } = renderHook(() => useMediaSearch("youtube"))

    let mixed!: Promise<void>
    act(() => {
      mixed = result.current.onSubmit({ url: MIXED })
    })

    const other = { ...playlistInfo, playlist_id: "PLOTHER", title: "Other" }
    mocks.getPlaylistInfo.mockResolvedValueOnce(other)
    await act(async () => {
      await result.current.onSubmit({
        url: "https://youtu.be/otherVid?list=PLOTHER"
      })
    })

    await act(async () => {
      first.settle(playlistInfo)
      await mixed
    })
    unmount()

    expect(prompt()?.info).toEqual(other)

    await choose("playlist")

    expect(usePlaylistStore.getState().url).toBe(
      "https://youtu.be/otherVid?list=PLOTHER"
    )
  })
})
