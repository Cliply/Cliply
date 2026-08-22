/**
 * the download pipeline's telemetry, driven end to end: a real DownloadRunner
 * settling against fake engine handles, through the real ipc translation, into
 * a recording analytics stub. the payload is what those two build *together* -
 * a hand-written property bag would only prove the test's own arithmetic.
 *
 * the second half replays every bag the first half recorded through the real
 * Analytics, because an allowed property name is only half the contract: each
 * value is checked against a kind, and a failing one is dropped behind a
 * console.warn that production never shows anyone.
 */

jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), removeAllListeners: jest.fn() },
  dialog: { showOpenDialog: jest.fn() },
  app: { getVersion: jest.fn(() => "1.2.3") },
  shell: { openExternal: jest.fn(), openPath: jest.fn() }
}))

const { EventEmitter } = require("events")

const fs = require("fs")

const IPCHandlers = require("../src/main/ipc-handlers")
const { elapsedBucket, speedBucket } = require("../src/main/utils/analytics-helpers")
const { ERROR_CODES } = require("../src/main/services/ytdlp-engine")
const {
  classify,
  ERROR_STAGES,
  ERROR_CATEGORIES
} = require("../src/main/utils/error-taxonomy")

// a stand-in for an engine handle - the same shape download-runner.test.js uses
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

const settle = () => new Promise((resolve) => setImmediate(resolve))

function engineError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createHandlers({ hasValidCookies = true, importCookies } = {}) {
  const captured = []

  const cookieManager = {
    hasValidCookies: jest.fn(() => hasValidCookies),
    importCookies:
      importCookies || jest.fn().mockResolvedValue(true),
    importCookieFile: jest.fn().mockResolvedValue(true)
  }

  const handlers = new IPCHandlers({
    cookieManager,
    ytdlpEngine: {},
    ytdlpUpdater: null,
    settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") },
    analytics: {
      capture: (event, properties) => captured.push({ event, properties })
    }
  })

  return { handlers, captured, cookieManager }
}

/**
 * run one download to a terminal state through the real runner
 * @param {Object} handlers - the IPCHandlers under test
 * @param {Object} options - {type, platform, formatId, trimmed, progress}
 * @param {Function} finish - what to do with the handle to end the download
 * @returns {Promise<Object>} the runner's result
 */
async function runDownload(handlers, options, finish) {
  const handle = new FakeHandle()
  const { progress, ...runOptions } = options

  const running = handlers.runner.run({
    downloadId: "download_1",
    title: "A Video",
    createHandle: () => handle,
    ...runOptions
  })

  await settle()

  if (progress !== undefined) {
    handle.emit("progress", { progress })
  }

  finish(handle)
  return running
}

const VIDEO = {
  type: "combined",
  platform: "youtube",
  formatId: "1080p",
  trimmed: false
}

const AUDIO = {
  type: "audio",
  platform: "youtube",
  formatId: "mp3",
  trimmed: false
}

let warn

