// unit tests for the download runner: progress forwarding, terminal events,
// cancellation and the repair-on-failure retry

const { EventEmitter } = require("events")

const fs = require("fs")

const { DownloadRunner } = require("../src/main/services/download-runner")
const { DownloadHistory } = require("../src/main/services/download-history")
const { ERROR_CODES } = require("../src/main/services/ytdlp-engine")
const { ERROR_CATEGORIES } = require("../src/main/utils/error-taxonomy")

// a stand-in for an engine handle
class FakeHandle extends EventEmitter {
  constructor() {
    super()
    this.cancelled = false
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // nothing here rejects unobserved
    this.promise.catch(() => {})
  }

  cancel() {
    this.cancelled = true
    return true
  }
}

// maxConcurrent defaults to APP_CONFIG.MAX_CONCURRENT_DOWNLOADS, and every
// test outside describe("queue") runs fewer downloads than that, so the cap is
// invisible to them. the queue tests set it to 1 or 2 rather than starting four
// downloads to reach the real one
function createRunner({ updater = null, maxConcurrent, history = null } = {}) {
  const events = []
  const tracked = []

  const runner = new DownloadRunner({
    engine: {},
    updater,
    sendEvent: (downloadId, payload) => events.push({ downloadId, ...payload }),
    trackEvent: (name, payload) => tracked.push({ name, ...payload }),
    ...(history ? { history } : null),
    ...(maxConcurrent === undefined ? null : { maxConcurrent })
  })

  return { runner, events, tracked }
}

const BASE = {
  downloadId: "combined_1",
  type: "combined",
  platform: "youtube",
  title: "A Video",
  formatId: "720p"
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/**
 * the notice every accepted run sends the moment it has a handle
 *
 * it is the first thing the renderer hears about a run, before the engine has
 * said anything, so every assertion that pins an exact payload reads past it.
 */
const admitted = (downloadId = "combined_1") => ({
  downloadId,
  status: "downloading",
  progress: 0,
  indeterminate: true
})

describe("progress forwarding", () => {
  test("engine progress becomes a download:progress event", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    handle.emit("progress", { progress: 42.5, speed: "3.79MiB/s", eta: "00:35" })
    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    // the run announced itself first; this is the engine's own line
    expect(events[0]).toEqual(admitted())
    expect(events[1]).toEqual({
      downloadId: "combined_1",
      status: "downloading",
      progress: 42.5,
      indeterminate: undefined,
      speed: "3.79MiB/s",
      eta: "00:35"
    })
  })

  test("a trimmed download reports indeterminate instead of a percentage", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({
      ...BASE,
      trimmed: true,
      createHandle: () => handle
    })
    await settle()

    handle.emit("progress", { progress: 100, speed: null, eta: null })
    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    // [0] is the admission notice, which is indeterminate for its own reason
    expect(events[1].progress).toBeUndefined()
    expect(events[1].indeterminate).toBe(true)
  })
})

describe("terminal events", () => {
  test("completion carries the filename the renderer shows", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()
    jest.spyOn(fs, "statSync").mockReturnValue({ size: 5 * 1024 * 1024 })

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    handle.resolve({ filePath: "/downloads/My Video_720p_123.mp4" })
    const result = await running

    const terminal = events[events.length - 1]
    expect(terminal.status).toBe("completed")
    expect(terminal.progress).toBe(100)
    expect(terminal.filename).toBe("My Video_720p_123.mp4")
    // the reservation is deleted by now, so an event that did not say where the
    // file is and how big it is would be the last chance to ask
    expect(terminal.file_path).toBe("/downloads/My Video_720p_123.mp4")
    expect(terminal.file_size).toBe(5 * 1024 * 1024)
    expect(result.success).toBe(true)
    expect(result.download_id).toBe("combined_1")
    // the event and the result agree, because they are read off the same two
    // values rather than each computed from the engine's
    expect(result.file_path).toBe(terminal.file_path)
    expect(result.file_size).toBe(terminal.file_size)

    jest.restoreAllMocks()
  })

  test("a completion the engine named no file for keeps its old shape", async () => {
    // fileSizeOf answers 0 for a stat that failed as much as for one that never
    // happened, and "0 bytes" on a finished row is worse than no size at all
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    handle.resolve({})
    await running

    const terminal = events[events.length - 1]
    expect(terminal.status).toBe("completed")
    expect(terminal).not.toHaveProperty("file_path")
    expect(terminal).not.toHaveProperty("file_size")
  })

  test("failure carries the message and the stderr detail for the report", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    const error = new Error("This video isn't available for download.")
    error.code = ERROR_CODES.VIDEO_UNAVAILABLE
    error.details = "ERROR: [youtube] abc: Video unavailable"
    error.stderrTail = ["line one", "line two"]
    handle.reject(error)

    const result = await running
    const terminal = events[events.length - 1]

    expect(terminal.status).toBe("failed")
    expect(terminal.error).toBe("This video isn't available for download.")
    expect(terminal.details).toContain("ERROR: [youtube] abc: Video unavailable")
    expect(terminal.details).toContain("line two")
    expect(terminal.category).toBe(ERROR_CODES.VIDEO_UNAVAILABLE)
    expect(result.success).toBe(false)
  })

  test("cancellation emits cancelled, not failed", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    const error = new Error("Download cancelled.")
    error.code = ERROR_CODES.CANCELLED
    handle.reject(error)

    const result = await running

    expect(events[events.length - 1].status).toBe("cancelled")
    expect(result.cancelled).toBe(true)
  })
})

describe("repair-on-failure", () => {
  let log

  beforeEach(() => {
    // the retry path logs on purpose - keep it out of the suite output
    log = jest.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
  })

  const extractionError = () => {
    const error = new Error("YouTube changed something.")
    error.code = ERROR_CODES.EXTRACTION_FAILED
    error.updateMayFix = true
    return error
  }

  test("retries once when an update actually changed the version", async () => {
    const updater = {
      updateNow: async () => ({ updated: true, from: "2026.08.01", to: "2026.09.01" })
    }
    const { runner, events } = createRunner({ updater })

    const handles = [new FakeHandle(), new FakeHandle()]
    let index = 0

    const running = runner.run({
      ...BASE,
      createHandle: () => handles[index++]
    })
    await settle()

    handles[0].reject(extractionError())
    await settle()
    await settle()

    // second attempt is running now
    expect(index).toBe(2)
    handles[1].resolve({ filePath: "/downloads/a.mp4" })

    const result = await running

    expect(result.success).toBe(true)
    expect(events[events.length - 1].status).toBe("completed")
  })

  test("does not retry when the update changed nothing", async () => {
    const updater = { updateNow: async () => ({ updated: false, reason: "completed" }) }
    const { runner, events } = createRunner({ updater })

    let index = 0
    const handle = new FakeHandle()

    const running = runner.run({
      ...BASE,
      createHandle: () => {
        index += 1
        return handle
      }
    })
    await settle()

    handle.reject(extractionError())
    const result = await running

    expect(index).toBe(1)
    expect(result.success).toBe(false)
    expect(events[events.length - 1].status).toBe("failed")
  })

  test("retries at most once, even if the second attempt fails the same way", async () => {
    const updater = { updateNow: async () => ({ updated: true, from: "a", to: "b" }) }
    const { runner } = createRunner({ updater })

    const handles = [new FakeHandle(), new FakeHandle()]
    let index = 0

    const running = runner.run({
      ...BASE,
      createHandle: () => handles[index++]
    })
    await settle()

    handles[0].reject(extractionError())
    await settle()
    await settle()
    handles[1].reject(extractionError())

    const result = await running

    expect(index).toBe(2)
    expect(result.success).toBe(false)
  })

  test("ordinary failures never trigger an update", async () => {
    let called = false
    const updater = {
      updateNow: async () => {
        called = true
        return { updated: true }
      }
    }
    const { runner } = createRunner({ updater })
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    const error = new Error("Network interrupted the download.")
    error.code = ERROR_CODES.NETWORK_ERROR
    handle.reject(error)
    await running

    expect(called).toBe(false)
  })
})

