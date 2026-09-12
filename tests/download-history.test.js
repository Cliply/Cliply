/**
 * the downloads a restart is supposed to survive
 *
 * these drive the real service against a real file in a temp directory,
 * because every interesting thing here is about the file: what a corrupt one
 * does, what two writes in the same tick leave behind, and what the user sees
 * when the app went away with downloads still running.
 */

const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  DownloadHistory,
  HISTORY_LIMIT
} = require("../src/main/services/download-history")

let root
let filePath
let history

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-history-"))
  filePath = path.join(root, "downloads", "history.json")
  history = new DownloadHistory({ filePath })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// a row as the runner writes one, so each test only says what it is changing
function row(overrides = {}) {
  return {
    download_id: "combined_1",
    kind: "video",
    platform: "youtube",
    title: "A Video",
    label: "1080p mp4",
    status: "queued",
    started_at: 1000,
    request: { url: "https://youtu.be/x", height: 1080 },
    ...overrides
  }
}

// what is actually on disk, which is the only thing the next launch will see
function stored() {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

/**
 * what a write would change, whether or not the clock moved
 *
 * the rename gives the target a new inode, so this catches a write that landed
 * inside one tick of the filesystem's timestamp resolution - which is what a
 * "wrote nothing" assertion on mtime alone would miss
 */
function fileStamp() {
  const stats = fs.statSync(filePath)
  return `${stats.mtimeMs}:${stats.ino}`
}

// scratch files from an atomic write, which must never outlive it
function tempFilesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))
}

// a second run of the app over the same file
async function relaunch() {
  const next = new DownloadHistory({ filePath })
  await next.load()
  return next
}