beforeEach(() => {
  // every drop and every normalisation warns; the suite asserts on silence, so
  // a stray real warning has to be visible to the assertions and to nobody else
  warn = jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("what the taxonomy does with a download failure", () => {
  it("classifies an antivirus kill out of the raw stderr", () => {
    // the engine reads this off stderr at mapError and puts the answer in
    // error.code - the only place the raw text is ever classified
    const fromText = classify(
      "ffmpeg exited with code 137: Killed",
      ERROR_STAGES.POSTPROCESS
    )
    expect(fromText.category).toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)

    // an explicit code we already own wins over pattern guessing, which is
    // what lets this call site trust what the engine decided
    const fromCode = classify(
      { code: "FFMPEG_ERROR", message: "ffmpeg exited with code 137: Killed" },
      ERROR_STAGES.POSTPROCESS
    )
    expect(fromCode.category).toBe(ERROR_CATEGORIES.FFMPEG_ERROR)
  })

  it("cannot classify the wording the engine hands the runner", () => {
    // this is why trackDownloadEvent classifies the code and not the message.
    // error.message is ERROR_METADATA's user-facing wording - the raw stderr
    // stays behind in error.details - and the wording matches almost none of
    // the patterns it was written about
    const unrecognised = [
      "This video isn't available for download.",
      "YouTube changed something the downloader needs to catch up with.",
      "Network interrupted the download.",
      "Not enough disk space to save this download.",
      "Your antivirus stopped the video processor.",
      "The video processor is missing.",
      "Something went wrong while processing the video."
    ]

    for (const message of unrecognised) {
      expect(classify(message, ERROR_STAGES.DOWNLOAD).category).toBe(
        ERROR_CATEGORIES.UNKNOWN_ERROR
      )
    }
  })
})

describe("download_completed", () => {
  it("reports what was taken", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(captured).toHaveLength(1)
    const [{ event, properties }] = captured
    expect(event).toBe("download_completed")
    expect(properties.platform).toBe("youtube")
    expect(properties.media_type).toBe("video")
    expect(properties.quality).toBe("1080p")
    expect(properties.is_trimmed).toBe(false)
  })

  it("carries a trimmed download's is_trimmed", async () => {
    // the flag lives on the run options, not on the engine result - reading it
    // off the payload the runner sends is the only way it is true here
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, trimmed: true }, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(captured[0].properties.is_trimmed).toBe(true)
  })

  it("says nothing about the title or the file it wrote", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/Users/someone/Movies/My Holiday Video.mp4" })
    )

    const serialised = JSON.stringify(captured[0].properties)
    expect(serialised).not.toContain("My Holiday Video")
    expect(serialised).not.toContain("/Users/someone")
    expect(captured[0].properties).not.toHaveProperty("video_title")
  })
})