describe("bookkeeping", () => {
  test("tracks the download while it runs and releases it after", async () => {
    const { runner } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    expect(runner.size).toBe(1)
    expect(runner.has("combined_1")).toBe(true)
    expect(runner.list()[0]).toMatchObject({
      downloadId: "combined_1",
      type: "combined",
      status: "downloading",
      progress: 0
    })

    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    expect(runner.size).toBe(0)
  })

  test("cancel reaches the running handle", async () => {
    const { runner } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    expect(runner.cancel("combined_1")).toBe(true)
    expect(handle.cancelled).toBe(true)

    expect(runner.cancel("nope")).toBe(false)

    const error = new Error("Download cancelled.")
    error.code = ERROR_CODES.CANCELLED
    handle.reject(error)
    await running
  })

  test("cancelAll stops everything still running", async () => {
    const { runner } = createRunner()
    const first = new FakeHandle()
    const second = new FakeHandle()

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: () => first })
    const b = runner.run({ ...BASE, downloadId: "b", createHandle: () => second })
    await settle()

    expect(runner.cancelAll()).toBe(2)
    expect(first.cancelled).toBe(true)
    expect(second.cancelled).toBe(true)

    const error = new Error("cancelled")
    error.code = ERROR_CODES.CANCELLED
    first.reject(error)
    second.reject(error)
    await Promise.all([a, b])
  })

  test("a handle that cannot even be created fails cleanly", async () => {
    const { runner, events } = createRunner()

    const result = await runner.run({
      ...BASE,
      createHandle: () => {
        const error = new Error("That doesn't look like a valid link.")
        error.code = "INVALID_URL"
        throw error
      }
    })

    expect(result.success).toBe(false)
    expect(events[events.length - 1].status).toBe("failed")
    expect(runner.size).toBe(0)
  })
})

describe("analytics", () => {
  test("reports a completion with its platform and format", async () => {
    const { runner, tracked } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    expect(tracked[0].name).toBe("download_completed")
    expect(tracked[0].platform).toBe("youtube")
    expect(tracked[0].formatId).toBe("720p")
  })

  test("reports neither the title nor the file it wrote", async () => {
    // the two of them were the only free text the runner ever sent, and what
    // was downloaded is not a question telemetry asks
    const { runner, tracked } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    handle.resolve({ filePath: "/downloads/My Video_720p_123.mp4" })
    await running

    expect(tracked[0]).not.toHaveProperty("title")
    expect(JSON.stringify(tracked[0])).not.toContain("My Video")
  })

  test("reports a cancel with how far it had got", async () => {
    // a cancel arrives from another call stack, so the reservation is the only
    // place the last progress could be read from by then
    const { runner, tracked } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    handle.emit("progress", { progress: 61.2 })
    runner.cancel("combined_1")

    const error = new Error("Download cancelled.")
    error.code = ERROR_CODES.CANCELLED
    handle.reject(error)
    await running

    expect(tracked).toHaveLength(1)
    expect(tracked[0].name).toBe("download_cancelled")
    expect(tracked[0].type).toBe("combined")
    expect(tracked[0].platform).toBe("youtube")
    expect(tracked[0].progress).toBe(61.2)
  })

  test("carries whether the download was trimmed", async () => {
    // the flag lives on the run options and nowhere else - the engine result
    // has no idea a time range was asked for
    const { runner, tracked } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({
      ...BASE,
      trimmed: true,
      createHandle: () => handle
    })
    await settle()

    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    expect(tracked[0].trimmed).toBe(true)
  })

  // whatever the throw site produced, including the shapes that defeat a guard
  // written as `error && error.message`: reading the property is what throws
  const HOSTILE_THROWS = [
    ["an Error", () => new Error("analytics exploded")],
    ["null", () => null],
    ["a string", () => "analytics exploded"],
    [
      "an object whose message getter throws",
      () => ({
        get message() {
          throw new Error("not even this")
        }
      })
    ]
  ]

  test.each(HOSTILE_THROWS)(
    "keeps a download alive when tracking it throws %s",
    async (_name, thrown) => {
      // these calls sit inside run()'s try, where a throw would be caught as
      // the download breaking - and the user would be told a finished file
      // failed. a throw the *catch* cannot survive lands in the same place
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      const runner = new DownloadRunner({
        engine: {},
        sendEvent: () => {},
        trackEvent: () => {
          throw thrown()
        }
      })
      const handle = new FakeHandle()

      const running = runner.run({ ...BASE, createHandle: () => handle })
      await settle()

      handle.resolve({ filePath: "/downloads/a.mp4" })

      await expect(running).resolves.toMatchObject({ success: true })
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    }
  )

  test("reports a failure with its error code", async () => {
    const { runner, tracked } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    const error = new Error("nope")
    error.code = ERROR_CODES.BOT_DETECTION
    handle.reject(error)
    await running

    expect(tracked[0].name).toBe("download_failed")
    expect(tracked[0].errorCode).toBe(ERROR_CODES.BOT_DETECTION)
  })
})

describe("cancellation windows", () => {
  test("a cancel between the ack and the spawn stops it starting at all", async () => {
    const { runner, events } = createRunner()
    let created = false

    // this is the window the review flagged: reserved, acknowledged, not yet run
    runner.reserve("combined_1", { type: "combined", platform: "youtube", title: "A Video" })
    expect(runner.cancel("combined_1")).toBe(true)

    const result = await runner.run({
      ...BASE,
      createHandle: () => {
        created = true
        return new FakeHandle()
      }
    })

    expect(created).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(events[events.length - 1].status).toBe("cancelled")
    expect(runner.size).toBe(0)
  })

  test("cancel is possible the moment the id is reserved", () => {
    const { runner } = createRunner()

    expect(runner.cancel("combined_1")).toBe(false)
    runner.reserve("combined_1", { type: "combined" })
    expect(runner.cancel("combined_1")).toBe(true)
  })

  test("a cancel during the repair update prevents the retry", async () => {
    let updateStarted = null
    const updater = {
      updateNow: () =>
        new Promise((resolve) => {
          updateStarted = () => resolve({ updated: true, from: "a", to: "b" })
        })
    }
    const { runner, events } = createRunner({ updater })

    const handles = [new FakeHandle(), new FakeHandle()]
    let index = 0

    const running = runner.run({ ...BASE, createHandle: () => handles[index++] })
    await settle()

    const error = new Error("YouTube changed something.")
    error.code = ERROR_CODES.EXTRACTION_FAILED
    error.updateMayFix = true
    handles[0].reject(error)
    await settle()

    // the user cancels while the updater is still running
    expect(runner.cancel("combined_1")).toBe(true)
    updateStarted()

    const result = await running

    expect(index).toBe(1)
    expect(result.cancelled).toBe(true)
    expect(events[events.length - 1].status).toBe("cancelled")
  })

  test("cancelling twice reports the first one only", async () => {
    const { runner } = createRunner()
    runner.reserve("combined_1", { type: "combined" })

    expect(runner.cancel("combined_1")).toBe(true)
    expect(runner.cancel("combined_1")).toBe(false)

    await runner.run({ ...BASE, createHandle: () => new FakeHandle() })
  })
})

