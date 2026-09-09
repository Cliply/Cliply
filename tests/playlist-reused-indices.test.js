// which rows the archive accounted for, from the engine to the ipc payload
//
// the count alone was never enough for the ui. yt-dlp does not announce an
// archive-skipped item at all - no stream marker, no progress line, no file
// record - so a row for a video the user already has looks exactly like a row
// the run never reached, and settles as "skipped" when the run ends. the
// positions are the only handle there is, and the engine already knows them:
// it works reuse out before the spawn by intersecting the selection's ids with
// the archive file. this pins that it says which, not just how many, and that
// the runner carries it across without widening a single-video payload.

const { EventEmitter } = require("events")
const { PassThrough } = require("stream")
const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  YtdlpEngine,
  archivedSelectionIndices,
  countArchivedSelections,
  readArchivedIds
} = require("../src/main/services/ytdlp-engine")

const { DownloadRunner } = require("../src/main/services/download-runner")

const { buildPlaylistOutputTemplate } = require("../src/main/utils/ytdlp-mappers")

const settle = () => new Promise((resolve) => setImmediate(resolve))

// =============================================================================
// the pure part
// =============================================================================

describe("archivedSelectionIndices", () => {
  const entries = [
    { index: 1, id: "aaaaaaaaaaa" },
    { index: 5, id: "bbbbbbbbbbb" },
    { index: 9, id: "ccccccccccc" }
  ]

  test("names the selected positions the archive already holds", () => {
    const archived = new Set(["aaaaaaaaaaa", "ccccccccccc"])

    // the playlist's own positions, not the queue's: rows are numbered by
    // where the video sits in the playlist, and a sparse selection makes the
    // two disagree
    expect(archivedSelectionIndices(entries, archived)).toEqual([1, 9])
  })

  test("counts a repeated video once per position it occupies", () => {
    // a playlist can hold the same video twice, and the denominator counts
    // positions, so both of its rows are already downloaded
    const twice = [
      { index: 2, id: "aaaaaaaaaaa" },
      { index: 7, id: "aaaaaaaaaaa" }
    ]

    expect(archivedSelectionIndices(twice, new Set(["aaaaaaaaaaa"]))).toEqual([2, 7])
  })

  test("has nothing to say without entries or without an archive", () => {
    expect(archivedSelectionIndices(entries, new Set())).toEqual([])
    expect(archivedSelectionIndices(null, new Set(["aaaaaaaaaaa"]))).toEqual([])
    expect(archivedSelectionIndices([], new Set(["aaaaaaaaaaa"]))).toEqual([])
  })

  test("is the same fact the count has always reported", () => {
    const archived = new Set(["aaaaaaaaaaa", "ccccccccccc"])

    expect(countArchivedSelections(entries, archived)).toBe(
      archivedSelectionIndices(entries, archived).length
    )
  })

  test("reads a real archive file the same way the count did", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-reused-"))
    const archive = path.join(root, "arc.txt")

    // a foreign extractor's line is not a record of a youtube video, however
    // the eleven characters happen to line up
    fs.writeFileSync(archive, "youtube aaaaaaaaaaa\nvimeo ccccccccccc\n")

    expect(archivedSelectionIndices(entries, readArchivedIds(archive))).toEqual([1])

    fs.rmSync(root, { recursive: true, force: true })
  })
})

// =============================================================================
// the engine result
// =============================================================================

class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = false
  }

  kill() {
    this.killed = true
    return true
  }

  exit(code) {
    this.emit("close", code)
  }
}

function createSpawner() {
  const spawnFn = () => {
    const child = new FakeChild(9000 + spawnFn.children.length)
    spawnFn.children.push(child)
    return child
  }

  spawnFn.children = []
  return spawnFn
}

const workspaces = []

function workspace() {
  // realpath because macos hands out /var/folders/... for a /private/var path,
  // and the engine resolves both sides before comparing them
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cliply-reused-")))
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

const ENTRIES = [
  { index: 1, id: "aaaaaaaaaaa" },
  { index: 4, id: "bbbbbbbbbbb" },
  { index: 6, id: "ccccccccccc" }
]

/**
 * one playlist run against a fake yt-dlp, in a real workspace
 *
 * `saved` names files to put in the output directory and record against, in
 * the same order the run's items would have: the engine counts a save only
 * from its own record file, checked against a file that is really there
 */
async function playlistRun({
  archived = [],
  ignoreArchive,
  saved = [],
  exitCode = 0
} = {}) {
  const space = workspace()
  const archive = path.join(space.root, "arc.txt")
  fs.writeFileSync(archive, archived.map((id) => `youtube ${id}\n`).join(""))

  const spawnFn = createSpawner()
  const engine = new YtdlpEngine({
    userDataPath: space.userDataPath,
    resourcesPath: space.root,
    ffmpegPath: "/fake/ffmpeg",
    denoPath: "/fake/deno",
    spawnFn,
    killFn: () => {
      throw new Error("ESRCH")
    }
  })

  const handle = engine.run("playlist-combined", {
    ffmpegPath: "/fake/ffmpeg",
    denoPath: "/fake/deno",
    url: "https://www.youtube.com/playlist?list=PLLojVvWCZ5N4",
    outputDir: space.outputDir,
    outputTemplate: buildPlaylistOutputTemplate({}),
    archiveFile: archive,
    playlistEntries: ENTRIES,
    ...(ignoreArchive === undefined ? {} : { ignoreArchive })
  })

  await settle()

  if (saved.length > 0) {
    const records = saved.map((name, position) => {
      const filePath = path.join(space.outputDir, name)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "media")

      return `${position + 1}|${JSON.stringify(filePath)}`
    })

    fs.writeFileSync(handle.recordsFile, `${records.join("\n")}\n`)
  }

  await settle()
  spawnFn.children[0].exit(exitCode)

  let result = null
  let error = null
  try {
    result = await handle.promise
  } catch (caught) {
    error = caught
  }

  return { result, error, space }
}