describe("how long it took, and how fast", () => {
  const MIB = 1024 * 1024

  /**
   * complete one download against a clock and a file size we control
   * @param {Object} options - {elapsedMs, fileSize}
   * @returns {Promise<Object>} the properties the pipeline built
   */
  async function completeWith({ elapsedMs, fileSize }) {
    const { handlers, captured } = createHandlers()
    let now = 1_600_000_000_000

    // the reservation stamps the start and the completion reads it back, so
    // the clock is the only seam either of these measurements has
    jest.spyOn(Date, "now").mockImplementation(() => now)
    jest.spyOn(fs, "statSync").mockReturnValue({ size: fileSize })

    const handle = new FakeHandle()
    const running = handlers.runner.run({
      downloadId: "download_1",
      ...VIDEO,
      createHandle: () => handle
    })
    await settle()

    now += elapsedMs
    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    return captured[0].properties
  }

  describe("elapsedBucket", () => {
    it("splits where a healthy download stops looking healthy", () => {
      // deliberately not even: under a minute is the line between a download
      // that behaved and one that did not, so the resolution is spent there
      const cases = [
        [0, "<5s"],
        [4999, "<5s"],
        [5000, "5-15s"],
        [14999, "5-15s"],
        [15000, "15-60s"],
        [59999, "15-60s"],
        [60000, "1-5 min"],
        [299999, "1-5 min"],
        [300000, "5-15 min"],
        [899999, "5-15 min"],
        [900000, ">15 min"],
        [86400000, ">15 min"]
      ]

      for (const [elapsedMs, label] of cases) {
        expect(elapsedBucket(elapsedMs)).toBe(label)
      }
    })

    it("says nothing about a duration it cannot have measured", () => {
      // a clock that stepped backwards under us, or a reservation that was
      // already gone. "0s" would read as an instant download
      for (const value of [-1, NaN, Infinity, undefined, null, "20000"]) {
        expect(elapsedBucket(value)).toBeNull()
      }
    })
  })

  describe("speedBucket", () => {
    it("splits around what a working connection looks like", () => {
      const cases = [
        [MIB, 2000, "<1 MBps"],
        [10 * MIB, 10000, "1-3 MBps"],
        [30 * MIB, 10000, "3-10 MBps"],
        [200 * MIB, 10000, "10-30 MBps"],
        [500 * MIB, 10000, ">30 MBps"]
      ]

      for (const [bytes, elapsedMs, label] of cases) {
        expect(speedBucket(bytes, elapsedMs)).toBe(label)
      }
    })

    it("says nothing when either half of the sum is missing", () => {
      // a size of zero is a stat that failed, not an empty file - and a
      // duration of zero divides into it to give an infinite speed
      expect(speedBucket(0, 10000)).toBeNull()
      expect(speedBucket(10 * MIB, 0)).toBeNull()
      expect(speedBucket(10 * MIB, -5)).toBeNull()
      expect(speedBucket(NaN, 10000)).toBeNull()
      expect(speedBucket(10 * MIB, NaN)).toBeNull()
    })
  })

  it("reports both against a real download", async () => {
    const properties = await completeWith({
      elapsedMs: 20000,
      fileSize: 100 * MIB
    })

    expect(properties.elapsed_bucket).toBe("15-60s")
    expect(properties.speed_bucket).toBe("3-10 MBps")
    expect(properties.file_size_mb).toBe(100)
  })

  it("still times a download whose size could not be read", async () => {
    // fileSizeOf() returns 0 for a stat that threw. zero megabytes at zero
    // megabytes a second is a measurement of nothing, so neither is claimed -
    // but the clock still ran, and how long it took is still true
    const properties = await completeWith({ elapsedMs: 20000, fileSize: 0 })

    expect(properties.elapsed_bucket).toBe("15-60s")
    expect(properties).not.toHaveProperty("speed_bucket")
    expect(properties).not.toHaveProperty("file_size_mb")
  })

  it("counts from the moment the user asked, not from the spawn", async () => {
    // the reservation is where the wait starts: the ack, the setImmediate and
    // a repair-on-failure engine update are all time the user spent waiting
    const properties = await completeWith({
      elapsedMs: 400000,
      fileSize: 100 * MIB
    })

    expect(properties.elapsed_bucket).toBe("5-15 min")
  })
})

describe("media_type", () => {
  it("is only ever video or audio", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )
    await runDownload(handlers, AUDIO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp3" })
    )
    await runDownload(handlers, VIDEO, (handle) =>
      handle.reject(engineError(ERROR_CODES.NETWORK_ERROR, "Network interrupted the download."))
    )

    expect(captured).toHaveLength(3)
    for (const { properties } of captured) {
      expect(["video", "audio"]).toContain(properties.media_type)
    }
  })

  it("translates the engine's word for a merged download", async () => {
    // the runner says "combined" - an ffmpeg detail meaning two streams were
    // merged - and never "video". the vocabulary refuses the raw term, so a
    // pass-through would drop the property on every video download there is
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(captured[0].properties.media_type).toBe("video")
  })

  it("leaves the value out for a type it does not know", async () => {
    const { handlers, captured } = createHandlers()

    handlers.trackDownloadEvent("download_completed", {
      type: "playlist",
      platform: "youtube"
    })

    // undefined rather than the word itself: an absent value is skipped in
    // silence, where one outside the vocabulary is dropped with a warning
    expect(captured[0].properties.media_type).toBeUndefined()
  })
})

