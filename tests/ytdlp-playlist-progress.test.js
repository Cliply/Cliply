// two-level progress and the partial-success outcome, for the playlist half of
// the engine
//
// the fixtures under tests/fixtures/playlist-run-*.stdout are verbatim stdout
// from the shipped binary (2026.08.19) driven with the arg list buildArgs
// produces, against real youtube playlists:
//
//   playlist-run-complete      PLLojVvWCZ5N4 -I 1:2   -> exit 0, 2 files
//   playlist-run-partial       PL590L5...TCfs -I 5:7  -> exit 1, 1 file,
//                                                       2 private videos
//   playlist-run-archive-skip  PLLojVvWCZ5N4 -I 1:2   -> exit 0, 0 files,
//                                                       both items in the archive
//
// so the line shapes asserted here are measured rather than imagined. the
// complete and partial runs also carry their .records file, which is what
// yt-dlp appended through --print-to-file on the same run.
//
// note what each fixture is for. the .stdout drives **progress** and nothing
// else: since the outcome moved off stdout, no line in those files can add a
// saved item. the outcome tests build a real workspace, write real files and
// write a real record file, because that is the only thing the engine counts

const { EventEmitter } = require("events")
const { PassThrough } = require("stream")
const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  YtdlpEngine,
  PlaylistProgressTracker,
  ERROR_CODES,
  buildArgs,
  expectedStreamCount,
  parseProgressLine,
  parsePlaylistProgressLine,
  parsePlaylistStreamLine,
  parsePlaylistFileLine,
  parsePlaylistRecordLine,
  parseArchiveSkipLine,
  verifySavedFile,
  readArchivedIds,
  countArchivedSelections,
  buildPlaylistRecordsPath,
  PLAYLIST_RECORD_TEMPLATE,
  PROGRESS_TEMPLATE,
  STREAM_TEMPLATE,
  FILE_TEMPLATE,
  PLAYLIST_PROGRESS_TEMPLATE,
  PLAYLIST_STREAM_TEMPLATE,
  PLAYLIST_FILE_TEMPLATE
} = require("../src/main/services/ytdlp-engine")

const { buildPlaylistOutputTemplate } = require("../src/main/utils/ytdlp-mappers")

const PATHS = {
  ffmpegPath: "/res/binaries/ffmpeg",
  denoPath: "/res/binaries/deno/deno"
}

const PLAYLIST = {
  ...PATHS,
  url: "https://www.youtube.com/playlist?list=PLLojVvWCZ5N4",
  playlistIndices: [1, 2],
  outputDir: "/downloads",
  outputTemplate: buildPlaylistOutputTemplate({})
}

const SINGLE = {
  ...PATHS,
  url: "https://www.youtube.com/watch?v=TeVE4TQPEwM",
  outputDir: "/downloads",
  outputTemplate: "%(title)s.%(ext)s"
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
}

// =============================================================================
// harness
// =============================================================================

class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = false
    this.signals = []
  }

  kill(signal) {
    this.killed = true
    this.signals.push(signal)
    return true
  }

  say(text) {
    this.stdout.write(text)
  }

  complain(text) {
    this.stderr.write(text)
  }

  exit(code) {
    this.emit("close", code)
  }
}

