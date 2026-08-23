// unit tests for the download runner: progress forwarding, terminal events,
// cancellation and the repair-on-failure retry

const { EventEmitter } = require("events")

const { DownloadRunner } = require("../src/main/services/download-runner")
const { ERROR_CODES } = require("../src/main/services/ytdlp-engine")

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

function createRunner({ updater = null } = {}) {
  const events = []
  const tracked = []

  const runner = new DownloadRunner({
    engine: {},
    updater,
    sendEvent: (downloadId, payload) => events.push({ downloadId, ...payload }),
    trackEvent: (name, payload) => tracked.push({ name, ...payload })
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

describe("progress forwarding", () => {
  test("engine progress becomes a download:progress event", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    handle.emit("progress", { progress: 42.5, speed: "3.79MiB/s", eta: "00:35" })
    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    expect(events[0]).toEqual({
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

    expect(events[0].progress).toBeUndefined()
    expect(events[0].indeterminate).toBe(true)
  })
})

describe("terminal events", () => {
  test("completion carries the filename the renderer shows", async () => {
    const { runner, events } = createRunner()
    const handle = new FakeHandle()

    const running = runner.run({ ...BASE, createHandle: () => handle })
    await settle()

    handle.resolve({ filePath: "/downloads/My Video_720p_123.mp4" })
    const result = await running

    const terminal = events[events.length - 1]
    expect(terminal.status).toBe("completed")
    expect(terminal.progress).toBe(100)
    expect(terminal.filename).toBe("My Video_720p_123.mp4")
    expect(result.success).toBe(true)
    expect(result.download_id).toBe("combined_1")
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

    expect(events.filter((e) => e.downloadId === "id-a").map((e) => e.progress)).toEqual([10])
    expect(events.filter((e) => e.downloadId === "id-b").map((e) => e.progress)).toEqual([90])

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
