// unit tests for the transcript plumbing: finding what a --skip-download run
// wrote, and turning a subtitle file into the words in it

const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  TRANSCRIPT_FORMATS,
  TRANSCRIPT_EXTENSIONS,
  PLAIN_TEXT_SOURCES,
  listDirectory,
  extensionOf,
  isSubtitleFile,
  findTranscriptFiles,
  preferExtension,
  subtitleToPlainText,
  writePlainText,
  replaceExtension,
  removeLeftovers
} = require("../src/main/utils/transcript")

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cliply-transcript-"))
}

function write(directory, name, contents = "x") {
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

describe("the format vocabulary", () => {
  test("txt is downloaded as srt, because it is made out of one", () => {
    expect(TRANSCRIPT_FORMATS).toEqual({ srt: "srt", vtt: "vtt", txt: "srt" })
  })

  test("every format names the extension its finished file carries", () => {
    expect(Object.keys(TRANSCRIPT_EXTENSIONS).sort()).toEqual(
      Object.keys(TRANSCRIPT_FORMATS).sort()
    )
    expect(TRANSCRIPT_EXTENSIONS.txt).toBe(".txt")
  })

  test("plain text can be made from either subtitle format", () => {
    expect([...PLAIN_TEXT_SOURCES].sort()).toEqual([".srt", ".vtt"])
  })
})

describe("extensionOf", () => {
  test("lowercases, and keeps the dot", () => {
    expect(extensionOf("clip.en.SRT")).toBe(".srt")
    expect(extensionOf("/a/b/clip.vtt")).toBe(".vtt")
  })

  test("nothing at all is not an extension", () => {
    expect(extensionOf("")).toBe("")
    expect(extensionOf(null)).toBe("")
    expect(extensionOf("README")).toBe("")
  })

  test("yt-dlp's language suffix is not mistaken for one", () => {
    // "clip.en.srt" - the language is a middle segment, not the extension
    expect(extensionOf("clip.en.srt")).toBe(".srt")
  })
})

describe("isSubtitleFile", () => {
  test("recognises every extension a track may arrive as", () => {
    for (const name of [
      "a.srt",
      "a.vtt",
      "a.ass",
      "a.ttml",
      "a.srv3",
      "a.json3"
    ]) {
      expect(isSubtitleFile(name)).toBe(true)
    }
  })

  test("a live-chat replay's json is not a subtitle", () => {
    expect(isSubtitleFile("stream.live_chat.json")).toBe(false)
  })

  test("media files are not subtitles", () => {
    expect(isSubtitleFile("clip_1080p_12345.mp4")).toBe(false)
    expect(isSubtitleFile("clip_audio_12345.mp3")).toBe(false)
  })
})

describe("listDirectory", () => {
  test("names every file in the directory", () => {
    const directory = tempDir()
    write(directory, "one.srt")
    write(directory, "two.mp4")

    expect([...listDirectory(directory)].sort()).toEqual(["one.srt", "two.mp4"])
  })

  test("a directory that is not there is empty, never a throw", () => {
    expect(listDirectory(path.join(tempDir(), "nope")).size).toBe(0)
  })
})

describe("findTranscriptFiles", () => {
  test("finds the files the stem names, language suffix and all", () => {
    const directory = tempDir()
    write(directory, "clip_transcript_68123.en.srt")
    write(directory, "clip_transcript_68123.en.vtt")
    write(directory, "something-else.srt")

    const found = findTranscriptFiles(directory, {
      stem: "clip_transcript_68123",
      before: new Set()
    })

    expect(found.map((file) => path.basename(file)).sort()).toEqual([
      "clip_transcript_68123.en.srt",
      "clip_transcript_68123.en.vtt"
    ])
  })

  test("the stem never matches a name that merely starts with it", () => {
    const directory = tempDir()
    const before = listDirectory(directory)

    // the dot is what separates the stem from yt-dlp's suffixes. without it
    // the longer name is a *different* download's file, and it arrived in the
    // same window - so the before/after diff would happily claim it
    write(directory, "clip_transcript_68123.en.srt")
    write(directory, "clip_transcript_68123_other.en.srt")

    const found = findTranscriptFiles(directory, {
      stem: "clip_transcript_68123",
      before
    })

    expect(found.map((file) => path.basename(file))).toEqual([
      "clip_transcript_68123.en.srt"
    ])
  })

  test("falls back to whatever appeared, for a stem that was truncated", () => {
    const directory = tempDir()
    write(directory, "already-here.srt")
    const before = listDirectory(directory)

    write(directory, "a-truncated-name.en.srt")

    const found = findTranscriptFiles(directory, {
      stem: "a-stem-nothing-matches",
      before
    })

    expect(found.map((file) => path.basename(file))).toEqual([
      "a-truncated-name.en.srt"
    ])
  })

  test("the fallback never returns a file that was already there", () => {
    const directory = tempDir()
    write(directory, "older.srt")

    expect(
      findTranscriptFiles(directory, {
        stem: "no-match",
        before: listDirectory(directory)
      })
    ).toEqual([])
  })

  test("media files written by another download are never picked up", () => {
    const directory = tempDir()
    const before = listDirectory(directory)
    write(directory, "someone-elses-video.mp4")

    expect(findTranscriptFiles(directory, { stem: "no-match", before })).toEqual(
      []
    )
  })
})

describe("preferExtension", () => {
  const files = ["/d/clip.en.vtt", "/d/clip.en.srt"]

  test("returns the one the user asked for", () => {
    expect(preferExtension(files, ".srt")).toBe("/d/clip.en.srt")
    expect(preferExtension(files, ".vtt")).toBe("/d/clip.en.vtt")
  })

  test("hands back what exists when the wanted extension does not", () => {
    expect(preferExtension(["/d/clip.en.json3"], ".srt")).toBe(
      "/d/clip.en.json3"
    )
  })

  test("no files is null, not a crash", () => {
    expect(preferExtension([], ".srt")).toBeNull()
    expect(preferExtension(null, ".srt")).toBeNull()
  })
})

describe("subtitleToPlainText", () => {
  test("an srt loses its cue numbers and its timings", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:02,000",
      "Hello there.",
      "",
      "2",
      "00:00:02,000 --> 00:00:04,000",
      "General Kenobi.",
      ""
    ].join("\n")

    expect(subtitleToPlainText(srt)).toBe("Hello there.\nGeneral Kenobi.")
  })

  test("a webvtt loses its header, its cue settings and its inline timing", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:00.000 --> 00:00:02.000 align:start position:0%",
      "hello<00:00:00.480><c> there</c>",
      ""
    ].join("\n")

    expect(subtitleToPlainText(vtt)).toBe("hello there")
  })

  test("rolling auto-captions do not repeat themselves", () => {
    // youtube emits each line again as the next one scrolls under it
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "the first line",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "the first line",
      "the second line",
      ""
    ].join("\n")

    expect(subtitleToPlainText(vtt)).toBe("the first line\nthe second line")
  })

  test("a line that comes back later is not a duplicate", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:01,000",
      "chorus",
      "",
      "2",
      "00:00:01,000 --> 00:00:02,000",
      "verse",
      "",
      "3",
      "00:00:02,000 --> 00:00:03,000",
      "chorus",
      ""
    ].join("\n")

    expect(subtitleToPlainText(srt)).toBe("chorus\nverse\nchorus")
  })

  test("entities come back as the characters they stand for", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:01,000",
      "rock &amp; roll &#39;n&#39; &quot;jazz&quot;",
      ""
    ].join("\n")

    expect(subtitleToPlainText(srt)).toBe("rock & roll 'n' \"jazz\"")
  })

  test("ass override blocks are not spoken words", () => {
    expect(subtitleToPlainText("{\\an8}top of the screen")).toBe(
      "top of the screen"
    )
  })

  test("windows line endings read the same as unix ones", () => {
    const srt = "1\r\n00:00:00,000 --> 00:00:01,000\r\nhello\r\n\r\n"

    expect(subtitleToPlainText(srt)).toBe("hello")
  })

  test("a line of digits inside a caption is still a cue number", () => {
    // the known cost of the cue-number rule: a caption that is only a number
    // is indistinguishable from the index above it. worth saying out loud
    const srt = "1\n00:00:00,000 --> 00:00:01,000\n1999\n"

    expect(subtitleToPlainText(srt)).toBe("")
  })

  test("nothing at all is an empty transcript, not a throw", () => {
    expect(subtitleToPlainText("")).toBe("")
    expect(subtitleToPlainText(null)).toBe("")
    expect(subtitleToPlainText(undefined)).toBe("")
  })
})

