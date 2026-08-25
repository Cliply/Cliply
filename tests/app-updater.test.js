/**
 * unit tests for the app updater - the one that replaces Cliply itself.
 *
 * the thing under test is judgement rather than plumbing: which builds may
 * install an update, and which failures are worth interrupting somebody over.
 * electron-updater is a fake EventEmitter here, because the real one refuses
 * to do anything at all outside a packaged app.
 */

const { EventEmitter } = require("events")

const {
  AppUpdater,
  CHANNELS,
  CHECK_RESULTS
} = require("../src/main/services/app-updater")

class FakeUpdater extends EventEmitter {
  constructor() {
    super()
    this.checkForUpdates = jest.fn().mockResolvedValue({})
    this.downloadUpdate = jest.fn().mockResolvedValue({})
    this.quitAndInstall = jest.fn()
  }
}

const silentLog = { log: jest.fn(), error: jest.fn(), warn: jest.fn() }

function createUpdater(options = {}) {
  const updater = new FakeUpdater()
  const sent = []

  const app = new AppUpdater({
    updater,
    isPackaged: true,
    platform: "win32",
    send: (channel, payload) => sent.push({ channel, payload }),
    log: silentLog,
    ...options
  })

  // the retry backoff is real time, and none of these tests are about waiting
  app.wait = () => Promise.resolve()

  return { app, updater, sent }
}

const channels = (sent) => sent.map((event) => event.channel)
const payloadOf = (sent, channel) =>
  sent.find((event) => event.channel === channel)?.payload

beforeEach(() => {
  jest.clearAllMocks()
  delete global.isUpdating
})

describe("which builds can update themselves", () => {
  const cases = [
    { platform: "win32", isPackaged: true, canUpdate: true, canCheck: true },
    { platform: "linux", isPackaged: true, isAppImage: true, canUpdate: true, canCheck: true },
    // a .deb belongs to the package manager and a tarball to whoever unpacked
    // it - neither is ours to overwrite
    { platform: "linux", isPackaged: true, isAppImage: false, canUpdate: false, canCheck: true },
    // squirrel.mac verifies the running app's signature, and these are unsigned
    { platform: "darwin", isPackaged: true, canUpdate: false, canCheck: true },
    // ...but it can still say an update exists, which is the manual path
    { platform: "win32", isPackaged: false, canUpdate: false, canCheck: false }
  ]

  for (const testCase of cases) {
    const name = `${testCase.platform}${
      testCase.isAppImage ? " (AppImage)" : ""
    }${testCase.isPackaged ? "" : ", unpackaged"}`

    test(`${name}: install=${testCase.canUpdate} check=${testCase.canCheck}`, () => {
      const { app } = createUpdater(testCase)

      expect(app.canUpdate()).toBe(testCase.canUpdate)
      expect(app.canCheck()).toBe(testCase.canCheck)
    })
  }
})