function write(contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

describe("load", () => {
  test("a first launch starts empty rather than refusing to start", async () => {
    await history.load()

    expect(history.list()).toEqual([])
  })

  test("a corrupt file starts empty, and the next write repairs it", async () => {
    write("{ not json at all")

    await history.load()
    expect(history.list()).toEqual([])

    await history.upsert(row())

    expect(stored()).toHaveLength(1)
    expect(stored()[0].download_id).toBe("combined_1")
  })

  test("a file holding something that is not a list of rows starts empty", async () => {
    write(JSON.stringify({ rows: [row()] }))

    await history.load()

    expect(history.list()).toEqual([])
  })

  test("drops a row nothing could be keyed by", async () => {
    // a hand-edited or truncated file: a row with no id cannot be updated,
    // removed or retried, so keeping it only puts an undrawable row in the panel
    write(JSON.stringify([row(), { status: "completed" }]))

    await history.load()

    expect(history.list()).toHaveLength(1)
  })

  test.each(["queued", "starting", "downloading"])(
    "calls a %s row interrupted - the app never got to say goodbye",
    async (status) => {
      write(JSON.stringify([row({ status })]))

      await history.load()

      expect(history.list()[0].status).toBe("interrupted")
      // and on disk, so a launch that crashes again does not have to rediscover it
      expect(stored()[0].status).toBe("interrupted")
    }
  )

  test.each(["completed", "failed", "cancelled"])(
    "leaves a %s row exactly as it was",
    async (status) => {
      write(JSON.stringify([row({ status, finished_at: 2000 })]))

      await history.load()

      expect(history.list()[0].status).toBe(status)
      expect(history.list()[0].finished_at).toBe(2000)
    }
  )

  test("does not stamp an interrupted row with the launch that noticed", async () => {
    // finished_at is when the download stopped, and this launch is not that.
    // stamping it here would sort the list by when the app was next opened
    write(JSON.stringify([row({ status: "downloading" })]))

    await history.load()

    expect(history.list()[0].finished_at).toBeUndefined()
  })

  test("writes nothing when there was nothing to repair", async () => {
    write(JSON.stringify([row({ status: "completed" })]))
    const before = fileStamp()

    await history.load()

    expect(fileStamp()).toBe(before)
  })
})

describe("upsert", () => {
  test("inserts a row the first time it hears about a download", async () => {
    await history.upsert(row())

    expect(history.list()).toHaveLength(1)
    expect(stored()[0].request).toEqual({
      url: "https://youtu.be/x",
      height: 1080
    })
  })

  test("a settle keeps everything the reservation wrote", async () => {
    await history.upsert(row())
    await history.upsert({
      download_id: "combined_1",
      status: "completed",
      finished_at: 2000,
      file_path: "/downloads/a.mp4"
    })

    const [saved] = stored()
    expect(saved.status).toBe("completed")
    expect(saved.title).toBe("A Video")
    expect(saved.label).toBe("1080p mp4")
    expect(saved.request.url).toBe("https://youtu.be/x")
  })

  test("one download is one row, however many times it is written", async () => {
    await history.upsert(row())
    await history.upsert(row({ status: "downloading" }))
    await history.upsert(row({ status: "completed" }))

    expect(stored()).toHaveLength(1)
  })

  test("a row already interrupted is not moved by a late cancel", async () => {
    // the quit path marks the row, then cancelAll settles the download as
    // cancelled a moment later. the user did not cancel anything
    await history.upsert(row({ status: "downloading" }))
    await history.interruptLive()

    await history.upsert({ download_id: "combined_1", status: "cancelled" })

    expect(history.list()[0].status).toBe("interrupted")
    expect(stored()[0].status).toBe("interrupted")
  })

  test("ignores a row with no id rather than storing one", async () => {
    await expect(history.upsert({ status: "completed" })).resolves.toBeUndefined()

    expect(history.list()).toEqual([])
  })

  test("lists the newest first", async () => {
    await history.upsert(row({ download_id: "a", started_at: 1000 }))
    await history.upsert(row({ download_id: "c", started_at: 3000 }))
    await history.upsert(row({ download_id: "b", started_at: 2000 }))

    expect(history.list().map((entry) => entry.download_id)).toEqual([
      "c",
      "b",
      "a"
    ])
  })

  test("keeps the newest hundred and drops the rest", async () => {
    for (let index = 0; index < HISTORY_LIMIT + 20; index++) {
      await history.upsert(
        row({ download_id: `d_${index}`, started_at: 1000 + index })
      )
    }

    const saved = stored()
    expect(saved).toHaveLength(HISTORY_LIMIT)
    expect(saved[0].download_id).toBe(`d_${HISTORY_LIMIT + 19}`)
    // the twenty oldest went, not the twenty that happened to be written last
    expect(saved.at(-1).download_id).toBe("d_20")
  })

  test("drops by when the download was started, not when it finished", async () => {
    const small = new DownloadHistory({ filePath, limit: 2 })

    // the oldest download settles last, which is exactly the case a write-order
    // cap gets wrong: it would keep this one and drop a newer download
    await small.upsert(row({ download_id: "old", started_at: 1000 }))
    await small.upsert(row({ download_id: "mid", started_at: 2000 }))
    await small.upsert(row({ download_id: "new", started_at: 3000 }))
    await small.upsert({ download_id: "old", status: "completed" })

    expect(small.list().map((entry) => entry.download_id)).toEqual([
      "new",
      "mid"
    ])
  })

  test("two writes in the same tick both land", async () => {
    // nothing awaits between a reserve and the settle of another download, so
    // this is the ordinary case. unserialised, both would read the same rows
    // and the second rename would drop the first one's work
    const writes = [
      history.upsert(row({ download_id: "a", started_at: 1000 })),
      history.upsert(row({ download_id: "b", started_at: 2000 })),
      history.upsert(row({ download_id: "c", started_at: 3000 }))
    ]

    await Promise.all(writes)

    expect(stored()).toHaveLength(3)
  })

  test("leaves no scratch files behind", async () => {
    await history.upsert(row({ download_id: "a" }))
    await history.upsert(row({ download_id: "b" }))

    expect(tempFilesIn(path.dirname(filePath))).toEqual([])
  })

  test("survives a restart", async () => {
    await history.upsert(row({ status: "completed", finished_at: 2000 }))

    const next = await relaunch()

    expect(next.list()).toHaveLength(1)
    expect(next.list()[0].status).toBe("completed")
  })
})

describe("a history that cannot be written", () => {
  // chmod does not restrict the superuser, and is a no-op on windows
  const canRevokeWrite =
    typeof process.getuid === "function" && process.getuid() !== 0

  test("keeps its rows when there is no file at all", async () => {
    // what a build that cannot resolve userData gets: a panel that works for
    // the session rather than no panel
    const memoryOnly = new DownloadHistory()

    await memoryOnly.load()
    await memoryOnly.upsert(row())

    expect(memoryOnly.list()).toHaveLength(1)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  ;(canRevokeWrite ? test : test.skip)(
    "does not fail the download it was recording",
    async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.chmodSync(path.dirname(filePath), 0o555)

      try {
        // the whole promise: a rejection here reaches the runner's settle path,
        // where a finished download would be reported as a broken one
        await expect(history.upsert(row())).resolves.toBeUndefined()

        // and the row is still right in memory, so this session's panel is whole
        expect(history.list()).toHaveLength(1)
        expect(warn).toHaveBeenCalled()
      } finally {
        fs.chmodSync(path.dirname(filePath), 0o755)
        warn.mockRestore()
      }
    }
  )

  ;(canRevokeWrite ? test : test.skip)(
    "keeps writing once the file can be written again",
    async () => {
      // a rejected chain would refuse every write for the rest of the session
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.chmodSync(path.dirname(filePath), 0o555)

      try {
        await history.upsert(row({ download_id: "a" }))
      } finally {
        fs.chmodSync(path.dirname(filePath), 0o755)
      }

      await history.upsert(row({ download_id: "b", started_at: 2000 }))

      expect(stored()).toHaveLength(2)
      warn.mockRestore()
    }
  )

  ;(canRevokeWrite ? test : test.skip)(
    "leaves the previous history whole when a write fails",
    async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      await history.upsert(row({ download_id: "a", status: "completed" }))

      // revoking the right to create entries stops the scratch file, so the
      // write fails before it can replace the target. writing in place needs no
      // such permission, and would have truncated the history here quite happily
      fs.chmodSync(path.dirname(filePath), 0o555)

      try {
        await history.upsert(row({ download_id: "b", started_at: 2000 }))
      } finally {
        fs.chmodSync(path.dirname(filePath), 0o755)
      }

      expect(stored()).toHaveLength(1)
      expect(stored()[0].download_id).toBe("a")
      expect(tempFilesIn(path.dirname(filePath))).toEqual([])
      warn.mockRestore()
    }
  )
})

describe("interruptLive", () => {
  test("marks everything that had not settled", async () => {
    await history.upsert(row({ download_id: "a", status: "queued" }))
    await history.upsert(row({ download_id: "b", status: "downloading" }))
    await history.upsert(
      row({ download_id: "c", status: "completed", started_at: 900 })
    )

    await history.interruptLive()

    const byId = Object.fromEntries(
      history.list().map((entry) => [entry.download_id, entry.status])
    )
    expect(byId).toEqual({
      a: "interrupted",
      b: "interrupted",
      c: "completed"
    })
  })

  test("the file is written before the promise settles", async () => {
    // the quit path awaits this and then lets the process go, so a write that
    // is only started here is a write that never happens
    await history.upsert(row({ status: "downloading" }))

    await history.interruptLive()

    expect(stored()[0].status).toBe("interrupted")
  })

  test("a quit with nothing running writes nothing", async () => {
    await history.upsert(row({ status: "completed" }))
    const before = fileStamp()

    await history.interruptLive()

    expect(fileStamp()).toBe(before)
  })
})

describe("clear", () => {
  test("drops the finished rows and keeps the ones still running", async () => {
    await history.upsert(row({ download_id: "done", status: "completed" }))
    await history.upsert(row({ download_id: "broke", status: "failed" }))
    await history.upsert(row({ download_id: "stopped", status: "cancelled" }))
    await history.upsert(row({ download_id: "lost", status: "interrupted" }))
    await history.upsert(row({ download_id: "waiting", status: "queued" }))
    await history.upsert(row({ download_id: "running", status: "downloading" }))

    await history.clear()

    expect(history.list().map((entry) => entry.download_id).sort()).toEqual([
      "running",
      "waiting"
    ])
    // a row with a process behind it still has events to come: clearing it
    // would leave the panel holding one nothing can ever complete
    expect(stored()).toHaveLength(2)
  })

  test("writes nothing when there was nothing finished to drop", async () => {
    await history.upsert(row({ status: "downloading" }))
    const before = fileStamp()

    await history.clear()

    expect(fileStamp()).toBe(before)
  })
})

describe("remove", () => {
  test("forgets one row and leaves the others", async () => {
    await history.upsert(row({ download_id: "a", status: "completed" }))
    await history.upsert(
      row({ download_id: "b", status: "completed", started_at: 2000 })
    )

    await history.remove("a")

    expect(history.list().map((entry) => entry.download_id)).toEqual(["b"])
    expect(stored()).toHaveLength(1)
  })

  test("an id nobody has heard of writes nothing", async () => {
    await history.upsert(row())
    const before = fileStamp()

    await history.remove("not-a-download")

    expect(fileStamp()).toBe(before)
  })
})

describe("list", () => {
  test("hands out copies, so a caller cannot edit the history in place", async () => {
    await history.upsert(row())

    history.list()[0].status = "completed"

    expect(history.list()[0].status).toBe("queued")
  })
})
