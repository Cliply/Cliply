// @vitest-environment jsdom
//
// the renderer half of telemetry: the helpers that turn what the ui knows into
// values the main process's validator accepts, and a send that can never break
// the ui it is measuring.
//
// the labels these produce are checked against the real validator in the main
// suite (tests/renderer-analytics.test.js) - a value that fails there is dropped
// behind a console.warn production never shows anyone.

import { afterEach, describe, expect, test, vi } from "vitest"

import {
  AUDIO_QUALITIES,
  DURATION_BUCKET_LABELS,
  URL_KINDS,
  audioQuality,
  durationBucket,
  isTrimmedRange,
  track,
  urlKind,
  videoQuality
} from "./analytics"

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { electronAPI?: unknown }).electronAPI
})

/** install a recording bridge and hand back what it received */
function recordingBridge() {
  const sent: { event: unknown; properties: unknown }[] = []

  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    analytics: {
      track: (event: unknown, properties: unknown) => {
        sent.push({ event, properties })
        return Promise.resolve({ success: true })
      }
    }
  }

  return sent
}

describe("durationBucket", () => {
  test("buckets instead of leaking exact durations", () => {
    const cases: [number, string][] = [
      [1, "<1 min"],
      [59, "<1 min"],
      [60, "1-5 min"],
      [299, "1-5 min"],
      [300, "5-20 min"],
      [1199, "5-20 min"],
      [1200, "20-60 min"],
      [3599, "20-60 min"],
      [3600, ">60 min"],
      [86400, ">60 min"]
    ]

    for (const [seconds, label] of cases) {
      expect(durationBucket(seconds)).toBe(label)
    }
  })

  test("says nothing about a duration it does not have", () => {
    // a live stream, a pin with no duration, a mapper that returned nothing.
    // null is what the call site omits - "unknown" is not a bucket label, and
    // sending one would be dropped by the validator behind a silent warning
    for (const value of [null, undefined, 0, -1, NaN, Infinity]) {
      expect(durationBucket(value)).toBeNull()
    }
  })

  test("every label it can return is one the call sites can send", () => {
    // the guard on the list below: a bucket added here has to be added to the
    // fixture the main suite validates, or nobody finds out it is unsendable
    expect(DURATION_BUCKET_LABELS).toEqual([
      "<1 min",
      "1-5 min",
      "5-20 min",
      "20-60 min",
      ">60 min"
    ])
  })
})

describe("urlKind", () => {
  test("names the shape of the link, never the link", () => {
    const cases: [string, string][] = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", URL_KINDS.video],
      ["https://www.youtube.com/shorts/abc123", URL_KINDS.shorts],
      ["https://www.youtube.com/embed/abc123", URL_KINDS.embed],
      ["https://www.youtube.com/v/abc123", URL_KINDS.embed],
      ["https://youtu.be/dQw4w9WgXcQ", URL_KINDS.shortLink],
      ["https://www.youtube.com/watch?v=abc&list=PL123", URL_KINDS.playlist],
      ["https://www.youtube.com/playlist?list=PL123", URL_KINDS.playlist],
      ["https://www.pinterest.com/pin/12345/", URL_KINDS.video],
      ["https://pin.it/abc123", URL_KINDS.shortLink],
      ["https://www.tiktok.com/@someone/video/12345", URL_KINDS.video],
      ["https://vm.tiktok.com/ZM123/", URL_KINDS.shortLink],
      ["https://vt.tiktok.com/ZM123/", URL_KINDS.shortLink],
      ["https://www.tiktok.com/t/ZM123/", URL_KINDS.shortLink],
      ["https://www.tiktok.com/embed/12345", URL_KINDS.embed]
    ]

    for (const [url, kind] of cases) {
      expect(urlKind(url)).toBe(kind)
    }
  })

  test("a playlist link is a playlist whatever else it also is", () => {
    // "did they paste a playlist" is the question this answers - we take the
    // one video out of it, and the mismatch is the interesting half
    expect(urlKind("https://www.youtube.com/shorts/abc?list=PL1")).toBe(
      URL_KINDS.playlist
    )
    expect(urlKind("https://youtu.be/abc?list=PL1")).toBe(URL_KINDS.playlist)
  })

  test("returns a kind for anything, including what it cannot place", () => {
    // every url reaching a call site has already passed a platform validator,
    // so an unplaced shape is a canonical link rather than a mystery
    expect(urlKind("")).toBe(URL_KINDS.video)
    expect(urlKind("not a url at all")).toBe(URL_KINDS.video)
  })
})