function createSpawner() {
  const spawnFn = (binary, args, options) => {
    const child = new FakeChild(9000 + spawnFn.children.length)
    spawnFn.calls.push({ binary, args, options })
    spawnFn.children.push(child)
    return child
  }

  spawnFn.calls = []
  spawnFn.children = []
  return spawnFn
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

// the posix kill path signals a process group, which a fake child does not
// have - throwing is what a real esrch looks like and is what makes killChild
// fall back to the child's own tracked kill()
function fakeGroupKill() {
  throw new Error("ESRCH")
}

function createEngine(spawnFn, options = {}) {
  return new YtdlpEngine({
    userDataPath: path.join(os.tmpdir(), "cliply-playlist-progress"),
    resourcesPath: path.join(os.tmpdir(), "cliply-playlist-progress"),
    ffmpegPath: "/fake/ffmpeg",
    denoPath: "/fake/deno",
    spawnFn,
    killFn: fakeGroupKill,
    ...options
  })
}

// a synthetic stream in the measured shape: `items` entries, each downloading
// two streams, with `saved` of them reaching after_move
function syntheticStream({ items, saved }) {
  const lines = []

  for (let item = 1; item <= items; item += 1) {
    lines.push(`CLIPLY_STREAM|${item}|${item}|vid${item}00000|134+140`)

    for (const stream of [0, 1]) {
      for (const percent of [0, 50, 100]) {
        lines.push(
          `CLIPLY|${percent.toFixed(1).padStart(6)}%|1.00MiB/s|00:0${stream}|${stream}|${item}`
        )
      }
    }

    if (item <= saved) {
      lines.push(
        `CLIPLY_FILE|${item}|${JSON.stringify(`/downloads/00${item} - Talk ${item}.mp4`)}`
      )
    }
  }

  return `${lines.join("\n")}\n`
}

// =============================================================================
// templates
// =============================================================================

describe("playlist output templates", () => {
  test("the playlist templates carry the two progress fields the bar needs", () => {
    // no n_entries. the denominator is what the user selected, which the
    // engine already knows and yt-dlp cannot contradict - see the outcome
    // tests for why a number arriving on stdout is not allowed to set it
    expect(PLAYLIST_PROGRESS_TEMPLATE).toBe(
      "download:CLIPLY|%(progress._percent_str)s|%(progress._speed_str)s|" +
        "%(progress._eta_str)s|%(progress.eta)s|%(info.playlist_autonumber)s"
    )
    expect(PLAYLIST_STREAM_TEMPLATE).toBe(
      "before_dl:CLIPLY_STREAM|%(playlist_autonumber)s|%(playlist_index)s|" +
        "%(id)s|%(format_id)s"
    )
    // the filepath is json, not a bare string. yt-dlp sanitises the parts of a
    // name it derives from a title, but not the -P the user chose, so a legal
    // directory holding a newline would otherwise split the marker across two
    // lines and the engine would record a truncated path as the saved file
    expect(PLAYLIST_FILE_TEMPLATE).toBe(
      "after_move:CLIPLY_FILE|%(playlist_autonumber)s|%(filepath)j"
    )
  })

  test("progress is keyed on playlist_autonumber, never playlist_index", () => {
    // the whole point of the pair: with -I "1,5,9" the indices read 1, 5, 9
    // against an n_entries of 3, so a bar built from playlist_index would
    // render "video 9 of 3"
    expect(PLAYLIST_PROGRESS_TEMPLATE).toContain("%(info.playlist_autonumber)s")
    expect(PLAYLIST_PROGRESS_TEMPLATE).not.toContain("playlist_index")
    expect(PLAYLIST_PROGRESS_TEMPLATE).not.toContain("n_entries")
  })

  test.each(["playlist-combined", "playlist-audio"])(
    "%s asks yt-dlp for the playlist templates",
    (operation) => {
      const args = buildArgs(operation, PLAYLIST)

      expect(args).toContain(PLAYLIST_PROGRESS_TEMPLATE)
      expect(args).toContain(PLAYLIST_STREAM_TEMPLATE)
      expect(args).toContain(PLAYLIST_FILE_TEMPLATE)
      expect(args).not.toContain(PROGRESS_TEMPLATE)
      expect(args).not.toContain(STREAM_TEMPLATE)
      expect(args).not.toContain(FILE_TEMPLATE)
    }
  )

  test.each(["combined", "audio", "simple"])(
    "%s is left on the single-video templates",
    (operation) => {
      const args = buildArgs(operation, SINGLE)

      expect(args).toContain(PROGRESS_TEMPLATE)
      expect(args).toContain(STREAM_TEMPLATE)
      expect(args).toContain(FILE_TEMPLATE)
      expect(args).not.toContain(PLAYLIST_PROGRESS_TEMPLATE)
    }
  )

  test.each(["combined", "audio", "simple"])(
    "a `playlist` key in the params cannot swap %s onto the playlist templates",
    (operation) => {
      // the operation decides the output shape, never the payload. the
      // single-video parser reads CLIPLY_FILE|1|/path as the path "1|/path",
      // so a key arriving over ipc must not be able to reach this
      const args = buildArgs(operation, { ...SINGLE, playlist: true })

      expect(args).toEqual(buildArgs(operation, SINGLE))
      expect(args).toContain(FILE_TEMPLATE)
      expect(args).not.toContain(PLAYLIST_FILE_TEMPLATE)
    }
  )

  test("a `playlist: false` key cannot take a playlist off them either", () => {
    const args = buildArgs("playlist-combined", { ...PLAYLIST, playlist: false })

    expect(args).toContain(PLAYLIST_FILE_TEMPLATE)
    expect(args).not.toContain(FILE_TEMPLATE)
  })
})

describe("the archive can be asked to stand aside", () => {
  const withArchive = { ...PLAYLIST, archiveFile: "/ud/playlists/PL1__1080p-mp4__ab12cd34.txt" }

  test.each(["playlist-combined", "playlist-audio"])(
    "%s resumes through the archive by default",
    (operation) => {
      const args = buildArgs(operation, withArchive)

      expect(args).toContain("--download-archive")
      expect(args[args.indexOf("--download-archive") + 1]).toBe(withArchive.archiveFile)
    }
  )

  test.each(["playlist-combined", "playlist-audio"])(
    "%s drops it entirely when the user asks for everything again",
    (operation) => {
      // omitted rather than pointed somewhere harmless: yt-dlp *writes* to the
      // archive it is given, so a decoy path would still record this run and
      // change what the next one does
      const args = buildArgs(operation, { ...withArchive, ignoreArchive: true })

      expect(args).not.toContain("--download-archive")
      expect(args).not.toContain(withArchive.archiveFile)
    }
  )

  test("only a literal true drops it", () => {
    // a missing key, a false, or anything truthy-but-not-true leaves the
    // resume behaviour exactly as it was
    for (const ignoreArchive of [undefined, false, "yes", 1, null]) {
      expect(buildArgs("playlist-combined", { ...withArchive, ignoreArchive })).toContain(
        "--download-archive"
      )
    }
  })
})

// =============================================================================
// parsers
// =============================================================================

describe("parsePlaylistProgressLine", () => {
  test("reads a captured line, item counters included", () => {
    expect(parsePlaylistProgressLine("CLIPLY|  0.1%| 775.00KiB/s|00:06|6|1")).toEqual({
      progress: 0.1,
      speed: "775.00KiB/s",
      eta: "00:06",
      etaSeconds: 6,
      itemIndex: 1
    })
  })

  test("survives the opening line, where yt-dlp knows neither speed nor eta", () => {
    // measured verbatim: the first line of an item that follows an archive skip
    expect(
      parsePlaylistProgressLine("CLIPLY|  0.0%| Unknown B/s|Unknown|NA|2")
    ).toMatchObject({
      progress: 0,
      speed: null,
      eta: null,
      etaSeconds: null,
      itemIndex: 2
    })
  })

  test("reports no counter when the field renders as NA", () => {
    expect(
      parsePlaylistProgressLine("CLIPLY| 40.0%|1.00MiB/s|00:10|10|NA")
    ).toMatchObject({ itemIndex: null })
  })

  test("a trailing field from an older template is ignored, not read", () => {
    // n_entries used to sit here. a fixture, or a binary we have not met, may
    // still print it - it must not become a denominator by the back door
    expect(parsePlaylistProgressLine("CLIPLY| 40.0%|1.00MiB/s|00:10|10|2|9")).toEqual({
      progress: 40,
      speed: "1.00MiB/s",
      eta: "00:10",
      etaSeconds: 10,
      itemIndex: 2
    })
  })

  test("is not a progress line", () => {
    expect(parsePlaylistProgressLine("[download] Downloading item 1 of 2")).toBeNull()
    expect(parsePlaylistProgressLine("CLIPLY_FILE|1|/downloads/a.mp4")).toBeNull()
  })

  test("the single-video parser reads a playlist line without changing", () => {
    // the two templates share their first four fields on purpose, so the
    // existing parser stays correct on a playlist line and needs no edit
    expect(parseProgressLine("CLIPLY|  0.1%| 775.00KiB/s|00:06|6|1")).toEqual({
      progress: 0.1,
      speed: "775.00KiB/s",
      eta: "00:06",
      etaSeconds: 6
    })
  })
})

describe("parsePlaylistStreamLine", () => {
  test("reads the captured before_dl marker", () => {
    expect(parsePlaylistStreamLine("CLIPLY_STREAM|1|1|TeVE4TQPEwM|134+140")).toEqual({
      itemIndex: 1,
      playlistIndex: 1,
      videoId: "TeVE4TQPEwM",
      streams: 2
    })
  })

  test("keeps playlist_index apart from the autonumber", () => {
    // the sparse-selection case: item 3 of 3, sitting at position 9
    expect(parsePlaylistStreamLine("CLIPLY_STREAM|3|9|Hs5IuUOs2y4|18")).toMatchObject({
      itemIndex: 3,
      playlistIndex: 9,
      streams: 1
    })
  })

  test("is not a marker line", () => {
    expect(parsePlaylistStreamLine("CLIPLY| 10.0%|1.00MiB/s|00:01|1|1")).toBeNull()
    expect(parsePlaylistStreamLine("CLIPLY_STREAM|1|1|abc|")).toBeNull()
  })
})

describe("parsePlaylistFileLine", () => {
  test("reads the captured after_move print", () => {
    expect(
      parsePlaylistFileLine('CLIPLY_FILE|2|"/downloads/list/002 - Why I Love My Bad Days.mp4"')
    ).toEqual({
      itemIndex: 2,
      filePath: "/downloads/list/002 - Why I Love My Bad Days.mp4"
    })
  })

  test("a newline inside a legal directory name survives", () => {
    // yt-dlp sanitises the components it derives from a title, but not the -P
    // the user chose. %(filepath)j is what keeps such a path on one line
    // instead of truncating the marker at the newline. measured: a directory
    // literally named "nl\ndir" prints \n rather than a line break
    expect(parsePlaylistFileLine('CLIPLY_FILE|1|"/tmp/nl\\ndir/001 - t.mp4"')).toEqual({
      itemIndex: 1,
      filePath: "/tmp/nl\ndir/001 - t.mp4"
    })
  })

  test("the escapes yt-dlp writes for real titles decode back", () => {
    // the same conversion escapes non-ascii, so the fixtures are pure ascii
    // and an em-dash or a fullwidth pipe in a title round-trips exactly
    expect(
      parsePlaylistFileLine('CLIPLY_FILE|1|"/d/001 - a \\u2014 b \\uff5c c.mp4"')
    ).toMatchObject({ filePath: "/d/001 - a — b ｜ c.mp4" })
  })

  test("a pipe in a path is not a separator", () => {
    expect(parsePlaylistFileLine('CLIPLY_FILE|1|"/downloads/a|b.mp4"')).toEqual({
      itemIndex: 1,
      filePath: "/downloads/a|b.mp4"
    })
  })

  test("is not a file line", () => {
    expect(parsePlaylistFileLine("CLIPLY_FILE|1|")).toBeNull()
    expect(parsePlaylistFileLine("[download] Destination: /downloads/a.f134.mp4")).toBeNull()
  })

  test("anything that is not a json string is refused", () => {
    // the unquoted shape is what the template printed before it was framed;
    // accepting it would quietly re-open the truncation it was framed against
    expect(parsePlaylistFileLine("CLIPLY_FILE|1|/downloads/a.mp4")).toBeNull()
    expect(parsePlaylistFileLine('CLIPLY_FILE|1|"/downloads/a.mp4')).toBeNull()
    expect(parsePlaylistFileLine("CLIPLY_FILE|1|123")).toBeNull()
    expect(parsePlaylistFileLine('CLIPLY_FILE|1|{"path":"/a.mp4"}')).toBeNull()
    expect(parsePlaylistFileLine('CLIPLY_FILE|1|""')).toBeNull()
  })
})

describe("parseArchiveSkipLine", () => {
  test("reads the video id out of the captured archive skip", () => {
    expect(
      parseArchiveSkipLine(
        "[download] TeVE4TQPEwM: The Power of Imagination — Onstage and Off | " +
          "Suki Hillier | TED has already been recorded in the archive"
      )
    ).toBe("TeVE4TQPEwM")
  })

  test("a title full of colons does not become the id", () => {
    expect(
      parseArchiveSkipLine(
        "[download] kz-I5zIGbj4: Why: A Talk: In Parts has already been recorded in the archive"
      )
    ).toBe("kz-I5zIGbj4")
  })

  test("an item with no title left to print is still an archive skip", () => {
    // yt-dlp builds the line with format_field(info, "title", "%s "), which is
    // "" for a null title - a video archived while it was public and private
    // since prints exactly this
    expect(
      parseArchiveSkipLine("[download] TeVE4TQPEwM: has already been recorded in the archive")
    ).toBe("TeVE4TQPEwM")
  })

  test("is not an archive skip", () => {
    expect(parseArchiveSkipLine("[download] /downloads/a.mp4 has already been downloaded")).toBeNull()
    expect(parseArchiveSkipLine("[download] Downloading item 1 of 2")).toBeNull()
  })
})

// =============================================================================
// expectedStreamCount
// =============================================================================

describe("expectedStreamCount", () => {
  test("a playlist video item merges two streams, exactly as a single video does", () => {
    // this is the opening guess for *each item*, not for the run: every item
    // re-runs the 1-or-2-sweep cycle from scratch
    expect(expectedStreamCount("playlist-combined", PLAYLIST)).toBe(2)
    expect(expectedStreamCount("playlist-audio", PLAYLIST)).toBe(1)
  })

  test("single-video answers are unchanged", () => {
    expect(expectedStreamCount("combined", {})).toBe(2)
    expect(expectedStreamCount("combined", { timeRange: { start: 0, end: 5 } })).toBe(1)
    expect(expectedStreamCount("audio", {})).toBe(1)
    expect(expectedStreamCount("simple", {})).toBe(1)
    expect(expectedStreamCount("info", {})).toBe(1)
  })
})

// =============================================================================
// the aggregator
// =============================================================================

describe("PlaylistProgressTracker", () => {
  test("overall progress folds the item into the run", () => {
    const tracker = new PlaylistProgressTracker({ expectedStreams: 1, totalItems: 4 })

    tracker.startItem({ itemIndex: 1, playlistIndex: 1, videoId: "a", streams: 1 })
    const half = tracker.update({ progress: 50, itemIndex: 1 })

    // (0 completed + 0.5 of this one) / 4
    expect(half).toMatchObject({
      itemProgress: 50,
      itemsCompleted: 0,
      totalItems: 4,
      itemIndex: 1,
      overallProgress: 12.5
    })

    tracker.completeItem(1)
    tracker.startItem({ itemIndex: 2, playlistIndex: 2, videoId: "b", streams: 1 })

    expect(tracker.update({ progress: 50, itemIndex: 2 })).toMatchObject({
      itemsCompleted: 1,
      overallProgress: 37.5
    })
  })

  test("the per-item stream counter resets on each marker", () => {
    const tracker = new PlaylistProgressTracker({ expectedStreams: 2, totalItems: 2 })

    tracker.startItem({ itemIndex: 1, streams: 2 })
    tracker.update({ progress: 100 })
    // the backwards jump is yt-dlp moving to the second stream of item 1
    expect(tracker.update({ progress: 5 })).toMatchObject({ streamIndex: 1 })

    tracker.completeItem(1)
    tracker.startItem({ itemIndex: 2, streams: 2 })

    // without a reset this would still read 1, and item 2 would open at 50%
    expect(tracker.update({ progress: 5 })).toMatchObject({
      streamIndex: 0,
      itemProgress: 2.5
    })
  })

  test("a sparse selection counts queue position, not playlist position", () => {
    // -I "1,5,9": autonumber 1,2,3 against n_entries 3, while playlist_index
    // reads 1,5,9. the denominator is n_entries, so the last item is 3 of 3
    const tracker = new PlaylistProgressTracker({ expectedStreams: 1, totalItems: 3 })

    tracker.startItem({ itemIndex: 3, playlistIndex: 9, videoId: "c", streams: 1 })
    const update = tracker.update({ progress: 100, itemIndex: 3 })

    expect(update.itemIndex).toBe(3)
    expect(update.totalItems).toBe(3)
    expect(update.playlistIndex).toBe(9)
    expect(update.overallProgress).toBe(100)
  })

  test("an item that never finishes still moves the run forward", () => {
    // a private video prints no progress and no after_move at all. the next
    // item's marker is what says the previous one is done with, however it
    // ended - otherwise the bar freezes for the rest of the run
    const tracker = new PlaylistProgressTracker({ expectedStreams: 1, totalItems: 3 })

    tracker.startItem({ itemIndex: 1, streams: 1 })
    tracker.update({ progress: 100 })
    tracker.completeItem(1)

    // item 2 fails during extraction: nothing at all is printed for it
    tracker.startItem({ itemIndex: 3, streams: 1 })

    expect(tracker.snapshot()).toMatchObject({
      itemsCompleted: 2,
      itemIndex: 3,
      overallProgress: 66.7
    })
  })

  test("overall progress never goes backwards", () => {
    const tracker = new PlaylistProgressTracker({ expectedStreams: 2, totalItems: 3 })
    let last = 0

    for (const line of syntheticStream({ items: 3, saved: 3 }).trim().split("\n")) {
      const marker = parsePlaylistStreamLine(line)
      if (marker) {
        tracker.startItem(marker)
        expect(tracker.snapshot().overallProgress).toBeGreaterThanOrEqual(last)
        last = tracker.snapshot().overallProgress
        continue
      }

      const file = parsePlaylistFileLine(line)
      if (file) {
        tracker.completeItem(file.itemIndex)
        continue
      }

      const update = tracker.update(parsePlaylistProgressLine(line))
      expect(update.overallProgress).toBeGreaterThanOrEqual(last)
      last = update.overallProgress
    }

    expect(last).toBe(100)
  })
})

// =============================================================================
// outcome
// =============================================================================
// a real workspace on disk. the outcome no longer comes from anything the
// tests can fake in a string: saves are read out of the record file yt-dlp
// appends to, and every one of them is checked against the real filesystem.
// so these build real directories and real files rather than stubbing fs
const workspaces = []

function workspace() {
  // realpath because macos hands out /var/folders/... for a /private/var path,
  // and the engine resolves both sides before comparing them
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cliply-pl-")))
  const outputDir = path.join(root, "out")
  const userDataPath = path.join(root, "ud")

  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(userDataPath, { recursive: true })
  workspaces.push(root)

  return { root, outputDir, userDataPath }
}

afterEach(() => {
  while (workspaces.length) {
    fs.rmSync(workspaces.pop(), { recursive: true, force: true })
  }
})

// put a real file where yt-dlp would have put one
function saveFile(dir, name, contents = "media") {
  const filePath = path.join(dir, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
  return filePath
}

// the record file's own shape: "<autonumber>|<json path>" per line
function recordLines(entries) {
  return `${entries.map(([item, file]) => `${item}|${JSON.stringify(file)}`).join("\n")}\n`
}

/**
 * run one playlist download against a fake yt-dlp in a real workspace
 *
 * `records` is written to the file the engine told yt-dlp to append to, after
 * the run has started and before the child exits - which is exactly when
 * yt-dlp would have written it
 */
async function playlistRun({
  stdout = "",
  stderr = "",
  exitCode = 0,
  operation = "playlist-combined",
  params = {},
  records = null,
  operationId = "op-test",
  engineOptions = {}
} = {}) {
  const space = params.outputDir ? null : workspace()
  const resolved = {
    ...PLAYLIST,
    ...(space ? { outputDir: space.outputDir } : {}),
    ...params
  }

  const spawnFn = createSpawner()
  const engine = createEngine(spawnFn, {
    ...(space ? { userDataPath: space.userDataPath } : {}),
    ...engineOptions
  })
  const handle = engine.run(operation, resolved, { id: operationId })

  await settle()

  const progress = []
  handle.on("progress", (update) => progress.push(update))

  if (records !== null) {
    fs.writeFileSync(handle.recordsFile, records)
  }

  const child = spawnFn.children[0]
  if (stderr) child.complain(stderr)
  if (stdout) child.say(stdout)
  // a fixture is thousands of bytes: give the stream more than one tick to
  // hand all of it over before the close event lands
  await settle()
  await settle()

  const recordsFile = handle.recordsFile
  child.exit(exitCode)

  let result = null
  let error = null
  try {
    result = await handle.promise
  } catch (caught) {
    error = caught
  }

  return { result, error, progress, handle, child, space, recordsFile, engine }
}

// =============================================================================
// where a save comes from
// =============================================================================

describe("saves are read from the record file, never from stdout", () => {
  test("the playlist operations ask yt-dlp to keep the record", () => {
    const args = buildArgs("playlist-combined", {
      ...PLAYLIST,
      recordsFile: "/ud/playlists/runs/op1.records"
    })

    const flag = args.indexOf("--print-to-file")
    expect(flag).toBeGreaterThan(-1)
    expect(args[flag + 1]).toBe(PLAYLIST_RECORD_TEMPLATE)
    expect(args[flag + 2]).toBe("/ud/playlists/runs/op1.records")
  })

  test("a percent sign in the path cannot become a template field", () => {
    // FILE takes output-template syntax, so an unescaped %(id)s in a folder
    // name would be *expanded* and the records would land somewhere else
    const args = buildArgs("playlist-combined", {
      ...PLAYLIST,
      recordsFile: "/ud/100%(id)s/op1.records"
    })

    expect(args[args.indexOf("--print-to-file") + 2]).toBe("/ud/100%%(id)s/op1.records")
  })

  test.each(["combined", "audio", "simple", "info"])("%s keeps no record file", (operation) => {
    expect(buildArgs(operation, { ...SINGLE, recordsFile: "/ud/op1.records" })).not.toContain(
      "--print-to-file"
    )
  })

  test("the record file is the only thing that counts as a save", async () => {
    // the reviewer's reproduction: an unrelated file really is inside the
    // download folder, and a correctly framed marker for it really is on
    // stdout, because --no-quiet prints metadata we did not write. existence
    // and containment both pass. it is still not a save, because yt-dlp's own
    // after_move hook never recorded it
    const space = workspace()
    const decoy = saveFile(space.outputDir, "unrelated.mp4")

    const { result, error } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1] },
      engineOptions: { userDataPath: space.userDataPath },
      stdout: `CLIPLY_FILE|1|${JSON.stringify(decoy)}\n`,
      stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden\n",
      exitCode: 1,
      records: null
    })

    expect(result).toBeNull()
    expect(error.itemsSaved).toBe(0)
    expect(error.files).toEqual([])
  })

  test("a record for a real file that yt-dlp really wrote counts", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - One.mp4")
    const two = saveFile(space.outputDir, "list/002 - Two.mp4")

    const { result, error } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1, 2] },
      engineOptions: { userDataPath: space.userDataPath },
      records: recordLines([
        [1, one],
        [2, two]
      ]),
      exitCode: 0
    })

    expect(error).toBeNull()
    expect(result.itemsSaved).toBe(2)
    expect(result.files).toEqual([one, two])
    // the result's own filePath follows the records too, not stdout
    expect(result.filePath).toBe(two)
  })

  test("no record file at all is no saves, not an error", async () => {
    // a run in which yt-dlp never reached after_move never creates the file
    const { error } = await playlistRun({
      exitCode: 0,
      records: null
    })

    expect(error.itemsSaved).toBe(0)
    expect(error.code).toBe(ERROR_CODES.DOWNLOAD_FAILED)
  })

  test("a record naming a file outside the download folder is refused", async () => {
    const space = workspace()
    const outside = saveFile(space.root, "outside.mp4")

    const { error } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1] },
      engineOptions: { userDataPath: space.userDataPath },
      records: recordLines([[1, outside]]),
      exitCode: 1
    })

    expect(error.itemsSaved).toBe(0)
  })

  test("a symlink cannot smuggle a file in from outside", async () => {
    // path.resolve collapses ".." but does not follow links, and statSync
    // does - so a link inside the folder pointing out of it passed both of
    // the checks this replaces. realpath is what actually settles containment
    const space = workspace()
    const outside = saveFile(space.root, "outside.mp4")
    const link = path.join(space.outputDir, "linked.mp4")
    fs.symlinkSync(outside, link)

    const { error } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1] },
      engineOptions: { userDataPath: space.userDataPath },
      records: recordLines([[1, link]]),
      exitCode: 1
    })

    expect(error.itemsSaved).toBe(0)
  })

  test("a download folder that is itself a symlink still works", () => {
    // the other half of resolving both sides: a user whose Downloads folder is
    // a link must not have every save refused
    const space = workspace()
    const real = path.join(space.root, "real-out")
    const linked = path.join(space.root, "linked-out")
    fs.mkdirSync(real)
    fs.symlinkSync(real, linked)
    const saved = saveFile(real, "001 - One.mp4")

    expect(verifySavedFile(saved, linked)).toBe(saved)
  })

  test("a directory wearing a media name is not a save", async () => {
    const space = workspace()
    const notAFile = path.join(space.outputDir, "directory.mp4")
    fs.mkdirSync(notAFile)

    const { error } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1] },
      engineOptions: { userDataPath: space.userDataPath },
      records: recordLines([[1, notAFile]]),
      exitCode: 1
    })

    expect(error.itemsSaved).toBe(0)
  })

  test("a file that was already on disk still counts when it was recorded", async () => {
    // the "already downloaded" case, which is the whole reason the file's own
    // age is not a test. a re-run over files that are already there fires
    // after_move for each of them and leaves their mtimes alone - measured
    // against the shipped binary - so an "is this newer than the run" rule
    // would fail every legitimate second download. what ties a record to this
    // run is the record file, which is created per run and cleared before the
    // spawn, not the timestamp on the file it names
    const space = workspace()
    const old = saveFile(space.outputDir, "001 - Old.mp4")
    const longAgo = Date.now() / 1000 - 3600
    fs.utimesSync(old, longAgo, longAgo)

    const { result } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1] },
      engineOptions: { userDataPath: space.userDataPath },
      records: recordLines([[1, old]]),
      exitCode: 0
    })

    expect(result.itemsSaved).toBe(1)
    expect(result.files).toEqual([old])
  })

  test("one unreadable record does not lose the others", async () => {
    const space = workspace()
    const good = saveFile(space.outputDir, "002 - Two.mp4")

    const { result } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1, 2] },
      engineOptions: { userDataPath: space.userDataPath },
      records: `1|not json\n${recordLines([[2, good]])}`,
      exitCode: 1
    })

    expect(result.itemsSaved).toBe(1)
    expect(result.files).toEqual([good])
  })

  test("the record file is cleaned up when the run settles", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "001 - One.mp4")

    const { recordsFile } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1] },
      engineOptions: { userDataPath: space.userDataPath },
      records: recordLines([[1, one]]),
      exitCode: 0
    })

    expect(fs.existsSync(recordsFile)).toBe(false)
  })

  test("...and when it fails, and when it is cancelled", async () => {
    const failed = await playlistRun({ records: "", exitCode: 1 })
    expect(fs.existsSync(failed.recordsFile)).toBe(false)

    const space = workspace()
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { userDataPath: space.userDataPath })
    const handle = engine.run(
      "playlist-combined",
      { ...PLAYLIST, outputDir: space.outputDir },
      { id: "cancelled-run" }
    )

    await settle()
    fs.writeFileSync(handle.recordsFile, "")
    handle.cancel()
    spawnFn.children[0].exit(null)
    await handle.promise.catch(() => {})

    expect(fs.existsSync(handle.recordsFile)).toBe(false)
  })

  test("a run whose record file cannot be prepared never starts", async () => {
    // the provenance argument only holds if the file is *proven* fresh. a
    // removal that silently failed left the path pointing at a readable old
    // record, and a run whose download failed then resolved as having saved
    // the previous run's file. there is no safe way to continue from here:
    // either the channel is fresh or the run does not happen
    const space = workspace()
    const ghost = saveFile(space.outputDir, "001 - Ghost.mp4")
    const recordsFile = buildPlaylistRecordsPath({
      userDataPath: space.userDataPath,
      operationId: "locked"
    })
    const runsDir = path.dirname(recordsFile)

    fs.mkdirSync(runsDir, { recursive: true })
    fs.writeFileSync(recordsFile, recordLines([[1, ghost]]))
    // readable, but nothing inside it can be unlinked or replaced
    fs.chmodSync(runsDir, 0o555)

    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { userDataPath: space.userDataPath })
    const handle = engine.run(
      "playlist-combined",
      { ...PLAYLIST, outputDir: space.outputDir, playlistIndices: [1] },
      { id: "locked" }
    )

    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_ERROR
    })

    // and yt-dlp was never asked to do anything
    expect(spawnFn.calls).toHaveLength(0)

    fs.chmodSync(runsDir, 0o755)
  })

  test("a records path occupied by a directory rejects too", async () => {
    const space = workspace()
    const recordsFile = buildPlaylistRecordsPath({
      userDataPath: space.userDataPath,
      operationId: "occupied"
    })

    fs.mkdirSync(recordsFile, { recursive: true })

    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { userDataPath: space.userDataPath })
    const handle = engine.run(
      "playlist-combined",
      { ...PLAYLIST, outputDir: space.outputDir, playlistIndices: [1] },
      { id: "occupied" }
    )

    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_ERROR
    })
    expect(spawnFn.calls).toHaveLength(0)
  })

  test("the record file starts empty, and starts existing", async () => {
    const space = workspace()
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { userDataPath: space.userDataPath })
    const handle = engine.run(
      "playlist-combined",
      { ...PLAYLIST, outputDir: space.outputDir, playlistIndices: [1] },
      { id: "fresh" }
    )

    // created rather than merely absent, so "we could not write it" and "yt-dlp
    // wrote nothing" are different states from here on
    // synchronously, before the spawn: preparation is what decides whether
    // there is a run at all
    expect(fs.existsSync(handle.recordsFile)).toBe(true)
    expect(fs.readFileSync(handle.recordsFile, "utf8")).toBe("")

    await settle()
    handle.cancel()
    spawnFn.children[0].exit(null)
    await handle.promise.catch(() => {})
  })

  test("a stale record file from a crashed run is not read as this run's", async () => {
    // --print-to-file appends, so a repeated operation id would otherwise
    // inherit whatever the previous run left behind
    const space = workspace()
    const ghost = saveFile(space.outputDir, "001 - Ghost.mp4")
    const recordsFile = buildPlaylistRecordsPath({
      userDataPath: space.userDataPath,
      operationId: "repeated"
    })

    fs.mkdirSync(path.dirname(recordsFile), { recursive: true })
    fs.writeFileSync(recordsFile, recordLines([[1, ghost]]))

    const { error } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1] },
      engineOptions: { userDataPath: space.userDataPath },
      operationId: "repeated",
      records: null,
      exitCode: 1
    })

    expect(error.itemsSaved).toBe(0)
  })
})