describe("download_failed", () => {
  it("reports the category the engine read off stderr", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 42.4 }, (handle) =>
      handle.reject(
        engineError(
          ERROR_CODES.BOT_DETECTION,
          "YouTube asked us to confirm you're not a bot."
        )
      )
    )

    const [{ event, properties }] = captured
    expect(event).toBe("download_failed")
    expect(properties.error_category).toBe(ERROR_CATEGORIES.BOT_DETECTION)
    expect(properties.error_stage).toBe(ERROR_STAGES.DOWNLOAD)
    expect(properties.error_message).toBe(
      "YouTube asked us to confirm you're not a bot."
    )
    expect(properties.progress_at_failure).toBe(42)
  })

  it("keeps the detail a wording-only classification would lose", async () => {
    // an antivirus kill and a missing processor both read as UNKNOWN_ERROR
    // from their wording alone. the engine already classified the stderr, so
    // the code is what carries the answer here
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.reject(
        engineError(
          ERROR_CODES.FFMPEG_AV_BLOCKED,
          "Your antivirus stopped the video processor."
        )
      )
    )

    expect(captured[0].properties.error_category).toBe(
      ERROR_CATEGORIES.FFMPEG_AV_BLOCKED
    )
  })

  it("falls back to the patterns when the failure carries no code", async () => {
    // createHandle() throwing, or anything that did not come from the engine,
    // arrives without a code - and then the raw message is all there is
    const { handlers, captured } = createHandlers()

    await handlers.runner.run({
      downloadId: "download_2",
      ...VIDEO,
      createHandle: () => {
        throw new Error("OSError: [Errno 28] No space left on device")
      }
    })

    expect(captured[0].properties.error_category).toBe(
      ERROR_CATEGORIES.DISK_FULL
    )
  })

  it("reports how far it got", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 87.6 }, (handle) =>
      handle.reject(engineError(ERROR_CODES.NETWORK_ERROR, "Network interrupted the download."))
    )

    expect(captured[0].properties.progress_at_failure).toBe(88)
  })
})

describe("download_cancelled", () => {
  it("reports what was being taken and how far it got", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 61.2 }, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    expect(captured).toHaveLength(1)
    const [{ event, properties }] = captured
    expect(event).toBe("download_cancelled")
    expect(properties.platform).toBe("youtube")
    expect(properties.media_type).toBe("video")
    expect(properties.progress_at_cancel).toBe(61)
  })

  it("carries neither quality nor is_trimmed", async () => {
    // the cancel taxonomy lists three properties. sending a fourth would drop
    // it behind a warning production never surfaces, so it is not sent
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, trimmed: true }, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    expect(captured[0].properties).not.toHaveProperty("quality")
    expect(captured[0].properties).not.toHaveProperty("is_trimmed")
  })

  it("fires for a cancel that lands before the engine is spawned", async () => {
    // the reservation window: acknowledged to the renderer, not yet running
    const { handlers, captured } = createHandlers()

    handlers.runner.reserve("download_1", {
      type: "audio",
      platform: "youtube",
      title: "A Video"
    })
    handlers.runner.cancel("download_1")

    await handlers.runner.run({
      downloadId: "download_1",
      ...AUDIO,
      createHandle: () => new FakeHandle()
    })

    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe("download_cancelled")
    expect(captured[0].properties.media_type).toBe("audio")
    expect(captured[0].properties.progress_at_cancel).toBe(0)
  })

  it("does not also report a failure", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    expect(captured.map((entry) => entry.event)).toEqual(["download_cancelled"])
  })
})

