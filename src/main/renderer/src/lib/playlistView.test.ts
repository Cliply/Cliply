// the rules the playlist screens are drawn from, checked without rendering
// anything: which of the three screens a status means, and the header lines
// that have to be honest about a listing we only hold the first hundred of.
//
// the locale is english here, as it is in every renderer test. a badge is
// asserted as the key it should have reached for, so the words themselves live
// in one place; a whole sentence is still spelled out, because the sentence is
// what those tests are about.

import { describe, expect, test } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import {
  ceilingHelperText,
  countLine,
  mixedLinkPlaylistChoice,
  nameList,
  phaseOf,
  playlistAudioNote,
  rowBadge,
  totalDuration
} from "@/lib/playlistView"

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

  /**
   * the host locale here is english and stays english: what changes is the
   * language the app was told to speak. a bare `toLocaleString()` follows the
   * machine, which put "5,283" in the middle of a russian sentence for every
   * russian reader on an english install.
   */
  test("groups its digits the way the app's language does, not the machine's", () => {
    const truncated = info({ listed: 100, count: 5283, truncated: true })

    expect(countLine(truncated)).toContain((5283).toLocaleString("en"))

    useLocale.getState().setLocale("ru")

    try {
      const grouped = (5283).toLocaleString("ru")

      // the separator comes from Intl rather than being typed here: russian
      // uses a space you cannot tell apart in a diff
      expect(grouped).not.toBe((5283).toLocaleString("en"))
      expect(countLine(truncated)).toBe(
        `показаны первые 100 из ${grouped} видео`
      )
    } finally {
      useLocale.getState().setLocale("en")
    }
  })
})

describe("the other thing an ambiguous link could mean", () => {
  test("is the playlist, by the number of videos in it", () => {
    expect(mixedLinkPlaylistChoice(info({ listed: 11 }))).toBe("All 11 videos")
    expect(mixedLinkPlaylistChoice(info({ listed: 1 }))).toBe("All 1 video")
  })

  /**
   * "All 100 videos" out of a link holding five thousand is a promise the
   * download will not keep, and this button is the download's own wording
   */
  test("never says all of a listing that is not all of it", () => {
    expect(
      mixedLinkPlaylistChoice(info({ listed: 100, count: 5283, truncated: true }))
    ).toBe("The first 100 videos")
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

/**
 * the rule the user found the hard way: ticking two of ten and running left
 * the other eight reading "not saved", which is eight failures that never
 * happened. a badge belongs to the run, so a row the run was never asked for
 * has none.
 */
describe("which rows get a badge at all", () => {
  test("a row nobody ticked gets none once the run has ended", () => {
    expect(rowBadge(entry(5), "finished", false)).toBeNull()
  })

  test("but a ticked row the run never reached says it was not saved", () => {
    expect(rowBadge(entry(5), "finished", true)).toEqual({
      text: en["playlist.rowNotSaved"],
      tone: "gone"
    })
  })

  test("an unticked row is just as absent while the run is going", () => {
    // "queued" over a row that is not in the queue is the same lie, earlier
    expect(rowBadge(entry(5), "running", false)).toBeNull()
    expect(rowBadge(entry(5), "running", true)).toEqual({
      text: en["playlist.rowQueued"],
      tone: "neutral"
    })
  })

  /**
   * a deleted or private video is a fact about the listing rather than about
   * the run, so it is said whether or not the row was ever ticked, and in
   * every phase
   */
  test("an unavailable row says so regardless", () => {
    const missing = entry(3, { unavailable: true, id: null })

    for (const phase of ["picking", "running", "finished"] as const) {
      expect(rowBadge(missing, phase, false)).toEqual({
        text: en["playlist.rowUnavailable"],
        tone: "gone"
      })
    }
  })

  test("nothing is badged while the user is still picking", () => {
    expect(rowBadge(entry(1), "picking", true)).toBeNull()
    expect(
      rowBadge(entry(1), "picking", true, { state: "saved", progress: 100 })
    ).toBeNull()
  })

  /**
   * red is what the rest of the app uses for a validation error and the cancel
   * hover. a video the run did not write is neither, and nothing in the app is
   * green, so the two outcomes a row can end on are the muted chip and the
   * accent one.
   */
  test("an outcome is muted or accented, never an alarm", () => {
    expect(rowBadge(entry(1), "finished", true, { state: "skipped", progress: 0 }))
      .toEqual({ text: en["playlist.rowNotSaved"], tone: "gone" })

    expect(
      rowBadge(entry(1), "finished", true, {
        state: "saved",
        progress: 100,
        height: 1080
      })
    ).toEqual({ text: "saved · 1080p", tone: "done" })

    expect(rowBadge(entry(1), "finished", true, { state: "reused", progress: 100 }))
      .toEqual({ text: en["playlist.rowReused"], tone: "done" })
  })
})

/**
 * the user's words: "there is no need of irrelevant information that what we
 * cannot do". one short sentence per tab saying how it works, and no sentence
 * anywhere naming a control that is not there.
 */
describe("what the card says about a run", () => {
  test("the video line is one sentence, and follows the ceiling", () => {
    expect(ceilingHelperText("1080p")).toBe(
      "Each video is saved as MP4 at its best quality up to 1080p, with its original audio."
    )
    expect(ceilingHelperText("4K")).toContain("up to 4K")
  })

  test("the audio line is one sentence", () => {
    expect(playlistAudioNote()).toBe(en["playlist.audioNote"])
  })

  test("neither of them says what a playlist cannot do", () => {
    for (const line of [ceilingHelperText("1080p"), playlistAudioNote()]) {
      expect(line).not.toMatch(/^No /)
      expect(line).not.toMatch(/\bcannot\b/)
      expect(line).not.toContain("—")
      // one sentence, so one full stop, and it is the last character
      expect(line.indexOf(".")).toBe(line.length - 1)
    }
  })
})