describe("the captured record file", () => {
  test("parses to what the binary wrote", () => {
    const records = fixture("playlist-run-complete.records")
      .split("\n")
      .filter(Boolean)
      .map(parsePlaylistRecordLine)

    expect(records).toHaveLength(2)
    expect(records[0].itemIndex).toBe(1)
    expect(records[1].itemIndex).toBe(2)
    // the escapes the j conversion writes decode back to the real characters
    expect(records[0].filePath).toContain("The Power of Imagination — Onstage and Off")
    expect(records[1].filePath).toContain("Why I Love My Bad Days ｜ Alexi Pappas")
  })

  test("the partial run recorded exactly the one item that landed", () => {
    const records = fixture("playlist-run-partial.records").split("\n").filter(Boolean)

    expect(records).toHaveLength(1)
    expect(parsePlaylistRecordLine(records[0])).toMatchObject({ itemIndex: 1 })
  })

  test("a record line is refused unless it is what our template prints", () => {
    expect(parsePlaylistRecordLine("1|/downloads/a.mp4")).toBeNull()
    expect(parsePlaylistRecordLine('1|"/downloads/a.mp4')).toBeNull()
    expect(parsePlaylistRecordLine('1|""')).toBeNull()
    expect(parsePlaylistRecordLine("1|123")).toBeNull()
    expect(parsePlaylistRecordLine("")).toBeNull()
    expect(parsePlaylistRecordLine('"/downloads/a.mp4"')).toBeNull()
  })
})