describe("cookies_imported", () => {
  it("reports a text import and whether the jar holds youtube cookies", async () => {
    const { handlers, captured } = createHandlers({ hasValidCookies: true })

    await handlers.handleImportCookies(null, { cookies: "# Netscape" })

    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe("cookies_imported")
    expect(captured[0].properties).toEqual({
      success: true,
      has_youtube_cookies: true
    })
  })

  it("reports a jar that imported without any youtube cookies in it", async () => {
    const { handlers, captured } = createHandlers({ hasValidCookies: false })

    await handlers.handleImportCookies(null, { cookies: "# Netscape" })

    expect(captured[0].properties).toEqual({
      success: true,
      has_youtube_cookies: false
    })
  })

  it("reports an import that failed", async () => {
    const { handlers, captured } = createHandlers({
      hasValidCookies: false,
      importCookies: jest.fn().mockRejectedValue(new Error("not a cookie file"))
    })

    const result = await handlers.handleImportCookies(null, {
      cookies: "nonsense"
    })

    expect(result.success).toBe(false)
    expect(captured[0].properties.success).toBe(false)
  })

  it("reports a file import the same way a text import is reported", async () => {
    const { handlers, captured } = createHandlers()
    const { dialog } = require("electron")

    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/Users/someone/cookies.txt"]
    })

    await handlers.handleImportCookieFile(null)

    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe("cookies_imported")
    expect(captured[0].properties.success).toBe(true)
    // the path the user picked is not part of the question being answered
    expect(JSON.stringify(captured[0].properties)).not.toContain("someone")
  })

  it("says nothing when the user cancels the file picker", async () => {
    const { handlers, captured } = createHandlers()
    const { dialog } = require("electron")

    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    await handlers.handleImportCookieFile(null)

    expect(captured).toHaveLength(0)
  })
})

describe("an analytics service that throws", () => {
  /**
   * the exit point guards itself, so a throw out of capture() means the
   * collaborator is not the one we think it is. it must still not reach the
   * caller: trackCookieImport sits *inside* handleImportCookies' try, where a
   * throw is caught as the import failing - the user is told a jar that
   * imported did not, and the failure path then reports the opposite of what
   * happened to analytics as well.
   */
  const HOSTILE_THROWS = [
    ["an Error", () => new Error("posthog exploded")],
    ["null", () => null],
    [
      "an object whose message getter throws",
      () => ({
        get message() {
          throw new Error("not even this")
        }
      })
    ]
  ]

  function throwingHandlers(thrown) {
    return new IPCHandlers({
      cookieManager: {
        hasValidCookies: jest.fn(() => true),
        importCookies: jest.fn().mockResolvedValue(true),
        importCookieFile: jest.fn().mockResolvedValue(true)
      },
      ytdlpEngine: {},
      ytdlpUpdater: null,
      settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") },
      analytics: {
        capture: () => {
          throw thrown()
        }
      }
    })
  }

  it.each(HOSTILE_THROWS)(
    "still reports the cookie import that really happened (%s)",
    async (_name, thrown) => {
      const handlers = throwingHandlers(thrown)

      const result = await handlers.handleImportCookies(null, {
        cookies: "# Netscape"
      })

      expect(result.success).toBe(true)
      expect(result.data.imported).toBe(true)
    }
  )

  it.each(HOSTILE_THROWS)(
    "still finishes the download it was reporting on (%s)",
    async (_name, thrown) => {
      const handlers = throwingHandlers(thrown)

      const result = await runDownload(handlers, VIDEO, (handle) =>
        handle.resolve({ filePath: "/downloads/a.mp4" })
      )

      expect(result.success).toBe(true)
    }
  )
})

describe("describeError", () => {
  // the one guard the three telemetry call sites share. `error.message` is a
  // property read, and a property read can throw - which is why this is a
  // function rather than the same expression written out three times
  const { describeError } = require("../src/main/utils/analytics-helpers")

  it("describes an ordinary failure by its message", () => {
    expect(describeError(new Error("posthog exploded"))).toBe(
      "posthog exploded"
    )
  })

  it("describes what a throw site produced instead of an error", () => {
    expect(describeError("posthog exploded")).toBe("posthog exploded")
    expect(describeError(null)).toBe("null")
    expect(describeError(undefined)).toBe("undefined")
    expect(describeError(42)).toBe("42")
  })

  it("survives a value that refuses to be read", () => {
    const hostile = {
      get message() {
        throw new Error("not even this")
      },
      toString() {
        throw new Error("no string either")
      }
    }

    expect(describeError(hostile)).toBe("unknown error")
    // a symbol is the other half: String() on one throws
    expect(describeError(Symbol("posthog"))).toEqual(expect.any(String))
  })
})

