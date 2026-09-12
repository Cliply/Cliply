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

  test("keeps the newest hundred finished downloads and drops the rest", async () => {
    for (let index = 0; index < HISTORY_LIMIT + 20; index++) {
      await history.upsert(
        row({
          download_id: `d_${index}`,
          started_at: 1000 + index,
          status: "completed"
        })
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
    const done = { status: "completed" }
    await small.upsert(row({ download_id: "old", started_at: 1000, ...done }))
    await small.upsert(row({ download_id: "mid", started_at: 2000, ...done }))
    await small.upsert(row({ download_id: "new", started_at: 3000, ...done }))
    await small.upsert({ download_id: "old", status: "completed" })

    expect(small.list().map((entry) => entry.download_id)).toEqual([
      "new",
      "mid"
    ])
  })

  test("the cap never drops a download that is still going", async () => {
    // a live row evicted from the history is one the quit path can no longer
    // find to mark, so it settles as `cancelled` and comes back as a download
    // the user never stopped. the finished rows are what the cap is for
    const small = new DownloadHistory({ filePath, limit: 3 })

    await small.upsert(row({ download_id: "waiting", status: "queued", started_at: 1 }))

    for (let index = 0; index < 3; index++) {
      await small.upsert(
        row({
          download_id: `done_${index}`,
          status: "completed",
          started_at: 1000 + index
        })
      )
    }

    // and one more finished download, which is what pushes the cap over
    await small.upsert(
      row({ download_id: "done_last", status: "completed", started_at: 2000 })
    )

    const ids = small.list().map((entry) => entry.download_id)
    // the oldest row in the file, and still the one that survives
    expect(ids).toContain("waiting")
    expect(ids).not.toContain("done_0")
    // three finished rows plus the live one: the cap counts the finished
    expect(ids).toHaveLength(4)
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

describe("readiness", () => {
  /**
   * a read that has not landed yet
   *
   * the renderer hydrates once and nothing pushes a correction afterwards, so
   * this window is the difference between a panel with a hundred rows and a
   * panel that says this install has never downloaded anything
   */
  function deferReadFile(target) {
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })

    target.readFile = () => held

    return (rows) => release(rows)
  }

  test("load's promise is on the instance, not only in the caller's hands", async () => {
    const release = deferReadFile(history)
    history.load()

    let loaded = false
    history.ready.then(() => {
      loaded = true
    })

    await Promise.resolve()
    expect(loaded).toBe(false)

    release([row({ status: "completed" })])
    await history.ready

    expect(history.list()).toHaveLength(1)
  })

  test("is already settled before anything has been loaded", async () => {
    // a history nobody called load() on has nothing to wait for, and a caller
    // awaiting readiness must not hang for a read that will never happen
    await expect(history.ready).resolves.toBeUndefined()
  })

  test("clear waits for the file rather than clearing an empty list", async () => {
    write(JSON.stringify([row({ status: "completed" })]))
    const release = deferReadFile(history)
    history.load()

    const clearing = history.clear()
    release(JSON.parse(fs.readFileSync(filePath, "utf8")))
    await clearing

    // the file is what says which of the two happened: a clear that ran on an
    // empty list would have found nothing to drop and written nothing, leaving
    // the row on disk for the next launch to read back
    expect(history.list()).toEqual([])
    expect(stored()).toEqual([])
  })

  test("interruptLive waits for the file rather than marking an empty list", async () => {
    write(JSON.stringify([row({ status: "downloading" })]))
    const release = deferReadFile(history)
    history.load()

    const marking = history.interruptLive()
    release(JSON.parse(fs.readFileSync(filePath, "utf8")))
    await marking

    expect(stored()[0].status).toBe("interrupted")
  })

  test("remove waits for the file rather than finding nothing to remove", async () => {
    write(JSON.stringify([row({ status: "completed" })]))
    const release = deferReadFile(history)
    history.load()

    const removing = history.remove("combined_1")
    release(JSON.parse(fs.readFileSync(filePath, "utf8")))
    await removing

    expect(history.list()).toEqual([])
  })
})

describe("a live row is not removable", () => {
  test.each(["queued", "downloading"])(
    "leaves a %s row exactly where it is",
    async (status) => {
      // forgetting one does not stop the download: the reservation lives on,
      // the row comes back at its next status write, and the quit path can no
      // longer mark a row it cannot see - so the user would find a download
      // they never cancelled, wearing a row they asked to be rid of
      await history.upsert(row({ status }))

      await history.remove("combined_1")

      expect(history.list()).toHaveLength(1)
      expect(history.list()[0].status).toBe(status)
    }
  )

  test.each(["completed", "failed", "cancelled", "interrupted"])(
    "still forgets a %s row",
    async (status) => {
      await history.upsert(row({ status }))

      await history.remove("combined_1")

      expect(history.list()).toEqual([])
    }
  )

  test("a cancelled row left by download:cancel is removable", async () => {
    // the panel's Remove on a queued row goes through download:cancel, and the
    // row that settles out of it is an ordinary terminal row
    await history.upsert(row({ status: "queued" }))
    await history.upsert({ download_id: "combined_1", status: "cancelled" })

    await history.remove("combined_1")

    expect(history.list()).toEqual([])
  })
})

describe("a playlist row", () => {
  // one row covering n videos: the counts are what it is drawn from, because a
  // playlist's file_path names whichever video landed last rather than the run
  function playlistRow(overrides = {}) {
    return row({
      download_id: "playlist_1",
      kind: "playlist",
      label: "12 videos",
      request: { url: "https://youtube.com/playlist?list=PL", entries: [] },
      items_total: 12,
      ...overrides
    })
  }

  test("reads back with its counts after a restart", async () => {
    await history.upsert(playlistRow())
    await history.upsert({
      download_id: "playlist_1",
      status: "completed",
      finished_at: 2000,
      items_saved: 9,
      items_reused: 1,
      items_skipped: 2,
      items_total: 12
    })

    const next = await relaunch()

    expect(next.list()[0]).toMatchObject({
      kind: "playlist",
      status: "completed",
      items_saved: 9,
      items_reused: 1,
      items_skipped: 2,
      items_total: 12
    })
  })

  test("keeps the total it was reserved with when a settle counts nothing", async () => {
    // a playlist refused before the engine could count still knows how many
    // videos the user picked, and that number is the row's whole denominator
    await history.upsert(playlistRow())
    await history.upsert({
      download_id: "playlist_1",
      status: "failed",
      error: "could not write the records file"
    })

    expect(history.list()[0].items_total).toBe(12)
  })

  test("an interrupted playlist still says how many it was for", async () => {
    await history.upsert(playlistRow({ status: "downloading", items_saved: 3 }))

    await history.interruptLive()

    expect(stored()[0]).toMatchObject({
      status: "interrupted",
      items_saved: 3,
      items_total: 12
    })
  })
})

describe("list", () => {
  test("hands out copies, so a caller cannot edit the history in place", async () => {
    await history.upsert(row())

    history.list()[0].status = "completed"

    expect(history.list()[0].status).toBe("queued")
  })
})