// =============================================================================
// where reuse comes from
// =============================================================================

describe("reuse is computed from the archive, never from stdout", () => {
  test("reads the ids the archive already holds", () => {
    const space = workspace()
    const archive = path.join(space.root, "arc.txt")
    fs.writeFileSync(archive, "youtube TeVE4TQPEwM\nyoutube kz-I5zIGbj4\n\n")

    const ids = readArchivedIds(archive)

    expect(ids.has("TeVE4TQPEwM")).toBe(true)
    expect(ids.has("kz-I5zIGbj4")).toBe(true)
    expect(ids.size).toBe(2)
  })

  test("a missing archive is an empty set, not a failure", () => {
    expect(readArchivedIds("/nowhere/arc.txt").size).toBe(0)
    expect(readArchivedIds(null).size).toBe(0)
  })

  test("an id from another site is not this id", () => {
    // yt-dlp's archive key is the extractor *and* the id, and it skips on the
    // pair. keeping only the id made a vimeo entry vouch for a youtube video
    // that shares its eleven characters, so a run that really did download
    // nothing reported it as already had
    const space = workspace()
    const archive = path.join(space.root, "arc.txt")
    fs.writeFileSync(archive, "vimeo aaaaaaaaaaa\nyoutube bbbbbbbbbbb\n")

    const ids = readArchivedIds(archive)

    expect(ids.has("aaaaaaaaaaa")).toBe(false)
    expect(ids.has("bbbbbbbbbbb")).toBe(true)
  })

  test("a line that is not exactly `youtube <id>` is not an archive record", () => {
    const space = workspace()
    const archive = path.join(space.root, "arc.txt")
    fs.writeFileSync(
      archive,
      [
        "youtube aaaaaaaaaaa extra",
        "youtube",
        "youtube_tab bbbbbbbbbbb",
        "  ",
        "ccccccccccc"
      ].join("\n")
    )

    expect(readArchivedIds(archive).size).toBe(0)
  })

  test("crlf endings and blank lines do not hide a real entry", () => {
    const space = workspace()
    const archive = path.join(space.root, "arc.txt")
    fs.writeFileSync(archive, "vimeo aaaaaaaaaaa\r\n\r\nyoutube bbbbbbbbbbb\r\n")

    expect([...readArchivedIds(archive)]).toEqual(["bbbbbbbbbbb"])
  })

  test("a foreign archive entry buys the selection nothing", async () => {
    const space = workspace()
    const archive = path.join(space.root, "arc.txt")
    fs.writeFileSync(archive, "vimeo aaaaaaaaaaa\r\n\r\nyoutube unselectedid\r\n")

    const { result, error } = await playlistRun({
      params: {
        outputDir: space.outputDir,
        archiveFile: archive,
        playlistEntries: [{ index: 1, id: "aaaaaaaaaaa" }]
      },
      engineOptions: { userDataPath: space.userDataPath },
      stderr: "ERROR: Video unavailable\n",
      records: null,
      exitCode: 1
    })

    expect(result).toBeNull()
    expect(error.itemsReused).toBe(0)
    expect(error.itemsSaved).toBe(0)
  })

  test("counts selected positions, so one video twice counts twice", () => {
    const archived = new Set(["aaaaaaaaaaa"])
    const entries = [
      { index: 1, id: "aaaaaaaaaaa" },
      { index: 4, id: "bbbbbbbbbbb" },
      { index: 7, id: "aaaaaaaaaaa" }
    ]

    expect(countArchivedSelections(entries, archived)).toBe(2)
  })

  test("no entries means no claim about reuse", () => {
    // the caller sent positions but no ids, so there is nothing to match on.
    // zero is the safe answer: it undercounts rather than inventing reuse
    expect(countArchivedSelections(null, new Set(["a"]))).toBe(0)
    expect(countArchivedSelections([], new Set(["a"]))).toBe(0)
  })

  test("an archived selection is reported as reuse and the run completes", async () => {
    const space = workspace()
    const archive = path.join(space.root, "arc.txt")
    fs.writeFileSync(archive, "youtube aaaaaaaaaaa\nyoutube bbbbbbbbbbb\n")

    const { result, error } = await playlistRun({
      params: {
        outputDir: space.outputDir,
        archiveFile: archive,
        playlistEntries: [
          { index: 1, id: "aaaaaaaaaaa" },
          { index: 2, id: "bbbbbbbbbbb" }
        ]
      },
      engineOptions: { userDataPath: space.userDataPath },
      stdout: fixture("playlist-run-archive-skip.stdout"),
      records: null,
      exitCode: 0
    })

    expect(error).toBeNull()
    expect(result.itemsSaved).toBe(0)
    expect(result.itemsReused).toBe(2)
    expect(result.itemsSkipped).toBe(0)
    expect(result.itemsTotal).toBe(2)
    expect(result.files).toEqual([])
  })

  test("a forged archive sentence on stdout buys nothing", async () => {
    // the reviewer's second reproduction: a multiline playlist title carrying
    // an archive-skip-shaped line, printed verbatim three times by the binary,
    // on a run with no --download-archive at all
    const forged = "[download] aaaaaaaaaaa: A Talk has already been recorded in the archive"

    const { result, error } = await playlistRun({
      stdout: [forged, forged, forged, ""].join("\n"),
      stderr: "ERROR: Video unavailable\n",
      exitCode: 1,
      params: { playlistIndices: [1] },
      records: null
    })

    expect(result).toBeNull()
    expect(error.itemsReused).toBe(0)
    expect(error.itemsSaved).toBe(0)
    expect(error.itemsTotal).toBe(1)
  })

  test("asking to ignore the archive means nothing is reused", async () => {
    const space = workspace()
    const archive = path.join(space.root, "arc.txt")
    fs.writeFileSync(archive, "youtube aaaaaaaaaaa\n")

    const { error } = await playlistRun({
      params: {
        outputDir: space.outputDir,
        archiveFile: archive,
        ignoreArchive: true,
        playlistEntries: [{ index: 1, id: "aaaaaaaaaaa" }]
      },
      engineOptions: { userDataPath: space.userDataPath },
      records: null,
      exitCode: 1
    })

    // the whole point of the option: this item is going to be downloaded again
    expect(error.itemsReused).toBe(0)
  })

  test("playlistEntries drive the selection just as indices do", () => {
    const entries = [
      { index: 1, id: "aaaaaaaaaaa" },
      { index: 2, id: "bbbbbbbbbbb" },
      { index: 4, id: "ccccccccccc" }
    ]
    const fromEntries = buildArgs("playlist-combined", {
      ...PLAYLIST,
      playlistIndices: undefined,
      playlistEntries: entries
    })

    expect(fromEntries[fromEntries.indexOf("-I") + 1]).toBe("1,2,4")
    expect(fromEntries).toEqual(
      buildArgs("playlist-combined", { ...PLAYLIST, playlistIndices: [1, 2, 4] })
    )
  })
})