describe("a missing analytics service", () => {
  it("leaves the download pipeline working", async () => {
    const handlers = new IPCHandlers({
      cookieManager: { hasValidCookies: () => true },
      ytdlpEngine: {},
      ytdlpUpdater: null,
      settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") }
    })

    const result = await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(result.success).toBe(true)
  })
})

/**
 * everything above records into a stub, which accepts any bag at all. these
 * replay the exact bags the pipeline builds through the real Analytics: silence
 * on console.warn is the assertion, because the module warns on every drop and
 * every normalisation.
 */
describe("the download payloads survive the real validator", () => {
  const { Analytics: RealAnalytics } = jest.requireActual(
    "../src/main/services/analytics"
  )

  async function replay(captured) {
    const sent = []

    const real = new RealAnalytics({
      settingsStore: {
        isAnalyticsEnabled: async () => true,
        getInstallId: async () => "install-id",
        setAnalyticsEnabled: async () => ({ success: true })
      },
      createClient: () => ({
        capture: (message) => sent.push(message),
        flush: async () => {}
      }),
      forceEnabled: true
    })

    await real.init()
    warn.mockClear()

    for (const { event, properties } of captured) {
      real.capture(event, properties)
    }

    return sent
  }

  it("sends a completion whole", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, trimmed: true }, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    const [message] = await replay(captured)

    expect(message.event).toBe("download_completed")
    expect(message.properties).toMatchObject({
      platform: "youtube",
      media_type: "video",
      quality: "1080p",
      is_trimmed: true
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every bucket label the two measurements can produce", async () => {
    // the bucket grammar takes a leading digit or comparison, an optional
    // range and a unit of at most four letters. every label written by hand is
    // a chance to break one of those, and a broken one is a silent drop
    const MIB = 1024 * 1024
    const { handlers, captured } = createHandlers()

    let now = 1_600_000_000_000
    jest.spyOn(Date, "now").mockImplementation(() => now)

    // a duration from each elapsed bucket, paired with a size that walks the
    // speed buckets across them
    const runs = [
      { elapsedMs: 1000, fileSize: 20 * MIB },
      { elapsedMs: 10000, fileSize: 5 * MIB },
      { elapsedMs: 30000, fileSize: 60 * MIB },
      { elapsedMs: 120000, fileSize: 5000 * MIB },
      { elapsedMs: 600000, fileSize: 10 * MIB },
      { elapsedMs: 1200000, fileSize: 1 * MIB }
    ]

    for (const [index, run] of runs.entries()) {
      jest.spyOn(fs, "statSync").mockReturnValue({ size: run.fileSize })

      const handle = new FakeHandle()
      const running = handlers.runner.run({
        downloadId: `download_${index}`,
        ...VIDEO,
        createHandle: () => handle
      })
      await settle()

      now += run.elapsedMs
      handle.resolve({ filePath: "/downloads/a.mp4" })
      await running
    }

    const sent = await replay(captured)

    expect(sent.map((message) => message.properties.elapsed_bucket)).toEqual([
      "<5s",
      "5-15s",
      "15-60s",
      "1-5 min",
      "5-15 min",
      ">15 min"
    ])
    expect(sent.map((message) => message.properties.speed_bucket)).toEqual([
      "10-30 MBps",
      "<1 MBps",
      "1-3 MBps",
      ">30 MBps",
      "<1 MBps",
      "<1 MBps"
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends a failure whole", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 42.4 }, (handle) =>
      handle.reject(
        engineError(
          ERROR_CODES.BOT_DETECTION,
          "YouTube asked us to confirm you're not a bot."
        )
      )
    )

    const [message] = await replay(captured)

    expect(message.properties).toMatchObject({
      error_category: ERROR_CATEGORIES.BOT_DETECTION,
      error_stage: ERROR_STAGES.DOWNLOAD,
      progress_at_failure: 42
    })
    expect(message.properties.error_message).toBe(
      "YouTube asked us to confirm you're not a bot."
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends nothing identifying when the failure was not the engine's", async () => {
    // the engine's own wording is fixed and safe, which is exactly why a
    // replay built only from it proves nothing. this is the other half: a
    // throw from outside the engine, whose message nobody wrote for telemetry
    const home = require("os").homedir()
    const { handlers, captured } = createHandlers()

    await handlers.runner.run({
      downloadId: "download_9",
      ...VIDEO,
      createHandle: () => {
        throw new Error(
          `ENOENT: no such file or directory, open '${home}/Movies/My Holiday Video.mp4'`
        )
      }
    })

    const [message] = await replay(captured)
    const text = message.properties.error_message

    expect(text).not.toContain(home)
    expect(text).not.toContain("Holiday")
    expect(text).not.toContain(".mp4")
    // still a usable failure, which is the whole reason free text is sent
    expect(text).toContain("no such file or directory")
    expect(message.properties.error_category).toBe(ERROR_CATEGORIES.PATH_ERROR)
  })

  it("sends a cancel whole", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 61.2 }, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    const [message] = await replay(captured)

    expect(message.properties).toMatchObject({
      platform: "youtube",
      media_type: "video",
      progress_at_cancel: 61
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends a cookie import whole", async () => {
    const { handlers, captured } = createHandlers({ hasValidCookies: false })

    await handlers.handleImportCookies(null, { cookies: "# Netscape" })

    const [message] = await replay(captured)

    expect(message.properties).toMatchObject({
      success: true,
      has_youtube_cookies: false
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it("says nothing about a media type it could not name", async () => {
    const { handlers, captured } = createHandlers()

    handlers.trackDownloadEvent("download_completed", {
      type: "playlist",
      platform: "youtube",
      formatId: "1080p"
    })

    const [message] = await replay(captured)

    expect(message.properties).not.toHaveProperty("media_type")
    expect(message.properties.quality).toBe("1080p")
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every quality the download flows can produce", async () => {
    // the format ids the three flows really pass: a picked height for youtube
    // video, an audio mode for youtube audio, and the platform name itself for
    // the flows that never offer a choice
    const { handlers, captured } = createHandlers()

    const flows = [
      { ...VIDEO, formatId: "2160p" },
      { ...VIDEO, formatId: "144p" },
      { ...AUDIO, formatId: "mp3" },
      { ...AUDIO, formatId: "m4a" },
      { ...AUDIO, formatId: "original" },
      { ...VIDEO, platform: "pinterest", formatId: "pinterest" },
      { ...VIDEO, platform: "tiktok", formatId: "tiktok" },
      // the runner's own default, for a flow that passed no format at all
      { ...VIDEO, formatId: "unknown" }
    ]

    for (const flow of flows) {
      await runDownload(handlers, flow, (handle) =>
        handle.resolve({ filePath: "/downloads/a.mp4" })
      )
    }

    const sent = await replay(captured)

    expect(sent).toHaveLength(flows.length)
    for (const message of sent) {
      expect(message.properties.quality).toBeDefined()
      expect(message.properties.platform).not.toBe("unsupported")
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every category the engine can hand the runner", async () => {
    const { handlers, captured } = createHandlers()

    for (const code of Object.values(ERROR_CATEGORIES)) {
      if (code === ERROR_CATEGORIES.CANCELLED) continue

      await runDownload(handlers, VIDEO, (handle) =>
        handle.reject(engineError(code, "something went wrong"))
      )
    }

    const sent = await replay(captured)

    expect(sent.length).toBe(Object.values(ERROR_CATEGORIES).length - 1)
    for (const message of sent) {
      expect(message.properties.error_category).toBeDefined()
    }
    expect(warn).not.toHaveBeenCalled()
  })
})