describe("concurrent downloads", () => {
  test("two downloads keep their own events and bookkeeping", async () => {
    const { runner, events } = createRunner()
    const first = new FakeHandle()
    const second = new FakeHandle()

    const a = runner.run({ ...BASE, downloadId: "id-a", createHandle: () => first })
    const b = runner.run({ ...BASE, downloadId: "id-b", createHandle: () => second })
    await settle()

    expect(runner.size).toBe(2)

    first.emit("progress", { progress: 10 })
    second.emit("progress", { progress: 90 })
    await settle()

    // each run announces itself once, and then reports only its own progress
    expect(events.filter((e) => e.downloadId === "id-a").map((e) => e.progress)).toEqual([0, 10])
    expect(events.filter((e) => e.downloadId === "id-b").map((e) => e.progress)).toEqual([0, 90])

    // finishing one must not disturb the other's bookkeeping
    first.resolve({ filePath: "/downloads/a.mp4" })
    await a
    expect(runner.has("id-b")).toBe(true)

    second.resolve({ filePath: "/downloads/b.mp4" })
    await b
    expect(runner.size).toBe(0)
  })

  // the id comes from the renderer, so a repeat must not displace a live
  // download: the old entry would be lost, both event streams would share one
  // id, and the first completion would delete the second's bookkeeping
  test("a second reservation for a live id is refused", async () => {
    const { runner } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({
      ...BASE,
      downloadId: "id-a",
      createHandle: () => handle
    })
    await settle()

    expect(runner.reserve("id-a", { type: "audio", title: "Impostor" })).toBe(
      false
    )

    // the original entry is untouched
    expect(runner.size).toBe(1)
    expect(runner.list()[0]).toMatchObject({
      downloadId: "id-a",
      type: "combined",
      title: "A Video"
    })

    // and it still settles normally, cancelling the real handle
    expect(runner.cancel("id-a")).toBe(true)
    expect(handle.cancelled).toBe(true)

    const error = new Error("cancelled")
    error.code = ERROR_CODES.CANCELLED
    handle.reject(error)

    expect((await running).cancelled).toBe(true)
  })

  test("an id is reusable once its download has finished", async () => {
    const { runner } = createRunner()
    const first = new FakeHandle()

    const running = runner.run({
      ...BASE,
      downloadId: "id-a",
      createHandle: () => first
    })
    await settle()

    first.resolve({ filePath: "/downloads/a.mp4" })
    await running

    expect(runner.reserve("id-a", { type: "audio" })).toBe(true)
  })

  test("cancelling one leaves the other running", async () => {
    const { runner } = createRunner()
    const first = new FakeHandle()
    const second = new FakeHandle()

    const a = runner.run({ ...BASE, downloadId: "id-a", createHandle: () => first })
    const b = runner.run({ ...BASE, downloadId: "id-b", createHandle: () => second })
    await settle()

    runner.cancel("id-a")
    expect(first.cancelled).toBe(true)
    expect(second.cancelled).toBe(false)

    const error = new Error("cancelled")
    error.code = ERROR_CODES.CANCELLED
    first.reject(error)
    second.resolve({ filePath: "/downloads/b.mp4" })

    expect((await a).cancelled).toBe(true)
    expect((await b).success).toBe(true)
  })
})

/**
 * the queue
 *
 * the runner starts at most MAX_CONCURRENT_DOWNLOADS downloads at once and
 * holds the rest in the order they were reserved. everything above this line
 * runs two downloads at most, which is under the real cap, so none of it ever
 * meets the queue - these set maxConcurrent to 1 or 2 instead of starting four
 * downloads to reach it.
 */