describe("configure", () => {
  test("never lets the app download or install behind the user's back", () => {
    const { app, updater } = createUpdater()
    app.configure()

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  // windows builds are unsigned, so an update that verified the signature
  // would fail at the last step, every time
  test("turns off the signature check the unsigned windows builds cannot pass", () => {
    const { app, updater } = createUpdater()
    app.configure()

    expect(updater.verifyUpdateCodeSignature).toBe(false)
  })

  /**
   * this is the bug the old code had: setupAutoUpdater ran again from the
   * periodic timer, subscribing a second copy of every handler, and the
   * renderer got two of every event from then on
   */
  test("wiring twice does not double every event", () => {
    const { app, updater, sent } = createUpdater()
    app.configure()
    app.configure()

    updater.emit("update-not-available")

    expect(channels(sent)).toEqual([CHANNELS.NOT_AVAILABLE])
  })
})

describe("an update that exists", () => {
  test("windows fetches it and says so", () => {
    const { app, updater, sent } = createUpdater()
    app.configure()

    updater.emit("update-available", { version: "1.2.0" })

    expect(payloadOf(sent, CHANNELS.AVAILABLE)).toMatchObject({
      version: "1.2.0",
      autoDownloading: true,
      requiresManualDownload: false
    })
    expect(updater.downloadUpdate).toHaveBeenCalled()
  })

  test("macos is offered the download instead of taking it", () => {
    const { app, updater, sent } = createUpdater({ platform: "darwin" })
    app.configure()

    updater.emit("update-available", { version: "1.2.0" })

    expect(payloadOf(sent, CHANNELS.AVAILABLE)).toMatchObject({
      version: "1.2.0",
      requiresManualDownload: true,
      autoDownloading: false,
      platform: "darwin"
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  test("a linux install that is not an AppImage is offered it too", () => {
    const { app, updater, sent } = createUpdater({
      platform: "linux",
      isAppImage: false
    })
    app.configure()

    updater.emit("update-available", { version: "1.2.0" })

    expect(payloadOf(sent, CHANNELS.AVAILABLE)).toMatchObject({
      requiresManualDownload: true
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  test("a download that lands may be installed on quit", () => {
    const { app, updater, sent } = createUpdater()
    app.configure()

    updater.emit("update-downloaded", { version: "1.2.0" })

    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(payloadOf(sent, CHANNELS.DOWNLOADED)).toEqual({
      version: "1.2.0",
      autoInstallOnQuit: true
    })
  })

  test("progress is rounded before the renderer ever sees it", () => {
    const { app, updater, sent } = createUpdater()
    app.configure()

    updater.emit("download-progress", {
      percent: 42.7,
      bytesPerSecond: 1024,
      total: 100,
      transferred: 43
    })

    expect(payloadOf(sent, CHANNELS.PROGRESS)).toEqual({
      percent: 43,
      bytesPerSecond: 1024,
      total: 100,
      transferred: 43
    })
  })
})

/**
 * the half of this file that matters most.
 *
 * an install running between a tag and its build finishing gets a 404 for its
 * channel file, and so does every platform we have not published for. the old
 * code turned each of those into an error toast, on a check nobody asked for,
 * about a release schedule the user has no part in.
 */
describe("failures nobody asked about", () => {
  const noFeedErrors = [
    Object.assign(new Error("boom"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"
    }),
    Object.assign(new Error("boom"), { statusCode: 404 }),
    new Error("HttpError: 404 Not Found"),
    new Error("Cannot find channel file latest-linux.yml")
  ]

  for (const [index, error] of noFeedErrors.entries()) {
    test(`a missing feed is silent on a background check (${index})`, () => {
      const { app, updater, sent } = createUpdater()
      app.configure()

      updater.emit("error", error)

      expect(sent).toEqual([])
    })
  }

  test("a missing feed answers a manual check with 'up to date'", async () => {
    const { app, updater, sent } = createUpdater()
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit("error", Object.assign(new Error("404"), { statusCode: 404 }))
      return Promise.resolve({})
    })

    await app.check({ manual: true })

    // and never an error dialog: there is no newer version, which is the same
    // answer as being current
    expect(channels(sent)).toEqual([CHANNELS.NOT_AVAILABLE])
  })

  test("a real failure is still silent in the background", () => {
    const { app, updater, sent } = createUpdater()
    app.configure()

    updater.emit("error", new Error("ECONNRESET"))

    expect(sent).toEqual([])
  })

  test("a real failure on a manual check reaches the user", async () => {
    const { app, updater, sent } = createUpdater()
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit("error", new Error("ECONNRESET"))
      return Promise.resolve({})
    })

    await app.check({ manual: true })

    expect(payloadOf(sent, CHANNELS.ERROR)).toEqual({ message: "ECONNRESET" })
  })

  // the flag is per-check, and a background check running alongside a manual
  // one must not answer for it
  test("the manual flag does not leak into the next background check", async () => {
    const { app, updater, sent } = createUpdater()
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit("error", new Error("ECONNRESET"))
      return Promise.resolve({})
    })

    await app.check({ manual: true })
    sent.length = 0

    await app.check()

    expect(sent).toEqual([])
  })

  test("a background check running under a manual one does not silence it", async () => {
    const { app, updater, sent } = createUpdater()
    app.configure()
    app.checkIsManual = true

    await app.check()
    updater.emit("error", new Error("ECONNRESET"))

    expect(payloadOf(sent, CHANNELS.ERROR)).toEqual({ message: "ECONNRESET" })
  })
})

describe("check", () => {
  test("an unpackaged build never asks", async () => {
    const { app, updater } = createUpdater({ isPackaged: false })

    const result = await app.check({ manual: true })

    expect(result.status).toBe(CHECK_RESULTS.UNSUPPORTED)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  test("a check that works reports that one is under way", async () => {
    const { app, updater } = createUpdater()

    expect((await app.check()).status).toBe(CHECK_RESULTS.CHECKING)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  test("a blip is retried", async () => {
    const { app, updater } = createUpdater()
    updater.checkForUpdates
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({})

    expect((await app.check()).status).toBe(CHECK_RESULTS.CHECKING)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  // a feed that is not published will not be published by attempt three
  test("a missing feed is not retried", async () => {
    const { app, updater } = createUpdater()
    updater.checkForUpdates.mockRejectedValue(
      Object.assign(new Error("404"), { statusCode: 404 })
    )

    const result = await app.check()

    expect(result.status).toBe(CHECK_RESULTS.NO_FEED)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  test("a check that keeps failing gives up and says so", async () => {
    const { app, updater } = createUpdater()
    updater.checkForUpdates.mockRejectedValue(new Error("ECONNRESET"))

    const result = await app.check()

    expect(result.status).toBe(CHECK_RESULTS.FAILED)
    expect(result.message).toBe("ECONNRESET")
    expect(updater.checkForUpdates.mock.calls.length).toBeGreaterThan(1)
  })
})

describe("download and install", () => {
  test("a build that cannot install one does not fetch it either", async () => {
    const { app, updater } = createUpdater({ platform: "darwin" })

    expect(await app.download()).toBe(false)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  test("install hands over and marks the quit as an update", () => {
    const { app, updater } = createUpdater()

    expect(app.install()).toBe(true)
    expect(global.isUpdating).toBe(true)

    // the ipc reply has to leave before the process starts going away
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    return new Promise((resolve) => {
      setImmediate(() => {
        expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
        resolve()
      })
    })
  })

  test("a build that cannot install refuses rather than quitting", () => {
    const { app, updater } = createUpdater({ platform: "darwin" })

    expect(app.install()).toBe(false)
    expect(global.isUpdating).toBeUndefined()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe("the background schedule", () => {
  test("an unpackaged build schedules nothing at all", () => {
    const { app } = createUpdater({ isPackaged: false })

    app.start()

    expect(app.periodicTimer).toBeNull()
    expect(app.firstCheckTimer).toBeNull()

    app.stop()
  })

  test("timers are armed, and stop clears both of them", () => {
    const { app } = createUpdater()

    app.start()
    expect(app.firstCheckTimer).not.toBeNull()
    expect(app.periodicTimer).not.toBeNull()

    app.stop()
    expect(app.firstCheckTimer).toBeNull()
    expect(app.periodicTimer).toBeNull()
  })

  // the old setInterval was neither cleared nor unref'd, so a check could fire
  // into an app whose window was already gone
  test("neither timer can hold the process open", () => {
    const { app } = createUpdater()
    const unrefs = []

    const realTimeout = global.setTimeout
    const realInterval = global.setInterval
    const spy = (real) => (fn, ms) => {
      const timer = real(fn, ms)
      const originalUnref = timer.unref?.bind(timer)
      timer.unref = () => {
        unrefs.push(true)
        return originalUnref ? originalUnref() : timer
      }
      return timer
    }

    global.setTimeout = spy(realTimeout)
    global.setInterval = spy(realInterval)

    try {
      app.start()
      expect(unrefs).toHaveLength(2)
    } finally {
      app.stop()
      global.setTimeout = realTimeout
      global.setInterval = realInterval
    }
  })
})
