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

const IPCHandlers = require("../src/main/ipc-handlers")
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
  it("reports what was taken and how big it was", async () => {
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
    expect(properties.file_size_mb).toBe(0)
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
      is_trimmed: true,
      file_size_mb: 0
    })
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