describe("queue", () => {
  // a createHandle that records the moment it was called, which is the only
  // way to say how many processes the runner was actually willing to start:
  // a reservation exists whether or not anything spawned
  function spawner(handle, log, id) {
    return () => {
      log.push(id)
      return handle
    }
  }

  const completion = { filePath: "/downloads/a.mp4" }

  test("only maxConcurrent downloads hold a process at once", async () => {
    const { runner } = createRunner({ maxConcurrent: 2 })
    const spawned = []
    const handles = [new FakeHandle(), new FakeHandle(), new FakeHandle()]

    const runs = ["a", "b", "c"].map((id, index) =>
      runner.run({
        ...BASE,
        downloadId: id,
        createHandle: spawner(handles[index], spawned, id)
      })
    )
    await settle()

    expect(spawned).toEqual(["a", "b"])
    // the third is waiting, not refused: every one of them is reserved, which
    // is what system:health counts and what a downloads list draws
    expect(runner.size).toBe(3)

    handles[0].resolve(completion)
    await runs[0]
    await settle()

    expect(spawned).toEqual(["a", "b", "c"])

    handles[1].resolve(completion)
    handles[2].resolve(completion)
    await Promise.all(runs)

    expect(runner.size).toBe(0)
  })

  test("a freed slot goes to whichever download has waited longest", async () => {
    const { runner } = createRunner({ maxConcurrent: 1 })
    const spawned = []
    const handles = [new FakeHandle(), new FakeHandle(), new FakeHandle()]

    const runs = ["a", "b", "c"].map((id, index) =>
      runner.run({
        ...BASE,
        downloadId: id,
        createHandle: spawner(handles[index], spawned, id)
      })
    )
    await settle()

    expect(spawned).toEqual(["a"])

    handles[0].resolve(completion)
    await runs[0]
    await settle()

    // b, not c: the queue is fifo by reservation, so pasting a fourth link does
    // not push the third one further down the list
    expect(spawned).toEqual(["a", "b"])

    handles[1].resolve(completion)
    await runs[1]
    await settle()

    expect(spawned).toEqual(["a", "b", "c"])

    handles[2].resolve(completion)
    await runs[2]
  })

  /**
   * the order runs reach the semaphore need not be the order they were
   * reserved in
   *
   * the ipc layer no longer produces that mismatch: every kind starts through
   * startDownload, which defers run() by a setImmediate with nothing awaited
   * between it and reserve(). it used to, back when the simple-platform path
   * awaited run() inline and a tiktok link pasted after a youtube one called
   * run() first. the guarantee is still "accepted first, run first", so it is
   * still tested directly: the test above cannot see the difference, because it
   * reserves and invokes in the same order.
   */
  test("a download reserved first is queued first, whichever run() parked first", async () => {
    const { runner } = createRunner({ maxConcurrent: 1 })
    const spawned = []
    const handles = { a: new FakeHandle(), b: new FakeHandle(), c: new FakeHandle() }

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: spawner(handles.a, spawned, "a") })
    await settle()

    // b is accepted second and c third, exactly as the ipc layer would claim
    // them, and then c is the one that gets to run() first
    runner.reserve("b", { type: "combined", platform: "youtube", title: "Second" })
    runner.reserve("c", { type: "combined", platform: "tiktok", title: "Third" })

    const c = runner.run({ ...BASE, downloadId: "c", createHandle: spawner(handles.c, spawned, "c") })
    await settle()
    const b = runner.run({ ...BASE, downloadId: "b", createHandle: spawner(handles.b, spawned, "b") })
    await settle()

    expect(spawned).toEqual(["a"])

    handles.a.resolve(completion)
    await a
    await settle()

    // b, the earlier reservation, even though c parked first
    expect(spawned).toEqual(["a", "b"])

    handles.b.resolve(completion)
    await b
    await settle()

    expect(spawned).toEqual(["a", "b", "c"])

    handles.c.resolve(completion)
    await c
  })

  test("every accepted run announces itself once, parked or not", async () => {
    const { runner, events } = createRunner({ maxConcurrent: 1 })
    const handles = [new FakeHandle(), new FakeHandle(), new FakeHandle()]

    const runs = ["a", "b", "c"].map((id, index) =>
      runner.run({
        ...BASE,
        downloadId: id,
        createHandle: () => handles[index]
      })
    )
    await settle()

    // the exact payloads the renderer draws from: b and c are parked in the
    // same tick their runs are asked for, and a says it is running once its
    // handle exists a turn later
    expect(events).toEqual([
      { downloadId: "b", status: "queued", progress: 0 },
      { downloadId: "c", status: "queued", progress: 0 },
      admitted("a")
    ])

    handles[0].resolve(completion)
    await runs[0]
    await settle()

    // b started: it does not repeat the queued event on the way out of the
    // queue, and it announces itself exactly once like everything else
    expect(events.filter((event) => event.status === "queued")).toHaveLength(2)
    expect(
      events.filter(
        (event) => event.downloadId === "b" && event.status === "downloading"
      )
    ).toEqual([admitted("b")])

    handles[1].resolve(completion)
    await runs[1]
    await settle()
    handles[2].resolve(completion)
    await runs[2]
  })

  // every terminal path has to free the slot, or the queue stops draining and
  // the app is stuck at however many downloads happened to be running
  const SETTLEMENTS = [
    ["a completion", (handle) => handle.resolve(completion)],
    ["a failure", (handle) => handle.reject(new Error("Download failed"))],
    [
      "a cancellation",
      (handle) => {
        const error = new Error("cancelled")
        error.code = ERROR_CODES.CANCELLED
        handle.reject(error)
      }
    ]
  ]

  test.each(SETTLEMENTS)("the slot is freed by %s", async (_name, finish) => {
    const { runner } = createRunner({ maxConcurrent: 1 })
    const spawned = []
    const first = new FakeHandle()
    const second = new FakeHandle()

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: spawner(first, spawned, "a") })
    const b = runner.run({ ...BASE, downloadId: "b", createHandle: spawner(second, spawned, "b") })
    await settle()

    expect(spawned).toEqual(["a"])

    finish(first)
    await a
    await settle()

    expect(spawned).toEqual(["a", "b"])

    second.resolve(completion)
    await b
  })

  test("a handle that could not even be created frees the slot too", async () => {
    const { runner } = createRunner({ maxConcurrent: 1 })
    const spawned = []
    const second = new FakeHandle()

    const a = runner.run({
      ...BASE,
      downloadId: "a",
      createHandle: () => {
        const error = new Error("That doesn't look like a valid link.")
        error.code = "INVALID_URL"
        throw error
      }
    })
    const b = runner.run({ ...BASE, downloadId: "b", createHandle: spawner(second, spawned, "b") })

    expect((await a).success).toBe(false)
    await settle()

    expect(spawned).toEqual(["b"])

    second.resolve(completion)
    await b
  })

  test("cancelling a queued download settles it without spawning anything", async () => {
    const { runner, events } = createRunner({ maxConcurrent: 1 })
    const spawned = []
    const first = new FakeHandle()
    const second = new FakeHandle()

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: spawner(first, spawned, "a") })
    const b = runner.run({ ...BASE, downloadId: "b", createHandle: spawner(second, spawned, "b") })
    await settle()

    expect(runner.cancel("b")).toBe(true)
    expect((await b).cancelled).toBe(true)

    // no process was ever made for it, and the running download still holds
    // the only slot: a cancel gives nothing away
    expect(spawned).toEqual(["a"])
    expect(events.filter((event) => event.downloadId === "b").map((event) => event.status)).toEqual(
      ["queued", "cancelled"]
    )
    expect(runner.size).toBe(1)

    /**
     * and the slot really is still a's.
     *
     * counting reservations cannot show this. a run() that released
     * unconditionally instead of only when it holds a slot would pass every
     * assertion above and still have decremented `running` on b's behalf,
     * which only a fresh download can reveal: c would start beside a at a cap
     * of one, and the counter would go negative from there.
     */
    const third = new FakeHandle()
    const c = runner.run({ ...BASE, downloadId: "c", createHandle: spawner(third, spawned, "c") })
    await settle()

    expect(spawned).toEqual(["a"])

    first.resolve(completion)
    await a
    await settle()

    expect(spawned).toEqual(["a", "c"])

    third.resolve(completion)
    await c

    expect(runner.size).toBe(0)
  })

  test("a cancel between the handoff and the waiter waking passes the slot on", async () => {
    const { runner, events } = createRunner({ maxConcurrent: 1 })
    const spawned = []
    const first = new FakeHandle()
    const second = new FakeHandle()
    const third = new FakeHandle()

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: spawner(first, spawned, "a") })
    const b = runner.run({ ...BASE, downloadId: "b", createHandle: spawner(second, spawned, "b") })
    await settle()
    const c = runner.run({ ...BASE, downloadId: "c", createHandle: spawner(third, spawned, "c") })
    await settle()

    expect(spawned).toEqual(["a"])

    /**
     * the one window a test cannot reach by awaiting.
     *
     * the handoff is synchronous inside releaseSlot, and the waiter it wakes
     * resumes a microtask later - by which time an `await` in the test has
     * already missed it. cancelling from in here lands exactly between the
     * two: b holds a slot it is about to discover it does not want, which is
     * the opposite of the cancel the test above covers.
     */
    const releaseSlot = runner.releaseSlot.bind(runner)
    let queuedWhenCancelled = null

    runner.releaseSlot = () => {
      releaseSlot()

      if (!queuedWhenCancelled) {
        queuedWhenCancelled = runner.waiting.map((waiter) => waiter.downloadId)
        runner.cancel("b")
      }
    }

    first.resolve(completion)
    await a
    await settle()

    // the cancel really did land on the far side of the handoff: b was out of
    // the queue and holding the slot by then. without this the test passes
    // either way, because a cancel one moment earlier ends the same
    expect(queuedWhenCancelled).toEqual(["c"])

    expect((await b).cancelled).toBe(true)
    expect(events.filter((event) => event.downloadId === "b").map((event) => event.status)).toEqual(
      ["queued", "cancelled"]
    )

    // b never spawned, and the slot it was holding went to c rather than
    // being released twice or not at all
    expect(spawned).toEqual(["a", "c"])

    third.resolve(completion)
    await c

    expect(runner.size).toBe(0)
  })

  test("cancelAll clears the queued rows along with the running one", async () => {
    const { runner } = createRunner({ maxConcurrent: 1 })
    const spawned = []
    const handles = [new FakeHandle(), new FakeHandle(), new FakeHandle()]

    const runs = ["a", "b", "c"].map((id, index) =>
      runner.run({
        ...BASE,
        downloadId: id,
        createHandle: spawner(handles[index], spawned, id)
      })
    )
    await settle()

    expect(runner.cancelAll()).toBe(3)
    await settle()

    // the two queued rows have settled, and neither handed its slot to
    // anybody: a is still the only download holding one
    const fresh = new FakeHandle()
    const d = runner.run({ ...BASE, downloadId: "d", createHandle: spawner(fresh, spawned, "d") })
    await settle()

    expect(spawned).toEqual(["a"])

    const error = new Error("cancelled")
    error.code = ERROR_CODES.CANCELLED
    handles[0].reject(error)

    const results = await Promise.all(runs)

    expect(results.every((result) => result.cancelled)).toBe(true)
    // the two that were queued never became processes
    expect(spawned).toEqual(["a", "d"])

    fresh.resolve(completion)
    await d

    expect(runner.size).toBe(0)
  })

  test("a queued row is listed, with what a retry would need", async () => {
    const { runner } = createRunner({ maxConcurrent: 1 })
    const handles = [new FakeHandle(), new FakeHandle()]

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: () => handles[0] })

    // the ipc handlers reserve with the request and the label before they
    // acknowledge, exactly as this does
    runner.reserve("b", {
      type: "combined",
      platform: "youtube",
      title: "Another Video",
      label: "1080p mp4",
      request: { url: "https://youtu.be/b", title: "Another Video", height: 1080 }
    })
    const b = runner.run({ ...BASE, downloadId: "b", createHandle: () => handles[1] })
    await settle()

    const rows = runner.list()

    expect(rows.find((row) => row.downloadId === "a").status).toBe("downloading")
    expect(rows.find((row) => row.downloadId === "b")).toMatchObject({
      status: "queued",
      progress: 0,
      title: "Another Video",
      label: "1080p mp4",
      request: { url: "https://youtu.be/b", height: 1080 }
    })

    handles[0].resolve(completion)
    await a
    await settle()
    handles[1].resolve(completion)
    await b
  })

  test("the repair-on-failure retry never gives its slot away mid-run", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {})
    const updater = {
      updateNow: async () => ({ updated: true, from: "2026.08.01", to: "2026.09.01" })
    }
    const { runner } = createRunner({ maxConcurrent: 1, updater })

    const spawned = []
    const attempts = [new FakeHandle(), new FakeHandle()]
    let index = 0
    const queuedHandle = new FakeHandle()

    const a = runner.run({
      ...BASE,
      downloadId: "a",
      createHandle: () => {
        spawned.push("a")
        return attempts[index++]
      }
    })
    const b = runner.run({
      ...BASE,
      downloadId: "b",
      createHandle: spawner(queuedHandle, spawned, "b")
    })
    await settle()

    const error = new Error("YouTube changed something.")
    error.code = ERROR_CODES.EXTRACTION_FAILED
    error.updateMayFix = true
    attempts[0].reject(error)
    await settle()
    await settle()

    // the second attempt of the same download, and still no fourth process:
    // freeing the slot for the length of an update is how a cap of three ends
    // up running four
    expect(spawned).toEqual(["a", "a"])

    attempts[1].resolve(completion)
    await a
    await settle()

    expect(spawned).toEqual(["a", "a", "b"])

    queuedHandle.resolve(completion)
    await b
    log.mockRestore()
  })

  /**
   * the other half of the queued event
   *
   * a trimmed download is one ffmpeg pass that reports nothing until the end,
   * so between taking a slot and finishing there is no progress line to move
   * the row off `queued` - the panel would offer Remove on a download that is
   * writing its file. the transition is announced instead of inferred.
   */
  /**
   * the one event a silent run sends, and the reason it is sent at all
   *
   * a trimmed download is one ffmpeg pass that reports nothing until it is
   * done, and a window that reloaded between the request and the reservation
   * has no row for it: no Stop, nothing in the active count, no identity for
   * the duplicate check, until the completion lands. This is what that window
   * hears instead.
   */
  test("a free-slot run that the engine never reports on still says it is running", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({
      ...BASE,
      downloadId: "silent-after-reload",
      trimmed: true,
      createHandle: () => handle
    })
    await settle()

    expect(events).toEqual([admitted("silent-after-reload")])

    handle.resolve(completion)
    await running

    expect(events.map((event) => event.status)).toEqual([
      "downloading",
      "completed"
    ])
  })

  test("a download that waited says so the moment it takes a slot", async () => {
    const { runner, events } = createRunner({ maxConcurrent: 1 })
    const handles = [new FakeHandle(), new FakeHandle()]

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: () => handles[0] })
    const b = runner.run({
      ...BASE,
      downloadId: "b",
      trimmed: true,
      createHandle: () => handles[1]
    })
    await settle()

    handles[0].resolve(completion)
    await a
    await settle()

    // b holds the slot and has emitted nothing of its own yet: this is the
    // whole of what the renderer has been told about it
    expect(events.filter((event) => event.downloadId === "b")).toEqual([
      { downloadId: "b", status: "queued", progress: 0 },
      admitted("b")
    ])

    // and a, which never waited, said the same thing once: a window that
    // hydrated after it was reserved has no other way to hear that it is
    // running, and a trimmed run says nothing else until it is done
    expect(
      events.filter(
        (event) => event.downloadId === "a" && event.status === "downloading"
      )
    ).toEqual([admitted("a")])

    handles[1].resolve(completion)
    await b
  })

  /**
   * the quit, which is where the queue and the engine's shutdown wait meet
   *
   * `freeze` is the half of the teardown that can run before the history
   * marking: it settles nothing, so the rows are still live to be marked, and
   * no slot can change hands while that write is in flight.
   */
  test("a frozen queue hands a freed slot to nobody", async () => {
    const { runner } = createRunner({ maxConcurrent: 1 })
    const spawned = []
    const first = new FakeHandle()
    const second = new FakeHandle()

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: spawner(first, spawned, "a") })
    const b = runner.run({ ...BASE, downloadId: "b", createHandle: spawner(second, spawned, "b") })
    await settle()

    expect(spawned).toEqual(["a"])

    runner.freeze()

    // the cancel that was already in flight when the quit began, landing now
    const cancelled = new Error("cancelled")
    cancelled.code = ERROR_CODES.CANCELLED
    first.reject(cancelled)
    await a
    await settle()

    // b is still where it was: a freeze is not a cancel, and the row has not
    // been settled behind the user's back either
    expect(spawned).toEqual(["a"])
    expect(runner.size).toBe(1)

    // and the cancelAll that follows the freeze is what ends it, with nothing
    // ever spawned for it
    expect(runner.cancelAll()).toBe(1)
    expect((await b).cancelled).toBe(true)
    expect(spawned).toEqual(["a"])
  })

  /**
   * the one window where a run holds a slot and no handle
   *
   * `updateNow()` can take as long as a download, and a quit landing inside it
   * finds this run past every check the freeze relies on. the update resolving
   * would then start a second process into a closing app.
   */
  test("a repair attempt does not spawn into a quit", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {})
    let finishUpdate
    const updater = {
      updateNow: () =>
        new Promise((resolve) => {
          finishUpdate = () => resolve({ updated: true, from: "1", to: "2" })
        })
    }
    const { runner } = createRunner({ maxConcurrent: 1, updater })

    const spawned = []
    const first = new FakeHandle()

    const a = runner.run({
      ...BASE,
      downloadId: "a",
      createHandle: spawner(first, spawned, "a")
    })
    await settle()

    const error = new Error("YouTube changed something.")
    error.code = ERROR_CODES.EXTRACTION_FAILED
    error.updateMayFix = true
    first.reject(error)
    await settle()

    // the run is now waiting on the update, holding its slot with no process
    expect(spawned).toEqual(["a"])

    runner.freeze()
    finishUpdate()

    expect((await a).cancelled).toBe(true)
    expect(spawned).toEqual(["a"])
    log.mockRestore()
  })

  test("the slot is announced once, repair pass included", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {})
    const updater = {
      updateNow: async () => ({ updated: true, from: "1", to: "2" })
    }
    const { runner, events } = createRunner({ maxConcurrent: 1, updater })

    const attempts = [new FakeHandle(), new FakeHandle()]
    let index = 0
    const holding = new FakeHandle()

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: () => holding })
    const b = runner.run({
      ...BASE,
      downloadId: "b",
      createHandle: () => attempts[index++]
    })
    await settle()

    holding.resolve(completion)
    await a
    await settle()

    const error = new Error("YouTube changed something.")
    error.code = ERROR_CODES.EXTRACTION_FAILED
    error.updateMayFix = true
    attempts[0].reject(error)
    await settle()
    await settle()

    // b is on its second attempt, holding the slot it was given once. the
    // transition out of the queue happened once and is not re-announced: a
    // repaired run picks up where the first attempt's progress left off
    expect(
      events.filter(
        (event) => event.downloadId === "b" && event.status === "downloading"
      )
    ).toEqual([
      {
        downloadId: "b",
        status: "downloading",
        progress: 0,
        indeterminate: true
      }
    ])

    attempts[1].resolve(completion)
    await b
    log.mockRestore()
  })

  test("a run reaching a frozen queue settles instead of spawning", async () => {
    // the reservation was accepted before the quit and its run() is one
    // setImmediate behind it. parking it would wait on a promise nobody is
    // left to resolve, and starting it is the thing the freeze exists to stop
    const { runner } = createRunner({ maxConcurrent: 3 })
    const spawned = []
    const handle = new FakeHandle()

    runner.freeze()

    const a = runner.run({ ...BASE, downloadId: "a", createHandle: spawner(handle, spawned, "a") })

    expect((await a).cancelled).toBe(true)
    expect(spawned).toEqual([])
    expect(runner.size).toBe(0)
  })
})