describe("quality", () => {
  test("a video is reported by the height the user picked", () => {
    // the same value main derives for download_completed (ipc-handlers.js:514),
    // so the two halves of one download can be joined on it
    expect(videoQuality(1080)).toBe("1080p")
    expect(videoQuality(144)).toBe("144p")
    expect(videoQuality(2160)).toBe("2160p")
  })

  test("says nothing about a height that is not one", () => {
    // the validator takes two to four digits and a p. anything else is dropped
    // behind a warning, so it is left out here instead
    for (const value of [0, -1, 5, 12345, NaN, Infinity, 1080.5, null, undefined]) {
      expect(videoQuality(value)).toBeNull()
    }
  })

  test("an audio mode is reported the way main reports it", () => {
    // extractQuality maps the "original" mode to "original_audio"
    // (analytics-helpers.js:26), and a pass-through would split one download's
    // two events across two different values
    expect(audioQuality("mp3")).toBe("mp3")
    expect(audioQuality("m4a")).toBe("m4a")
    expect(audioQuality("original")).toBe("original_audio")
    expect(AUDIO_QUALITIES.original).toBe("original_audio")
  })
})

describe("isTrimmedRange", () => {
  test("agrees with what main will actually do with the range", () => {
    // normalizeTimeRange (ipc-handlers.js:55) throws away a range that is not a
    // segment, so a download reported as trimmed here and untrimmed there would
    // be one download disagreeing with itself
    expect(isTrimmedRange({ start: 10, end: 30 })).toBe(true)
    expect(isTrimmedRange(undefined)).toBe(false)
    expect(isTrimmedRange({ start: 0, end: 0 })).toBe(false)
    expect(isTrimmedRange({ start: 30, end: 10 })).toBe(false)
    expect(isTrimmedRange({ start: 30, end: 30 })).toBe(false)
  })
})

describe("track", () => {
  test("sends the event and its properties over the bridge", () => {
    const sent = recordingBridge()

    track("url_submitted", { platform: "youtube", url_kind: "video" })

    expect(sent).toEqual([
      {
        event: "url_submitted",
        properties: { platform: "youtube", url_kind: "video" }
      }
    ])
  })

  test("omits an absent property rather than saying null", () => {
    // main skips a null in silence, so this costs nothing there - but a bag
    // that says null claims we looked and found nothing, which is not the same
    // as not having looked. false and 0 are values and stay
    const sent = recordingBridge()

    track("media_info_loaded", {
      platform: "pinterest",
      duration_bucket: null,
      formats_count: undefined,
      is_trimmed: false
    })

    expect(sent[0].properties).toEqual({
      platform: "pinterest",
      is_trimmed: false
    })
  })

  test("never throws when the bridge is missing", () => {
    // the browser dev server has no preload at all
    expect(() =>
      track("url_submitted", { platform: "youtube" })
    ).not.toThrow()

    vi.stubGlobal("window", {})
    expect(() =>
      track("url_submitted", { platform: "youtube" })
    ).not.toThrow()
  })

  test("never throws when the bridge does", () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      analytics: {
        track: () => {
          throw new Error("context bridge is gone")
        }
      }
    }

    expect(() => track("download_started", { platform: "youtube" })).not.toThrow()
  })

  test("a rejected send is not an unhandled rejection", async () => {
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)

    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      analytics: { track: () => Promise.reject(new Error("no main process")) }
    }

    track("url_submitted", { platform: "youtube" })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()

    process.off("unhandledRejection", unhandled)
  })
})
