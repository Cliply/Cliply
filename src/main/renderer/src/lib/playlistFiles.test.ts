// reading a finished playlist's rows out of the filenames it wrote
//
// a playlist is downloaded under one quality *ceiling*, and yt-dlp resolves
// that ceiling per video: "up to 1080p" is 1080p for one video, 720p for the
// next and 1080p for a portrait Short whose smaller side is 608. no progress
// event carries the height, and nothing else does either - so the only place
// the delivered height exists is in the name the output template wrote, which
// is exactly why T1 put it there.

import { describe, expect, test } from "vitest"

import type { PlaylistEntry } from "@/lib/api"
import { deliveredByIndex, parseDeliveredFile } from "@/lib/playlistFiles"

const entry = (index: number, id: string | null): PlaylistEntry => ({
  index,
  id,
  title: `video ${index}`,
  duration: 60,
  duration_string: "1:00",
  thumbnail: null,
  unavailable: id === null
})

describe("one filename", () => {
  test("carries the position, the video id and the height it came down at", () => {
    expect(
      parseDeliveredFile(
        "/Users/x/Downloads/Cliply/Short talks [PL123]/001 - The Power of Imagination [TeVE4TQPEwM] 1080p.mp4"
      )
    ).toEqual({ index: 1, id: "TeVE4TQPEwM", height: 1080 })
  })

  test("reads a windows path as readily as a posix one", () => {
    expect(
      parseDeliveredFile("C:\\Users\\x\\Downloads\\002 - Two [kz-I5zIGbj4] 720p.mp4")
    ).toEqual({ index: 2, id: "kz-I5zIGbj4", height: 720 })
  })

  /**
   * the audio template has no height in it at all, deliberately: an mp3 has no
   * resolution to report. the row still gets its position and id, so it can
   * still be shown as saved - just with nothing after the word
   */
  test("an audio file names its video and no height", () => {
    expect(parseDeliveredFile("/dl/PL/003 - Three [Ojk3QV5U5Jc].mp3")).toEqual({
      index: 3,
      id: "Ojk3QV5U5Jc",
      height: null
    })
  })

  test("a height yt-dlp did not know is no height, not a wrong one", () => {
    // %(height)s renders as NA when the merged output has none to report
    expect(parseDeliveredFile("/dl/PL/004 - Four [ddddddddddd] NAp.mkv")).toEqual({
      index: 4,
      id: "ddddddddddd",
      height: null
    })
  })

  /**
   * a real title can contain anything, brackets included. the id is the *last*
   * bracketed group in the name because the template puts it there, after the
   * title, and a title's own brackets are therefore never the last ones
   */
  test("a title with brackets of its own does not steal the id", () => {
    expect(
      parseDeliveredFile("/dl/PL/005 - Live [4K remaster] set [aaaaaaaaaaa] 2160p.mp4")
    ).toEqual({ index: 5, id: "aaaaaaaaaaa", height: 2160 })
  })

  test("a position past the padding is still read", () => {
    // the padding is the cap's digit width, so 100 is three digits like the
    // rest, but nothing here depends on the width
    expect(parseDeliveredFile("/dl/PL/100 - Hundred [aaaaaaaaaaa] 360p.mp4")).toEqual({
      index: 100,
      id: "aaaaaaaaaaa",
      height: 360
    })
  })

  test("a name in no shape we wrote is not guessed at", () => {
    expect(parseDeliveredFile("/dl/some other download.mp4")).toBeNull()
    expect(parseDeliveredFile("/dl/PL/006 - Six.mp4")).toBeNull()
    expect(parseDeliveredFile("")).toBeNull()
  })

  test("a name with no leading position cannot be attributed to a row", () => {
    // every playlist output the template writes starts with the position, so
    // a name without one is not one of ours and cannot certify anything
    expect(parseDeliveredFile("/dl/PL/One [aaaaaaaaaaa] 1080p.mp4")).toBeNull()
  })

  test("an unfinished download is not a delivered file", () => {
    // the engine only reports verified after_move records, so this should
    // never arrive - but a half-written file is the one thing that must never
    // be read as a save if it ever does
    expect(parseDeliveredFile("/dl/PL/001 - One [aaaaaaaaaaa] 1080p.mp4.part")).toBeNull()
    expect(parseDeliveredFile("/dl/PL/001 - One [aaaaaaaaaaa] 1080p.mp4.ytdl")).toBeNull()
  })
})