// =============================================================================
// playlists
// =============================================================================

// a playlist is one download id covering n files, so everything below is about
// the runner reporting more without any of it reaching a single-video download.
// the engine hangs the same five keys on a result and on a rejection, which is
// what these fake handles reproduce - see tests/ytdlp-playlist-progress.test.js
// for where that shape is pinned against the binary

const PLAYLIST = {
  downloadId: "playlist_1",
  type: "combined",
  platform: "youtube",
  title: "Short talks",
  formatId: "1080p",
  playlist: true
}

// what YtdlpOperation resolves a playlist run with
function playlistResult(overrides = {}) {
  return {
    filePath: "/downloads/PL/002 - Two [bbb] 1080p.mp4",
    stderr: "",
    files: [
      "/downloads/PL/001 - One [aaa] 1080p.mp4",
      "/downloads/PL/002 - Two [bbb] 1080p.mp4"
    ],
    itemsSaved: 2,
    itemsReused: 0,
    itemsSkipped: 0,
    itemsTotal: 2,
    ...overrides
  }
}

// ...and what it rejects with: the same tally, on the error
function playlistError(code, message, overrides = {}) {
  const error = new Error(message)
  error.code = code
  error.files = []
  error.itemsSaved = 0
  error.itemsReused = 0
  error.itemsSkipped = 0
  error.itemsTotal = 0
  return Object.assign(error, overrides)
}