describe("replaceExtension", () => {
  test("keeps the language suffix yt-dlp appended", () => {
    expect(path.basename(replaceExtension("/d/clip.en.srt", ".txt"))).toBe(
      "clip.en.txt"
    )
  })
})

describe("writePlainText", () => {
  test("writes the words beside the subtitle and removes the source", () => {
    const directory = tempDir()
    const source = write(
      directory,
      "clip.en.srt",
      "1\n00:00:00,000 --> 00:00:01,000\nhello\n"
    )

    const target = writePlainText(source)

    expect(path.basename(target)).toBe("clip.en.txt")
    expect(fs.readFileSync(target, "utf8")).toBe("hello\n")
    expect(fs.existsSync(source)).toBe(false)
  })
})

describe("removeLeftovers", () => {
  test("deletes everything except the file that was kept", () => {
    const directory = tempDir()
    const kept = write(directory, "clip.en.srt")
    const leftover = write(directory, "clip.en.vtt")

    removeLeftovers([kept, leftover], kept)

    expect(fs.existsSync(kept)).toBe(true)
    expect(fs.existsSync(leftover)).toBe(false)
  })

  test("a file that cannot be deleted is not worth a throw", () => {
    const directory = tempDir()
    const kept = write(directory, "clip.en.srt")

    expect(() =>
      removeLeftovers([path.join(directory, "never-existed.vtt")], kept)
    ).not.toThrow()
  })
})
