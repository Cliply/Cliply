/**
 * turning the PO token escalation on, driven through the real ipc handlers.
 *
 * yt-dlp's advice is to run the default clients until they stop working and
 * only then reach for a token provider, so the whole design rests on one
 * question being answered correctly: what counts as "stopped working". these
 * tests are about that question and nothing else.
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
const { PotInstaller } = require("../src/main/services/pot-installer")

const settle = () => new Promise((resolve) => setImmediate(resolve))

class FakeHandle extends EventEmitter {
  constructor() {
    super()
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    this.promise.catch(() => {})
  }

  cancel() {
    return true
  }
}

function engineError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createHandlers({ infoError, potInstaller } = {}) {
  const engine = {
    potEnabled: false,
    setPotEnabled: jest.fn(function (enabled) {
      this.potEnabled = Boolean(enabled)
    }),
    getPotPaths: jest.fn(() => null),
    getDenoPath: jest.fn(() => "/deno"),
    getInfo: jest.fn(() =>
      infoError ? Promise.reject(infoError) : Promise.resolve({ formats: [] })
    )
  }

  const settingsStore = {
    ensureDownloadPath: jest.fn().mockResolvedValue("/tmp"),
    setPotEnabled: jest.fn().mockResolvedValue({ success: true })
  }

  const handlers = new IPCHandlers({
    cookieManager: { hasValidCookies: jest.fn(() => false) },
    ytdlpEngine: engine,
    ytdlpUpdater: null,
    settingsStore,
    potInstaller
  })

  return { handlers, engine, settingsStore }
}

describe("a refusal turns the escalation on", () => {
  test("the metadata fetch - where a blocked install fails first", async () => {
    const { handlers, engine, settingsStore } = createHandlers({
      infoError: engineError(
        ERROR_CODES.BOT_DETECTION,
        "Sign in to confirm you're not a bot"
      )
    })

    await handlers.handleGetVideoInfo(null, {
      url: "https://youtube.com/watch?v=x",
      platform: "youtube"
    })
    await settle()

    // the live engine, so the very next paste escalates without a restart...
    expect(engine.setPotEnabled).toHaveBeenCalledWith(true)
    // ...and the settings file, so a restart does not have to relearn it
    expect(settingsStore.setPotEnabled).toHaveBeenCalledWith(true)
  })

  test("a download that is refused after the fetch got through", async () => {
    const { handlers, engine, settingsStore } = createHandlers()
    const handle = new FakeHandle()

    handlers.runner.reserve("download_1", { type: "combined", platform: "youtube" })
    handlers.startDownload({
      downloadId: "download_1",
      type: "combined",
      platform: "youtube",
      formatId: "1080p",
      createHandle: () => handle
    })

    await settle()
    handle.reject(
      engineError(ERROR_CODES.BOT_DETECTION, "Sign in to confirm you're not a bot")
    )
    await settle()
    await settle()

    expect(engine.setPotEnabled).toHaveBeenCalledWith(true)
    expect(settingsStore.setPotEnabled).toHaveBeenCalledWith(true)
  })
})

describe("everything else leaves it alone", () => {
  /**
   * the one that matters most, because it is the trigger this design was
   * talked out of. throttling reads as a refusal and is not one: the audit
   * found it landing mostly on installs youtube had never blocked, which makes
   * it a reading of the user's network. escalating on it would charge a token
   * mint per video to people whose only problem was a bad minute of wifi.
   */
  test("rate limiting is not a refusal", async () => {
    const { handlers, engine, settingsStore } = createHandlers({
      infoError: engineError(
        ERROR_CODES.RATE_LIMITED,
        "Unable to download webpage: HTTP Error 429"
      )
    })

    await handlers.handleGetVideoInfo(null, {
      url: "https://youtube.com/watch?v=x",
      platform: "youtube"
    })
    await settle()

    expect(engine.setPotEnabled).not.toHaveBeenCalled()
    expect(settingsStore.setPotEnabled).not.toHaveBeenCalled()
  })

  test("a video that simply is not there is not a refusal", async () => {
    const { handlers, engine } = createHandlers({
      infoError: engineError(
        ERROR_CODES.VIDEO_UNAVAILABLE,
        "Video unavailable"
      )
    })

    await handlers.handleGetVideoInfo(null, {
      url: "https://youtube.com/watch?v=x",
      platform: "youtube"
    })
    await settle()

    expect(engine.setPotEnabled).not.toHaveBeenCalled()
  })

  test("a cancelled download is not a refusal", async () => {
    const { handlers, engine } = createHandlers()
    const handle = new FakeHandle()

    handlers.runner.reserve("download_1", { type: "combined", platform: "youtube" })
    handlers.startDownload({
      downloadId: "download_1",
      type: "combined",
      platform: "youtube",
      formatId: "1080p",
      createHandle: () => handle
    })

    await settle()
    handlers.runner.cancel("download_1")
    await settle()
    await settle()

    expect(engine.setPotEnabled).not.toHaveBeenCalled()
  })
})

/**
 * the sentence appended to the error is a promise, and it is only ours to make
 * when a payload can really arrive. no artifact is published yet, so the
 * shipping answer to "is a fix on its way" is no - and a user told to try again
 * in a minute would retry into the same wall for the life of the install.
 */
describe("what the user is told", () => {
  const refused = () =>
    engineError(ERROR_CODES.BOT_DETECTION, "Sign in to confirm you're not a bot")

  test("no payload to fetch means no fix is promised", async () => {
    const { handlers } = createHandlers({
      infoError: refused(),
      // the real one, with the real empty checksum table
      potInstaller: new PotInstaller({ engine: { getUserDataPath: () => "/tmp" } })
    })

    const response = await handlers.handleGetVideoInfo(null, {
      url: "https://youtube.com/watch?v=x",
      platform: "youtube"
    })
    await settle()

    expect(response.error.message).toBe("Sign in to confirm you're not a bot")
    // the escalation itself still happens - it costs nothing and outlives this
    expect(handlers.engine.setPotEnabled).toHaveBeenCalledWith(true)
  })

  test("a fetch that really starts says so, once", async () => {
    const { handlers } = createHandlers({
      infoError: refused(),
      potInstaller: {
        canInstall: () => true,
        ensureInstalled: jest.fn().mockResolvedValue({ installed: true })
      }
    })

    const response = await handlers.handleGetVideoInfo(null, {
      url: "https://youtube.com/watch?v=x",
      platform: "youtube"
    })
    await settle()

    expect(response.error.message).toContain("Setting up a fix in the background")
  })
})

// the write is fired rather than awaited, so the user is answered at the speed
// of the failure rather than the speed of the disk. that is only safe if a
// rejected write cannot escape as an unhandled rejection
test("a settings write that fails does not break the operation reporting it", async () => {
  const { handlers, engine, settingsStore } = createHandlers({
    infoError: engineError(
      ERROR_CODES.BOT_DETECTION,
      "Sign in to confirm you're not a bot"
    )
  })

  settingsStore.setPotEnabled.mockRejectedValue(new Error("disk is full"))

  const response = await handlers.handleGetVideoInfo(null, {
    url: "https://youtube.com/watch?v=x",
    platform: "youtube"
  })
  await settle()

  expect(response.success).toBe(false)
  // the session still escalates: only the memory of it was lost
  expect(engine.setPotEnabled).toHaveBeenCalledWith(true)
})