// =============================================================================
// outcome
// =============================================================================

describe("playlist outcome", () => {
  test("a clean run reports every file it saved", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - The Power of Imagination.mp4")
    const two = saveFile(space.outputDir, "list/002 - Why I Love My Bad Days.mp4")

    const { result, error, progress } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1, 2] },
      engineOptions: { userDataPath: space.userDataPath },
      stdout: fixture("playlist-run-complete.stdout"),
      records: recordLines([
        [1, one],
        [2, two]
      ]),
      exitCode: 0
    })

    expect(error).toBeNull()
    expect(result.itemsSaved).toBe(2)
    expect(result.itemsReused).toBe(0)
    expect(result.itemsTotal).toBe(2)
    expect(result.itemsSkipped).toBe(0)
    expect(result.files).toEqual([one, two])

    // the stdout markers still drive the bar, which is all they do now
    const overall = progress.map((update) => update.overallProgress)
    expect(overall).toEqual([...overall].sort((a, b) => a - b))
    expect(overall[overall.length - 1]).toBe(100)
  })

  test("8 of 9 saved on exit 1 is a completed download with a skip", async () => {
    const space = workspace()
    const saved = []
    for (let item = 1; item <= 8; item += 1) {
      saved.push([item, saveFile(space.outputDir, `00${item} - Talk ${item}.mp4`)])
    }

    const { result, error } = await playlistRun({
      params: {
        outputDir: space.outputDir,
        playlistIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9]
      },
      engineOptions: { userDataPath: space.userDataPath },
      stdout: syntheticStream({ items: 9, saved: 8 }),
      stderr: "ERROR: [youtube] mt7rGhAm2CY: Private video\n",
      records: recordLines(saved),
      exitCode: 1
    })

    expect(error).toBeNull()
    expect(result.exitCode).toBe(1)
    expect(result.itemsSaved).toBe(8)
    expect(result.itemsSkipped).toBe(1)
    expect(result.itemsTotal).toBe(9)
    expect(result.files).toHaveLength(8)
  })

  test("the measured partial run: one saved, two private, exit 1", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "005 - Google Year in Search 2014.mp4")

    const { result, error } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [5, 6, 7] },
      engineOptions: { userDataPath: space.userDataPath },
      stdout: fixture("playlist-run-partial.stdout"),
      stderr: fixture("playlist-run-partial.stderr"),
      records: recordLines([[1, one]]),
      exitCode: 1
    })

    expect(error).toBeNull()
    expect(result.itemsSaved).toBe(1)
    expect(result.itemsTotal).toBe(3)
    expect(result.itemsSkipped).toBe(2)

    // a partial success is the one outcome that drops the reason with it, so
    // the stderr tail rides along for a caller that wants to classify() it
    expect(result.stderr).toContain("Private video")
  })

  test("nothing saved is still a failure, classified exactly as today", async () => {
    const { result, error } = await playlistRun({
      stdout: "[download] Downloading item 1 of 2\n",
      stderr: "ERROR: Sign in to confirm you're not a bot. Use --cookies\n",
      exitCode: 1,
      records: null
    })

    expect(result).toBeNull()
    expect(error.code).toBe(ERROR_CODES.BOT_DETECTION)
    expect(error.needsCookies).toBe(true)
    expect(error.files).toEqual([])
    expect(error.itemsSaved).toBe(0)
  })

  test("a run that saved nothing is a failure even on exit 0", async () => {
    const { result, error } = await playlistRun({
      stdout: "[download] Downloading playlist: Short talks\n",
      exitCode: 0,
      params: { playlistIndices: [99] },
      records: null
    })

    expect(result).toBeNull()
    expect(error.code).toBe(ERROR_CODES.DOWNLOAD_FAILED)
    expect(error.details).toMatch(/without saving/)
  })

  test("a full stderr buffer does not evict the real cause", async () => {
    // the diagnostic is never pushed into the bounded buffer: with a bot
    // error followed by 199 neutral lines, one more push would drop the only
    // line that says what happened, and the rejection would come back generic
    const lines = ["ERROR: Sign in to confirm you're not a bot. Use --cookies"]
    for (let index = 0; index < 199; index += 1) {
      lines.push(`[youtube] progress line ${index}`)
    }

    const { error } = await playlistRun({
      stderr: `${lines.join("\n")}\n`,
      exitCode: 0,
      records: null
    })

    expect(error.code).toBe(ERROR_CODES.BOT_DETECTION)
    expect(error.needsCookies).toBe(true)
  })

  test("a cancel keeps the files that already landed", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - One.mp4")

    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { userDataPath: space.userDataPath })
    const handle = engine.run("playlist-combined", {
      ...PLAYLIST,
      outputDir: space.outputDir,
      playlistIndices: [1, 2, 3]
    })

    await settle()
    fs.writeFileSync(handle.recordsFile, recordLines([[1, one]]))

    const child = spawnFn.children[0]
    child.say('CLIPLY_STREAM|1|1|aaaaaaaaaaa|134+140\n')
    child.say("CLIPLY| 40.0%|1.00MiB/s|00:10|10|2\n")
    await settle()

    handle.cancel()
    child.exit(null)

    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED,
      files: [one],
      itemsSaved: 1,
      itemsTotal: 3
    })
  })

  test("a killed process is a failure, however much it had saved", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - One.mp4")

    const { result, error } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1, 2] },
      engineOptions: { userDataPath: space.userDataPath },
      stderr: "ERROR: something went wrong\n",
      records: recordLines([[1, one]]),
      exitCode: null
    })

    expect(result).toBeNull()
    expect(error.code).toBe(ERROR_CODES.DOWNLOAD_FAILED)
    expect(error.files).toEqual([one])
    expect(error.itemsSaved).toBe(1)
    expect(error.itemsTotal).toBe(2)
    expect(error.itemsSkipped).toBe(1)
    // it saved something, so the empty-run wording would be a contradiction
    expect(error.details).not.toMatch(/without saving/)
  })

  test("saved, reused and skipped are three separate counts", async () => {
    const space = workspace()
    const archive = path.join(space.root, "arc.txt")
    fs.writeFileSync(archive, "youtube aaaaaaaaaaa\n")
    const two = saveFile(space.outputDir, "002 - Two.mp4")
    const three = saveFile(space.outputDir, "003 - Three.mp4")

    const { result } = await playlistRun({
      params: {
        outputDir: space.outputDir,
        archiveFile: archive,
        playlistEntries: [
          { index: 1, id: "aaaaaaaaaaa" },
          { index: 2, id: "bbbbbbbbbbb" },
          { index: 3, id: "ccccccccccc" },
          { index: 4, id: "ddddddddddd" }
        ]
      },
      engineOptions: { userDataPath: space.userDataPath },
      stderr: "ERROR: [youtube] ddddddddddd: Private video\n",
      records: recordLines([
        [2, two],
        [3, three]
      ]),
      exitCode: 1
    })

    expect(result.itemsSaved).toBe(2)
    expect(result.itemsReused).toBe(1)
    expect(result.itemsSkipped).toBe(1)
    expect(result.itemsTotal).toBe(4)
  })

  test("the denominator is what the user selected, whatever the stream says", async () => {
    // three ticked, and the run reports two: an item that left the playlist
    // between the listing and the download. "2 of 2 saved" would quietly
    // redefine the job as the smaller one that happened to be possible, so
    // the vanished item is one of the skipped and the summary says so.
    // it is also the last number on stdout that could be forged
    const space = workspace()
    const one = saveFile(space.outputDir, "001 - One.mp4")
    const two = saveFile(space.outputDir, "002 - Two.mp4")

    const { result, progress } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1, 2, 3] },
      engineOptions: { userDataPath: space.userDataPath },
      stdout: [
        "CLIPLY_STREAM|1|1|aaaaaaaaaaa|18",
        // the stale n_entries an older template printed, still on the line
        "CLIPLY|100.0%|1.00MiB/s|00:00|0|1|2",
        `CLIPLY_FILE|1|${JSON.stringify(one)}`,
        "CLIPLY_STREAM|2|2|bbbbbbbbbbb|18",
        "CLIPLY|100.0%|1.00MiB/s|00:00|0|2|2",
        `CLIPLY_FILE|2|${JSON.stringify(two)}`,
        ""
      ].join("\n"),
      records: recordLines([
        [1, one],
        [2, two]
      ]),
      exitCode: 0
    })

    expect(result.itemsTotal).toBe(3)
    expect(result.itemsSaved).toBe(2)
    expect(result.itemsSkipped).toBe(1)

    // and the bar agrees: two thirds of the job, right up to the terminal
    // event that closes the run out
    const beforeTheEnd = progress[progress.length - 2]
    expect(beforeTheEnd.totalItems).toBe(3)
    expect(beforeTheEnd.overallProgress).toBeLessThan(100)
    expect(beforeTheEnd.overallProgress).toBe(66.7)
    expect(progress[progress.length - 1].overallProgress).toBe(100)
  })

  test("an audio playlist reports the same outcome keys", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - One.mp3")

    const { result } = await playlistRun({
      operation: "playlist-audio",
      params: { outputDir: space.outputDir, audioMode: "mp3", playlistIndices: [1, 2] },
      engineOptions: { userDataPath: space.userDataPath },
      stdout: "CLIPLY|100.0%|1.00MiB/s|00:00|0|1\n",
      records: recordLines([[1, one]]),
      exitCode: 1
    })

    expect(result.itemsSaved).toBe(1)
    expect(result.itemsReused).toBe(0)
    expect(result.itemsTotal).toBe(2)
    expect(result.itemsSkipped).toBe(1)
  })

  test("a malformed marker on stdout is said out loud", async () => {
    const { error } = await playlistRun({
      stdout: "CLIPLY_FILE|1|not json at all\n",
      exitCode: 1,
      records: null
    })

    expect(error.stderrTail.join("\n")).toMatch(/unverified file marker/)
  })

  test("itemsCompleted moves on the file line, not an item later", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - One.mp4")
    const two = saveFile(space.outputDir, "list/002 - Two.mp4")

    const { progress } = await playlistRun({
      params: { outputDir: space.outputDir, playlistIndices: [1, 2] },
      engineOptions: { userDataPath: space.userDataPath },
      stdout: fixture("playlist-run-complete.stdout"),
      records: recordLines([
        [1, one],
        [2, two]
      ]),
      exitCode: 0
    })

    const firstItem = progress.filter((update) => update.itemIndex === 1)
    const lastOfFirst = firstItem[firstItem.length - 1]

    expect(lastOfFirst.itemsCompleted).toBe(1)
    expect(lastOfFirst.itemProgress).toBe(100)
    // (1 + 1) / 2 would read a full bar with half the playlist still to go
    expect(lastOfFirst.overallProgress).toBe(50)
  })
})