describe("what a playlist result says about reuse", () => {
  test("the positions the archive covered travel with the count", async () => {
    const { result } = await playlistRun({ archived: ["aaaaaaaaaaa", "ccccccccccc"] })

    expect(result.itemsReused).toBe(2)
    // positions 1 and 6, which is what the listing on screen numbers its rows
    // by. position 4 is the one this run had to actually download
    expect(result.reusedIndices).toEqual([1, 6])
    expect(result.itemsTotal).toBe(3)
  })

  test("the array and the count can never disagree", async () => {
    const { result } = await playlistRun({ archived: ["bbbbbbbbbbb"] })

    expect(result.reusedIndices).toEqual([4])
    expect(result.reusedIndices).toHaveLength(result.itemsReused)
  })

  test("download everything again reuses nothing, and names nothing", async () => {
    const { result } = await playlistRun({
      archived: ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"],
      ignoreArchive: true,
      saved: ["001 - One [aaaaaaaaaaa] 1080p.mp4"]
    })

    expect(result.itemsReused).toBe(0)
    expect(result.reusedIndices).toEqual([])
  })

  test("a run that failed still reports what the archive had", async () => {
    // the tally is attached to the rejection exactly as it is to a result, so
    // the rows a user already has are not redrawn as lost when a run breaks
    const { error } = await playlistRun({
      archived: ["aaaaaaaaaaa"],
      exitCode: null
    })

    expect(error.reusedIndices).toEqual([1])
  })

  test("nothing in the archive is an empty list, not an absent key", async () => {
    const { result, error } = await playlistRun({ archived: [], exitCode: 1 })

    // nothing saved and nothing reused: this run rejects, and says so with an
    // empty list rather than with undefined
    expect(result).toBeNull()
    expect(error.reusedIndices).toEqual([])
  })
})

// =============================================================================
// the ipc payload
// =============================================================================

function createRunner() {
  const events = []

  const runner = new DownloadRunner({
    engine: {},
    sendEvent: (downloadId, payload) => events.push({ downloadId, ...payload }),
    trackEvent: () => {}
  })

  return { runner, events }
}

class FakeHandle extends EventEmitter {
  constructor() {
    super()
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // nothing here rejects unobserved
    this.promise.catch(() => {})
    this.events = this
  }

  cancel() {
    return true
  }
}

const PLAYLIST_RUN = {
  downloadId: "playlist_1",
  type: "video",
  platform: "youtube",
  playlist: true,
  url: "https://www.youtube.com/playlist?list=PL123"
}

describe("what the renderer is told about reuse", () => {
  test("the terminal event carries the positions", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST_RUN, createHandle: () => handle })
    await settle()

    handle.resolve({
      filePath: "/downloads/PL/004 - Two [bbbbbbbbbbb] 1080p.mp4",
      files: ["/downloads/PL/004 - Two [bbbbbbbbbbb] 1080p.mp4"],
      itemsSaved: 1,
      itemsReused: 2,
      reusedIndices: [1, 6],
      itemsSkipped: 0,
      itemsTotal: 3
    })

    const result = await running
    const terminal = events[events.length - 1]

    expect(terminal.items_reused).toBe(2)
    expect(terminal.reused_indices).toEqual([1, 6])
    expect(result.reused_indices).toEqual([1, 6])
  })

  test("a single video's payload gains nothing at all", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({
      downloadId: "combined_1",
      type: "video",
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      createHandle: () => handle
    })
    await settle()

    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    const terminal = events[events.length - 1]
    expect("reused_indices" in terminal).toBe(false)
    expect("items_reused" in terminal).toBe(false)
  })

  test("a result from before the key existed produces the payload it always did", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST_RUN, createHandle: () => handle })
    await settle()

    handle.resolve({
      filePath: null,
      files: [],
      itemsSaved: 0,
      itemsReused: 2,
      itemsSkipped: 0,
      itemsTotal: 2
    })

    await running
    const terminal = events[events.length - 1]

    expect(terminal.items_reused).toBe(2)
    expect("reused_indices" in terminal).toBe(false)
  })

  test("a cancelled playlist keeps the rows the archive had accounted for", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST_RUN, createHandle: () => handle })
    await settle()

    const error = new Error("Download cancelled")
    error.code = "CANCELLED"
    error.files = []
    error.itemsSaved = 0
    error.itemsReused = 1
    error.reusedIndices = [1]
    error.itemsSkipped = 2
    error.itemsTotal = 3
    handle.reject(error)

    await running.catch(() => {})
    const terminal = events[events.length - 1]

    expect(terminal.reused_indices).toEqual([1])
  })
})