describe("playlist progress", () => {
  test("the per-item fields ride along with the run's own bar", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    handle.emit("progress", {
      progress: 41.2,
      overallProgress: 41.2,
      itemProgress: 62,
      itemsCompleted: 3,
      totalItems: 9,
      itemIndex: 4,
      playlistIndex: 6,
      videoId: "aaaaaaaaaaa",
      speed: "6.40MiB/s",
      eta: "00:12"
    })

    handle.resolve(playlistResult())
    await running

    expect(events[0]).toEqual(admitted("playlist_1"))
    expect(events[1]).toEqual({
      downloadId: "playlist_1",
      status: "downloading",
      // the flat bar every existing consumer reads is the *run's*, unchanged
      progress: 41.2,
      indeterminate: undefined,
      speed: "6.40MiB/s",
      eta: "00:12",
      item_progress: 62,
      item_index: 4,
      items_completed: 3,
      items_total: 9,
      // the video's true position in the playlist, which is not its position
      // in a selection with a gap in it
      playlist_index: 6,
      video_id: "aaaaaaaaaaa"
    })
  })

  test("a single video's progress payload gains nothing at all", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    // even if an update somehow carried them, this download is not a playlist
    handle.emit("progress", {
      progress: 42.5,
      itemProgress: 62,
      itemsCompleted: 3,
      totalItems: 9
    })
    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    expect(events[1]).toEqual({
      downloadId: "combined_1",
      status: "downloading",
      progress: 42.5,
      indeterminate: undefined,
      speed: undefined,
      eta: undefined
    })
  })
})