describe("single-video behaviour is untouched", () => {
  test("a single video still resolves with no playlist keys at all", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)
    const handle = engine.downloadCombined(SINGLE)

    await settle()

    const child = spawnFn.children[0]
    child.say("CLIPLY_STREAM|134+140\n")
    child.say("CLIPLY| 50.0%|1.00MiB/s|00:10|10\n")
    child.say("CLIPLY_FILE|/downloads/one.mp4\n")
    await settle()
    child.exit(0)

    const result = await handle.promise

    expect(result.filePath).toBe("/downloads/one.mp4")
    expect(result.files).toBeUndefined()
    expect(result.itemsSaved).toBeUndefined()
    expect(result.itemsTotal).toBeUndefined()
  })

  test("a single video that exits non-zero still fails, files or not", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)
    const handle = engine.downloadCombined(SINGLE)

    await settle()

    const child = spawnFn.children[0]
    child.say("CLIPLY_FILE|/downloads/one.mp4\n")
    child.complain("ERROR: Video unavailable\n")
    await settle()
    child.exit(1)

    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.VIDEO_UNAVAILABLE
    })
  })

  test("a single-video progress event carries the keys it always has", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)
    const handle = engine.downloadCombined(SINGLE)

    await settle()

    const updates = []
    handle.on("progress", (update) => updates.push(update))

    const child = spawnFn.children[0]
    child.say("CLIPLY_STREAM|134+140\n")
    child.say("CLIPLY| 50.0%|1.00MiB/s|00:10|10\n")
    await settle()

    expect(updates).toEqual([
      {
        progress: 25,
        streamProgress: 50,
        streamIndex: 0,
        speed: "1.00MiB/s",
        eta: "00:10",
        etaSeconds: 10
      }
    ])

    child.exit(0)
    await handle.promise
  })
})