describe("the run's files, against the rows on screen", () => {
  const entries = [entry(1, "aaaaaaaaaaa"), entry(4, "bbbbbbbbbbb"), entry(6, "ccccccccccc")]

  test("each file lands on the row whose id it names", () => {
    const delivered = deliveredByIndex(
      [
        "/dl/PL/001 - One [aaaaaaaaaaa] 1080p.mp4",
        "/dl/PL/006 - Six [ccccccccccc] 480p.mp4"
      ],
      entries
    )

    // the heights differ per video, which is the whole point of a ceiling
    expect(delivered.get(1)).toBe(1080)
    expect(delivered.get(6)).toBe(480)
    // position 4 was never saved, so it is not in here at all
    expect(delivered.has(4)).toBe(false)
  })

  test("a saved row with no height is still a saved row", () => {
    const delivered = deliveredByIndex(["/dl/PL/004 - Four [bbbbbbbbbbb].mp3"], entries)

    expect(delivered.has(4)).toBe(true)
    expect(delivered.get(4)).toBeNull()
  })

  /**
   * the join has to be on the position **and** the id, not on the id alone.
   *
   * a playlist can hold one video at two positions, and the template writes a
   * separate file for each of them. one file therefore certifies exactly one
   * row: matching on the id would mark the position whose own file never
   * landed as saved, which both overstates the run and hides that row from the
   * retry the summary offers.
   */
  test("a video the playlist holds twice is saved one position at a time", () => {
    const twice = [entry(2, "aaaaaaaaaaa"), entry(7, "aaaaaaaaaaa")]
    const delivered = deliveredByIndex(["/dl/PL/002 - One [aaaaaaaaaaa] 720p.mp4"], twice)

    expect([...delivered.entries()]).toEqual([[2, 720]])
    expect(delivered.has(7)).toBe(false)
  })

  test("both positions land when both files did", () => {
    const twice = [entry(2, "aaaaaaaaaaa"), entry(7, "aaaaaaaaaaa")]
    const delivered = deliveredByIndex(
      [
        "/dl/PL/002 - One [aaaaaaaaaaa] 720p.mp4",
        "/dl/PL/007 - One [aaaaaaaaaaa] 1080p.mp4"
      ],
      twice
    )

    expect([...delivered.entries()]).toEqual([
      [2, 720],
      [7, 1080]
    ])
  })

  test("a file naming a video this listing does not hold is dropped", () => {
    const delivered = deliveredByIndex(["/dl/PL/009 - Nine [zzzzzzzzzzz] 720p.mp4"], entries)

    expect(delivered.size).toBe(0)
  })

  test("a file whose position and id disagree with the row is dropped", () => {
    // the position exists and the id exists, but not together: nothing here
    // is evidence about either row
    const delivered = deliveredByIndex(["/dl/PL/001 - One [bbbbbbbbbbb] 720p.mp4"], entries)

    expect(delivered.size).toBe(0)
  })

  test("no files, no listing and no matches are all just nothing", () => {
    expect(deliveredByIndex(undefined, entries).size).toBe(0)
    expect(deliveredByIndex([], entries).size).toBe(0)
    expect(deliveredByIndex(["/dl/PL/001 - One [aaaaaaaaaaa] 1080p.mp4"], []).size).toBe(0)
    expect(
      deliveredByIndex(["/dl/PL/001 - One [aaaaaaaaaaa] 1080p.mp4"], undefined).size
    ).toBe(0)
  })
})