describe("playlist outcomes", () => {
  test("a partial playlist is completed, with what it saved and what it did not", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    handle.resolve(
      playlistResult({
        files: ["/downloads/PL/001 - One [aaa] 1080p.mp4"],
        itemsSaved: 1,
        itemsReused: 0,
        itemsSkipped: 8,
        itemsTotal: 9,
        stderr: "ERROR: [youtube] bbb: Video unavailable"
      })
    )

    const result = await running
    const terminal = events[events.length - 1]

    // not a fourth status: "some were skipped" is a property of a finished job
    expect(terminal.status).toBe("completed")
    expect(terminal.progress).toBe(100)
    expect(terminal.items_saved).toBe(1)
    expect(terminal.items_skipped).toBe(8)
    expect(terminal.items_total).toBe(9)
    expect(terminal.files).toEqual(["/downloads/PL/001 - One [aaa] 1080p.mp4"])
    expect(result.success).toBe(true)
    expect(result.items_saved).toBe(1)
    // a playlist has no single file, so the last one it saved is what file_path
    // names. `files` is what a playlist row reads, and the result has always
    // carried the same pair
    expect(terminal.file_path).toBe(result.file_path)
  })

  test("archive skips are reported as reused and never counted as saved", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    // an archive skip says a download once succeeded, not that a file was
    // written now - the user may have deleted it since
    handle.resolve(
      playlistResult({ files: [], itemsSaved: 0, itemsReused: 2, itemsTotal: 2 })
    )

    const result = await running
    const terminal = events[events.length - 1]

    expect(terminal.items_saved).toBe(0)
    expect(terminal.items_reused).toBe(2)
    expect(result.items_saved).toBe(0)
    expect(result.items_reused).toBe(2)
  })

  test("skipped items keep the reason they were skipped for", async () => {
    // the run completed, so nothing else will ever classify this stderr - and
    // bot detection reaching the escalation is the whole point of doing it
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    handle.resolve(
      playlistResult({
        files: ["/downloads/PL/001 - One [aaa] 1080p.mp4"],
        itemsSaved: 1,
        itemsSkipped: 9,
        itemsTotal: 10,
        stderr: "ERROR: [youtube] bbb: Sign in to confirm you're not a bot"
      })
    )

    const result = await running

    expect(events[events.length - 1].category).toBe(
      ERROR_CATEGORIES.BOT_DETECTION
    )
    expect(result.category).toBe(ERROR_CATEGORIES.BOT_DETECTION)
  })

  test("a run that skipped nothing carries no failure category", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    handle.resolve(playlistResult({ stderr: "WARNING: something harmless" }))
    const result = await running

    expect(events[events.length - 1].category).toBeUndefined()
    expect(result.category).toBeUndefined()
  })

  test("a cancel reports the videos that had already landed", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    runner.cancel("playlist_1")
    handle.reject(
      playlistError(ERROR_CODES.CANCELLED, "Download cancelled.", {
        files: ["/downloads/PL/001 - One [aaa] 1080p.mp4"],
        itemsSaved: 1,
        itemsSkipped: 2,
        itemsTotal: 3
      })
    )

    const result = await running
    const terminal = events[events.length - 1]

    expect(terminal.status).toBe("cancelled")
    expect(terminal.files).toEqual(["/downloads/PL/001 - One [aaa] 1080p.mp4"])
    expect(terminal.items_saved).toBe(1)
    expect(result.cancelled).toBe(true)
    expect(result.items_saved).toBe(1)
  })

  test("a stall keeps them too", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    handle.reject(
      playlistError(ERROR_CODES.STALLED, "The download stopped responding.", {
        files: ["/downloads/PL/001 - One [aaa] 1080p.mp4"],
        itemsSaved: 1,
        itemsSkipped: 1,
        itemsTotal: 2
      })
    )

    await running
    const terminal = events[events.length - 1]

    expect(terminal.status).toBe("failed")
    expect(terminal.items_saved).toBe(1)
    expect(terminal.files).toHaveLength(1)
  })

  test("a run that could not prepare its records file says exactly that", async () => {
    // the engine refuses to start when it cannot write its private record of
    // what the run saved. that has nothing to do with the network, the link or
    // the download folder, so collapsing it into "please try again" would send
    // the user back to a wall they can only get past through permissions
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    handle.reject(
      playlistError(
        ERROR_CODES.PERMISSION_ERROR,
        "Cliply couldn't prepare its record of this download.",
        {
          suggestion:
            "Check permissions on Cliply's app data folder and try again.",
          wordingCode: "RECORDS_UNWRITABLE",
          itemsSkipped: 2,
          itemsTotal: 2
        }
      )
    )

    await running
    const terminal = events[events.length - 1]

    expect(terminal.status).toBe("failed")
    expect(terminal.error).toBe(
      "Cliply couldn't prepare its record of this download."
    )
    expect(terminal.suggestion).toBe(
      "Check permissions on Cliply's app data folder and try again."
    )
    expect(terminal.category).toBe(ERROR_CODES.PERMISSION_ERROR)
    /**
     * ...and the name of that wording travels with it. the category is the
     * same PERMISSION_ERROR a download folder we cannot write to reports, and
     * the renderer translates the two into opposite advice: only this tells
     * them apart once the sentence has been swapped for a russian one.
     */
    expect(terminal.wordingCode).toBe("RECORDS_UNWRITABLE")
  })

  test("and an ordinary failure names no wording of its own", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    handle.reject(
      playlistError(
        ERROR_CODES.PERMISSION_ERROR,
        "Cliply cannot write to the download folder.",
        { itemsSkipped: 2, itemsTotal: 2 }
      )
    )

    await running
    const terminal = events[events.length - 1]

    // the taxonomy's own entry, which is what its category should translate to
    expect(terminal.category).toBe(ERROR_CODES.PERMISSION_ERROR)
    expect(terminal).not.toHaveProperty("wordingCode")
  })

  test("a downloads list can tell a playlist row from a single video", async () => {
    // both are one row. the difference is that a playlist row expands into the
    // n videos it is downloading one after another, and `type` cannot say so:
    // a playlist of videos is "combined" exactly as one video is
    const { runner } = createRunner()
    const video = new FakeHandle()
    const list = new FakeHandle()

    const a = runner.run({ ...BASE, createHandle: () => video })
    const b = runner.run({ ...PLAYLIST, createHandle: () => list })
    await settle()

    const rows = runner.list()

    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.downloadId === "combined_1")).toMatchObject({
      type: "combined",
      playlist: false
    })
    expect(rows.find((row) => row.downloadId === "playlist_1")).toMatchObject({
      type: "combined",
      playlist: true
    })

    video.resolve({ filePath: "/downloads/a.mp4" })
    list.resolve(playlistResult())
    await Promise.all([a, b])
  })

  test("a reservation made before the run carries it too", async () => {
    // the ipc handlers reserve the id before they acknowledge the request, so
    // this is the path every real playlist download actually takes
    const { runner } = createRunner()

    runner.reserve("playlist_2", { type: "audio", playlist: true })
    runner.reserve("audio_2", { type: "audio" })

    const rows = runner.list()

    expect(rows.find((row) => row.downloadId === "playlist_2").playlist).toBe(true)
    // false rather than absent: a row that never says is a row a downloads
    // list has to guess about
    expect(rows.find((row) => row.downloadId === "audio_2").playlist).toBe(false)
  })

  test("a single video's failed event still carries no suggestion", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    const error = new Error("This video isn't available for download.")
    error.code = ERROR_CODES.VIDEO_UNAVAILABLE
    error.suggestion = "Try a different video"
    handle.reject(error)
    await running

    expect(events[events.length - 1]).not.toHaveProperty("suggestion")
    expect(events[events.length - 1]).not.toHaveProperty("items_total")
  })
})

/**
 * what the runner writes down, and when
 *
 * the history itself is pinned in tests/download-history.test.js; these are
 * about the three moments the runner hands it a row, and about the rule that
 * nothing else does.
 */