// =============================================================================
// watchdog
// =============================================================================

describe("the postprocess deadline is per item, not per run", () => {
  test("item 2 downloads under the short deadline again", async () => {
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - One.mp4")
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, {
      watchdogMs: 20,
      killGraceMs: 10,
      userDataPath: space.userDataPath
    })
    const handle = engine.run("playlist-combined", {
      ...PLAYLIST,
      outputDir: space.outputDir,
      playlistIndices: [1, 2]
    })

    await settle()
    fs.writeFileSync(handle.recordsFile, recordLines([[1, one]]))
    const child = spawnFn.children[0]

    // item 1 finishes its single stream, so postprocessing takes over
    child.say("CLIPLY_STREAM|1|1|aaaaaaaaaaa|18\n")
    child.say("CLIPLY|100.0%|1.00MiB/s|00:00|0|1\n")
    await settle()
    expect(handle.phase).toBe("processing")

    // the merge is allowed to be silent for far longer than the download is
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(child.killed).toBe(false)

    child.say(`CLIPLY_FILE|1|${JSON.stringify(one)}\n`)
    child.say("CLIPLY_STREAM|2|2|bbbbbbbbbbb|18\n")
    child.say("CLIPLY| 40.0%|1.00MiB/s|00:10|10|2\n")
    await settle()

    // the phase has to come back out of `processing`, or item 2 would download
    // under the half-hour merge deadline and a wedged item would never be killed
    expect(handle.phase).toBe("downloading")

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(child.signals).toContain("SIGTERM")

    child.exit(null)

    // a stall is a stall even with a file already saved: the run stopped
    // responding rather than finishing
    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.STALLED,
      files: [one]
    })
  })

  test("silence after a new item's marker is a stall, not a merge", async () => {
    // the gap the phase flag alone does not close. the chunk carrying the
    // marker calls touch() *before* the line is parsed, so it re-arms under
    // the phase the previous item left behind - and setPhase does not re-arm
    // on the way into `downloading`. without an explicit touch after the
    // switch, an item that hangs before its first byte waits half an hour
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - One.mp4")
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, {
      watchdogMs: 20,
      killGraceMs: 10,
      userDataPath: space.userDataPath
    })
    const handle = engine.run("playlist-combined", {
      ...PLAYLIST,
      outputDir: space.outputDir,
      playlistIndices: [1, 2]
    })

    await settle()
    fs.writeFileSync(handle.recordsFile, recordLines([[1, one]]))
    const child = spawnFn.children[0]

    child.say("CLIPLY_STREAM|1|1|aaaaaaaaaaa|18\n")
    child.say("CLIPLY|100.0%|1.00MiB/s|00:00|0|1\n")
    child.say(`CLIPLY_FILE|1|${JSON.stringify(one)}\n`)
    await settle()

    // item 2 announces itself and then hangs, printing nothing at all
    child.say("CLIPLY_STREAM|2|2|bbbbbbbbbbb|18\n")
    await settle()

    expect(handle.phase).toBe("downloading")

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(child.signals).toContain("SIGTERM")

    child.exit(null)
    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.STALLED,
      files: [one]
    })
  })

  test("silence after a file lands is not a stall", async () => {
    // the other side of the same boundary: the item is done and yt-dlp is
    // deciding what to do next, which is the phase that is allowed to be quiet
    const space = workspace()
    const one = saveFile(space.outputDir, "list/001 - One.mp4")
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, {
      watchdogMs: 20,
      killGraceMs: 10,
      userDataPath: space.userDataPath
    })
    const handle = engine.run("playlist-combined", {
      ...PLAYLIST,
      outputDir: space.outputDir,
      playlistIndices: [1, 2]
    })

    await settle()
    fs.writeFileSync(handle.recordsFile, recordLines([[1, one]]))
    const child = spawnFn.children[0]

    child.say("CLIPLY_STREAM|1|1|aaaaaaaaaaa|18\n")
    child.say("CLIPLY|100.0%|1.00MiB/s|00:00|0|1\n")
    child.say(`CLIPLY_FILE|1|${JSON.stringify(one)}\n`)
    await settle()

    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(child.killed).toBe(false)
    expect(handle.stalled).toBe(false)

    child.exit(0)
    await expect(handle.promise).resolves.toMatchObject({ itemsSaved: 1 })
  })

  test("item 2's postprocess pause is allowed too", async () => {
    const space = workspace()
    const files = [
      saveFile(space.outputDir, "list/001 - One.mp4"),
      saveFile(space.outputDir, "list/002 - Two.mp4")
    ]
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, {
      watchdogMs: 20,
      killGraceMs: 10,
      userDataPath: space.userDataPath
    })
    const handle = engine.run("playlist-combined", {
      ...PLAYLIST,
      outputDir: space.outputDir,
      playlistIndices: [1, 2]
    })

    await settle()
    fs.writeFileSync(
      handle.recordsFile,
      recordLines(files.map((file, index) => [index + 1, file]))
    )
    const child = spawnFn.children[0]

    for (const item of [1, 2]) {
      child.say(`CLIPLY_STREAM|${item}|${item}|aaaaaaaaaa${item}|18\n`)
      child.say(`CLIPLY| 40.0%|1.00MiB/s|00:10|10|${item}\n`)
      await settle()
      expect(handle.phase).toBe("downloading")

      child.say(`CLIPLY|100.0%|1.00MiB/s|00:00|0|${item}\n`)
      await settle()
      expect(handle.phase).toBe("processing")

      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(child.killed).toBe(false)

      child.say(`CLIPLY_FILE|${item}|${JSON.stringify(files[item - 1])}\n`)
      await settle()
    }

    child.exit(0)
    await expect(handle.promise).resolves.toMatchObject({ itemsSaved: 2 })
  })
})
