// the rules the playlist screens are drawn from, checked without rendering
// anything: which of the three screens a status means, and the header lines
// that have to be honest about a listing we only hold the first hundred of.

import { describe, expect, test } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import { countLine, nameList, phaseOf, totalDuration } from "@/lib/playlistView"

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

const info = (overrides: Partial<PlaylistInfoResponse> = {}): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "Short talks",
  uploader: "TED",
  count: 11,
  listed: 11,
  truncated: false,
  entries: [],
  ...overrides
})

describe("which screen a status means", () => {
  test.each([
    ["idle", "picking"],
    ["starting", "running"],
    ["downloading", "running"],
    ["completed", "finished"],
    ["failed", "finished"],
    ["cancelled", "finished"]
  ])("%s is the %s screen", (status, phase) => {
    expect(phaseOf(status)).toBe(phase)
  })

  /**
   * `starting` deliberately counts as running rather than as picking. the job
   * is the user's from the moment they press the button, and leaving the
   * checkboxes live for the second before the engine answers invites a change
   * the run will not honour
   */
  test("the second before the engine answers is not still picking", () => {
    expect(phaseOf("starting")).not.toBe("picking")
  })
})

describe("how many videos this is", () => {
  test("says what it holds when it holds all of them", () => {
    expect(countLine(info({ listed: 11, count: 11 }))).toBe("11 videos")
    expect(countLine(info({ listed: 1, count: 1 }))).toBe("1 video")
  })

  /**
   * a link can hold five thousand videos and we list the first hundred. "100
   * videos" over that is the kind of small lie somebody finds out about later
   */
  test("a truncated listing says so, and says how much there really is", () => {
    expect(countLine(info({ listed: 100, count: 5283, truncated: true }))).toBe(
      "Showing the first 100 of 5,283 videos"
    )
  })

  test("a channel that never reports a size is not guessed at", () => {
    // a channel feed paginates lazily and reports no count at all
    expect(countLine(info({ listed: 100, count: null, truncated: true }))).toBe(
      "100 videos"
    )
  })
})

describe("how long it all is", () => {
  test("adds up the rows and reads in hours and minutes", () => {
    // twelve five-minute talks
    expect(totalDuration(Array.from({ length: 12 }, (_, i) => entry(i + 1)))).toBe(
      "1 h 00 m total"
    )
    expect(totalDuration([entry(1), entry(2)])).toBe("10 m total")
  })

  /**
   * a live stream or a video that is gone has no duration at all, and adding
   * up the rest would print a total that is quietly short of the truth
   */
  test("says nothing at all when one row has no duration", () => {
    expect(totalDuration([entry(1), entry(2, { duration: null })])).toBeNull()
    expect(totalDuration([])).toBeNull()
  })
})

describe("naming the ones that did not make it", () => {
  test("one is named on its own", () => {
    expect(nameList([entry(1, { title: "One" })])).toBe('"One"')
  })

  test("two are joined with and", () => {
    expect(nameList([entry(1, { title: "One" }), entry(2, { title: "Two" })])).toBe(
      '"One" and "Two"'
    )
  })

  test("beyond three, the rest are counted rather than listed", () => {
    const five = ["One", "Two", "Three", "Four", "Five"].map((title, i) =>
      entry(i + 1, { title })
    )

    expect(nameList(five)).toBe('"One", "Two", "Three" and 2 more')
  })

  test("uses no em-dash", () => {
    expect(nameList([entry(1), entry(2), entry(3), entry(4)])).not.toContain("—")
  })
})