describe("history", () => {
  // records the rows rather than storing them: what matters here is what the
  // runner said and how often, not what a file ended up holding
  function createHistory() {
    const rows = []

    return {
      rows,
      upsert: jest.fn((row) => {
        rows.push(row)
        return Promise.resolve()
      }),
      // the row for one download, as the writes so far leave it
      row: (downloadId = BASE.downloadId) =>
        rows
          .filter((entry) => entry.download_id === downloadId)
          .reduce((merged, entry) => ({ ...merged, ...entry }), {})
    }
  }

  test("a reservation is written down before anything runs", () => {
    const history = createHistory()
    const { runner } = createRunner({ history })

    runner.reserve("combined_1", {
      type: "combined",
      platform: "youtube",
      title: "A Video",
      label: "1080p mp4",
      request: { url: "https://youtu.be/x", height: 1080 }
    })

    expect(history.rows).toHaveLength(1)
    expect(history.rows[0]).toMatchObject({
      download_id: "combined_1",
      kind: "video",
      platform: "youtube",
      title: "A Video",
      label: "1080p mp4",
      status: "queued",
      request: { url: "https://youtu.be/x", height: 1080 }
    })
    // when the user asked, which is where the row belongs in the list
    expect(history.rows[0].started_at).toEqual(expect.any(Number))
  })

  test("the slot being taken is the second write", async () => {
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    expect(history.rows.map((row) => row.status)).toEqual([
      "queued",
      "downloading"
    ])

    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running
  })

  test("a download waiting behind the cap stays queued until its turn", async () => {
    const history = createHistory()
    const { runner } = createRunner({ history, maxConcurrent: 1 })
    const handles = [new FakeHandle(), new FakeHandle()]

    const runs = ["a", "b"].map((id, index) =>
      runner.run({ ...BASE, downloadId: id, createHandle: () => handles[index] })
    )
    await settle()

    expect(history.row("b").status).toBe("queued")

    handles[0].resolve({ filePath: "/downloads/a.mp4" })
    await runs[0]
    await settle()

    expect(history.row("b").status).toBe("downloading")

    handles[1].resolve({ filePath: "/downloads/b.mp4" })
    await Promise.all(runs)
  })

  test("progress never writes", async () => {
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    for (let percent = 1; percent <= 50; percent++) {
      handle.emit("progress", { progress: percent, speed: "3MiB/s" })
    }

    // three per download is the whole budget: a percentage is not worth a file
    // rewrite, and the panel is watching the events for it anyway
    expect(history.upsert).toHaveBeenCalledTimes(2)

    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    expect(history.upsert).toHaveBeenCalledTimes(3)
  })

  test("a completed download says where the file went and how big it is", async () => {
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()
    jest.spyOn(fs, "statSync").mockReturnValue({ size: 8_000_000 })

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()
    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    expect(history.row()).toMatchObject({
      status: "completed",
      filename: "a.mp4",
      file_path: "/downloads/a.mp4",
      file_size: 8_000_000
    })
    expect(history.row().finished_at).toEqual(expect.any(Number))

    fs.statSync.mockRestore()
  })

  test("a completion the engine named no file for claims none", async () => {
    // a zero-byte file is what a row would otherwise show, and it would be a
    // lie about a download that worked
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()
    handle.resolve({})
    await running

    expect(history.row().status).toBe("completed")
    expect(history.row()).not.toHaveProperty("file_path")
    expect(history.row()).not.toHaveProperty("file_size")
  })

  test("a failed download keeps the wording and the category the event carried", async () => {
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    const error = new Error("YouTube asked us to confirm you're not a bot.")
    error.code = ERROR_CODES.BOT_DETECTION
    handle.reject(error)
    await running

    expect(history.row()).toMatchObject({
      status: "failed",
      error: "YouTube asked us to confirm you're not a bot.",
      category: ERROR_CODES.BOT_DETECTION
    })
  })

  test("a cancelled download is written down as cancelled", async () => {
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    runner.cancel(BASE.downloadId)
    const error = new Error("cancelled")
    error.code = ERROR_CODES.CANCELLED
    handle.reject(error)
    await running

    expect(history.row().status).toBe("cancelled")
    expect(history.row().finished_at).toEqual(expect.any(Number))
  })

  test.each([
    ["a single video", { type: "combined", platform: "youtube" }, "video"],
    ["an audio download", { type: "audio", platform: "youtube" }, "audio"],
    ["a tiktok", { type: "combined", platform: "tiktok" }, "simple"],
    ["a pinterest video", { type: "combined", platform: "pinterest" }, "simple"],
    [
      "a playlist",
      { type: "combined", platform: "youtube", playlist: true },
      "playlist"
    ],
    [
      // the one the order decides: it fetches audio and it is still a playlist
      // row, and only the playlist channel can re-send the request it stored
      "a playlist of audio",
      { type: "audio", platform: "youtube", playlist: true },
      "playlist"
    ]
  ])("%s is a %s row", (_name, details, kind) => {
    const history = createHistory()
    const { runner } = createRunner({ history })

    runner.reserve("d_1", details)

    expect(history.rows[0].kind).toBe(kind)
  })

  test("a playlist row knows how many videos it is waiting on", () => {
    // before anything has run there is no tally to read, and the selection the
    // request carries is the only denominator a queued or interrupted playlist
    // row will ever have
    const history = createHistory()
    const { runner } = createRunner({ history })

    runner.reserve("playlist_1", {
      type: "combined",
      platform: "youtube",
      playlist: true,
      label: "12 videos",
      request: {
        url: "https://youtube.com/playlist?list=PL",
        entries: Array.from({ length: 12 }, (_, index) => ({
          index: index + 1,
          id: `id_${index}`
        }))
      }
    })

    expect(history.rows[0]).toMatchObject({
      kind: "playlist",
      status: "queued",
      items_total: 12
    })
  })

  test("a finished playlist row says what the run really did", async () => {
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()
    handle.resolve(
      playlistResult({
        files: ["/downloads/PL/001 - One [aaa] 1080p.mp4"],
        itemsSaved: 9,
        itemsReused: 1,
        itemsSkipped: 2,
        itemsTotal: 12
      })
    )
    await running

    expect(history.row("playlist_1")).toMatchObject({
      status: "completed",
      items_saved: 9,
      items_reused: 1,
      items_skipped: 2,
      items_total: 12
    })
  })

  test("a playlist that broke partway keeps what it saved", async () => {
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...PLAYLIST, createHandle: () => handle })
    await settle()

    const error = new Error("Download stalled.")
    error.code = ERROR_CODES.NETWORK_ERROR
    Object.assign(error, {
      files: ["/downloads/PL/001 - One [aaa] 1080p.mp4"],
      itemsSaved: 1,
      itemsReused: 0,
      itemsSkipped: 0,
      itemsTotal: 12
    })
    handle.reject(error)
    await running

    // "one of twelve saved" is the difference between a row worth retrying and
    // a row that reads as a total loss
    expect(history.row("playlist_1")).toMatchObject({
      status: "failed",
      items_saved: 1,
      items_total: 12
    })
  })

  test("a run refused before it could count keeps the number it had", async () => {
    // the reservation wrote items_total; a rejection carrying no tally must not
    // blank it, which is what writing the counts as undefined would do
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({
      ...PLAYLIST,
      createHandle: () => handle
    })
    runner.active.get("playlist_1").request = {
      entries: [{ index: 1, id: "a" }, { index: 2, id: "b" }]
    }
    await settle()

    handle.reject(new Error("could not write the records file"))
    await running

    const row = history.row("playlist_1")
    expect(row.status).toBe("failed")
    expect(row.items_total).toBe(2)
    expect(row).not.toHaveProperty("items_saved")
  })

  test("a single video row carries no counts at all", async () => {
    // a row shape widened for everybody is a row shape every consumer has to
    // re-learn: the counts are a playlist's, and only a playlist's
    const history = createHistory()
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()
    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    const row = history.row()
    expect(row).not.toHaveProperty("items_total")
    expect(row).not.toHaveProperty("items_saved")
    expect(row).not.toHaveProperty("files")
  })

  test("a removed queued row still reads as interrupted after a quit", async () => {
    /**
     * the reviewer's scenario, against the real history rather than a stand-in.
     *
     * removing a queued row used to forget it while its reservation lived on:
     * the quit could no longer mark what it could not see, cancelAll settled
     * it, and the row came back saying the user had cancelled a download they
     * had only asked to be rid of.
     */
    const history = new DownloadHistory()
    const { runner } = createRunner({ history, maxConcurrent: 1 })
    const handles = [new FakeHandle(), new FakeHandle(), new FakeHandle()]

    const runs = ["a", "b", "c"].map((id, index) =>
      runner.run({ ...BASE, downloadId: id, createHandle: () => handles[index] })
    )
    await settle()

    await history.remove("b")

    // the quit: mark what is live, then kill it
    await history.interruptLive()
    runner.cancelAll()
    handles[0].reject(
      Object.assign(new Error("cancelled"), { code: ERROR_CODES.CANCELLED })
    )
    await Promise.all(runs)
    await history.flush()

    const statuses = Object.fromEntries(
      history.list().map((row) => [row.download_id, row.status])
    )
    expect(statuses).toEqual({
      a: "interrupted",
      b: "interrupted",
      c: "interrupted"
    })
  })

  test("a history that throws does not fail the download", async () => {
    // the collaborator is injected, and every one of these calls sits where a
    // throw would be caught as the download itself breaking
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const history = {
      upsert: jest.fn(() => {
        throw new Error("no disk")
      })
    }
    const { runner } = createRunner({ history })
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()
    handle.resolve({ filePath: "/downloads/a.mp4" })

    await expect(running).resolves.toMatchObject({ success: true })
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })

  test("a runner with no history runs exactly as it did", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()
    handle.resolve({ filePath: "/downloads/a.mp4" })

    await expect(running).resolves.toMatchObject({ success: true })
    expect(events.at(-1).status).toBe("completed")
  })
})
