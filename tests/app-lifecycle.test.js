/**
 * index.js is wiring, so these tests drive the real class against a mocked
 * electron and mocked services. what is under test is the order things happen
 * in and what is handed to what - never the services themselves, which have
 * their own suites.
 *
 * the module self-starts at require time, so the single instance lock is mocked
 * to refuse: the module then quits instead of constructing an app, and the
 * class it exports is ours to instantiate per test.
 */

const mockWindow = {
  on: jest.fn(),
  once: jest.fn(),
  show: jest.fn(),
  isDestroyed: jest.fn(() => false),
  loadURL: jest.fn(),
  loadFile: jest.fn(() => Promise.resolve()),
  webContents: { send: jest.fn(), openDevTools: jest.fn() }
}

const mockElectron = {
  app: {
    setName: jest.fn(),
    setVersion: jest.fn(),
    getName: jest.fn(() => "Cliply"),
    getLocale: jest.fn(() => "en-US"),
    whenReady: jest.fn(() => Promise.resolve()),
    on: jest.fn(),
    quit: jest.fn(),
    exit: jest.fn(),
    requestSingleInstanceLock: jest.fn(() => false)
  },
  BrowserWindow: Object.assign(
    jest.fn(() => mockWindow),
    { getAllWindows: jest.fn(() => []) }
  ),
  Menu: {
    buildFromTemplate: jest.fn((template) => template),
    setApplicationMenu: jest.fn()
  },
  shell: { openExternal: jest.fn() },
  dialog: { showMessageBox: jest.fn(), showErrorBox: jest.fn() }
}

let mockAnalytics = null
let mockSettingsStore = null
let mockIpcHandlers = null
let mockUpdater = null
let mockEngine = null

// what IPCHandlers was handed at the moment it was constructed - a snapshot,
// because the services object keeps being filled in afterwards
let servicesAtIpcConstruction = null

jest.mock("electron", () => mockElectron)
jest.mock("electron-updater", () => ({ autoUpdater: { on: jest.fn() } }))

jest.mock("../src/main/services/cookie-manager", () =>
  jest.fn(() => ({ initialize: jest.fn().mockResolvedValue(undefined) }))
)

jest.mock("../src/main/services/ytdlp-engine", () => ({
  // the real redaction, not a stand-in: analytics scrubs its one free-text
  // property through this module, and a requireActual on analytics still
  // resolves *its* dependencies through this mock. left out, every event
  // carrying an error_message dies in capture()'s catch instead of being
  // validated - which reads as a passing replay that sent nothing at all
  redactLogLine: jest.requireActual("../src/main/services/ytdlp-engine")
    .redactLogLine,
  YtdlpEngine: jest.fn(() => mockEngine)
}))

jest.mock("../src/main/services/ytdlp-updater", () => ({
  YtdlpUpdater: jest.fn(() => mockUpdater)
}))

jest.mock("../src/main/ipc-handlers", () =>
  jest.fn((services) => {
    servicesAtIpcConstruction = { ...services }
    return mockIpcHandlers
  })
)

jest.mock("../src/main/services/settings-store", () => ({
  SettingsStore: jest.fn(() => mockSettingsStore)
}))

jest.mock("../src/main/services/analytics", () => ({
  Analytics: jest.fn(() => mockAnalytics)
}))

jest.mock("../src/main/utils/analytics-helpers", () => ({
  // the real one: it is the shared guard the never-throw promise rests on, in
  // this module and in the exit point this module's events go through. a stub
  // here would leave both of them calling undefined, and the replays below
  // would pass having sent nothing
  describeError: jest.requireActual("../src/main/utils/analytics-helpers")
    .describeError,
  getAppVersion: jest.fn(() => "1.2.3"),
  isFirstLaunch: jest.fn(() => false),
  extractQuality: jest.fn()
}))

const CliplyApp = require("../src/main/index")
const { Analytics } = require("../src/main/services/analytics")
const { SettingsStore } = require("../src/main/services/settings-store")
const IPCHandlers = require("../src/main/ipc-handlers")
const helpers = require("../src/main/utils/analytics-helpers")

// the promise chains hang several thens deep; one macrotask drains them all
const settle = () => new Promise((resolve) => setImmediate(resolve))

function toolsSubmenu() {
  const [template] = mockElectron.Menu.buildFromTemplate.mock.calls.at(-1)
  return template.find((entry) => entry.label === "Tools").submenu
}

function analyticsMenuItem() {
  return toolsSubmenu().find(
    // not "anonymous": the data is pseudonymous - a persistent install id and
    // a derived city ride on every event - and PRIVACY.md says so in those
    // words. the label is the more-read of the two, so it is the one that has
    // to be right
    (entry) => entry.label === "Send usage data"
  )
}

// found by the one thing that is not its label - a test that located this item
// by the text it is asserting on would only be proving itself
function engineVersionMenuItem() {
  return toolsSubmenu().find((entry) => entry.enabled === false)
}

// what the Tools menu actually reads, top to bottom
function toolsMenuShape() {
  return toolsSubmenu().map((entry) => entry.label || `<${entry.type}>`)
}

let app

beforeEach(() => {
  jest.clearAllMocks()

  servicesAtIpcConstruction = null

  mockAnalytics = {
    init: jest.fn().mockResolvedValue(undefined),
    capture: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    setEnabled: jest.fn().mockResolvedValue({ success: true }),
    setEngineVersion: jest.fn(),
    isEnabled: jest.fn(() => true)
  }

  mockSettingsStore = {
    readAll: jest.fn().mockResolvedValue({}),
    writeSettings: jest.fn().mockResolvedValue(undefined),
    setAnalyticsEnabled: jest.fn().mockResolvedValue({ success: true }),
    isAnalyticsEnabled: jest.fn().mockResolvedValue(true),
    getInstallId: jest.fn().mockResolvedValue("install-id")
  }

  mockIpcHandlers = {
    setMainWindow: jest.fn(),
    cleanup: jest.fn()
  }

  // a stand-in that keeps the one part of the real contract this suite leans
  // on: a falsy version is not an answer, so it never erases one we had.
  // ytdlp-lifecycle covers the engine's own behaviour
  let knownVersion = null

  mockEngine = {
    getBinaryPath: jest.fn(() => "/tmp/yt-dlp"),
    cancelAll: jest.fn(() => 0),
    rememberVersion: jest.fn((version) => {
      if (version) knownVersion = version
    }),
    getKnownVersion: jest.fn(() => knownVersion)
  }

  mockUpdater = {
    seed: jest.fn().mockResolvedValue({
      seeded: false,
      reason: "up-to-date",
      version: "2026.08.19"
    }),
    checkForUpdate: jest.fn().mockResolvedValue({
      started: true,
      updated: false,
      reason: "up-to-date"
    })
  }

  helpers.getAppVersion.mockReturnValue("1.2.3")
  helpers.isFirstLaunch.mockReturnValue(false)

  app = new CliplyApp()
  app.ipcHandlers = mockIpcHandlers
  app.services.analytics = mockAnalytics
  app.services.settingsStore = mockSettingsStore
  app.services.ytdlpEngine = mockEngine
})

describe("the aptabase bootstrap is gone", () => {
  it("leaves no trackEvent on the global", () => {
    // the old block installed one at require time whether or not the sdk
    // loaded. nothing may reach telemetry except through the analytics service
    expect(global.trackEvent).toBeUndefined()
  })
})

describe("initializeServices", () => {
  it("builds one settings store and hands it to analytics", async () => {
    app.services = {}
    await app.initializeServices()

    expect(SettingsStore).toHaveBeenCalledTimes(1)
    expect(app.services.settingsStore).toBe(mockSettingsStore)
    expect(Analytics).toHaveBeenCalledWith({ settingsStore: mockSettingsStore })
    expect(app.services.analytics).toBe(mockAnalytics)
  })

  it("initialises analytics before anything can capture through it", async () => {
    app.services = {}
    await app.initializeServices()

    expect(mockAnalytics.init).toHaveBeenCalledTimes(1)
  })

  it("gives ipc handlers the same store, not one of their own", async () => {
    app.services = {}
    await app.initializeServices()

    expect(IPCHandlers).toHaveBeenCalledTimes(1)
    // the store must already be on the services bag when ipc-handlers reads it:
    // it falls back to constructing its own, and two stores mean two install
    // id mints racing the same file
    expect(servicesAtIpcConstruction.settingsStore).toBe(mockSettingsStore)
    expect(servicesAtIpcConstruction.analytics).toBe(mockAnalytics)
  })
})

describe("initialize", () => {
  it("has services up before the ready handlers are registered", async () => {
    const order = []

    jest
      .spyOn(CliplyApp.prototype, "initializeServices")
      .mockImplementation(async () => order.push("services"))
    jest
      .spyOn(CliplyApp.prototype, "setupAppEvents")
      .mockImplementation(() => order.push("events"))
    jest
      .spyOn(CliplyApp.prototype, "createMenu")
      .mockImplementation(() => order.push("menu"))
    jest
      .spyOn(CliplyApp.prototype, "setupAutoUpdater")
      .mockImplementation(() => {})
    jest
      .spyOn(CliplyApp.prototype, "checkSupportedArchitecture")
      .mockImplementation(() => {})

    await new CliplyApp().initialize()

    // analytics is constructed in initializeServices, and app_launched fires
    // from a whenReady handler registered in setupAppEvents. reversed, the
    // event would fire into an undefined service
    expect(order).toEqual(["services", "events", "menu"])

    jest.restoreAllMocks()
  })
})

describe("app_launched", () => {
  async function launch() {
    app.setupAppEvents()
    await settle()
  }

  it("fires once the app is ready", async () => {
    helpers.isFirstLaunch.mockReturnValue(true)
    await launch()

    expect(mockAnalytics.capture).toHaveBeenCalledTimes(1)
    const [event, properties] = mockAnalytics.capture.mock.calls[0]
    expect(event).toBe("app_launched")
    expect(properties.is_first_launch).toBe(true)
  })

  it("reports the stored version as the previous one", async () => {
    mockSettingsStore.readAll.mockResolvedValue({ last_version: "1.2.2" })
    await launch()

    const [, properties] = mockAnalytics.capture.mock.calls[0]
    expect(properties.previous_version).toBe("1.2.2")
  })

  it("omits previous_version rather than sending a null", async () => {
    await launch()

    const [, properties] = mockAnalytics.capture.mock.calls[0]
    // null and undefined are both skipped by the service, so this is about
    // saying the true thing: a first launch has no previous version
    expect(Object.keys(properties)).not.toContain("previous_version")
  })

  it("records the running version for the next launch to read", async () => {
    mockSettingsStore.readAll.mockResolvedValue({ last_version: "1.2.2" })
    await launch()

    expect(mockSettingsStore.writeSettings).toHaveBeenCalledWith({
      last_version: "1.2.3"
    })
  })

  it("reads the stored version before overwriting it", async () => {
    mockSettingsStore.readAll.mockResolvedValue({ last_version: "1.2.2" })
    await launch()

    const capturedAt = mockAnalytics.capture.mock.invocationCallOrder[0]
    const writtenAt = mockSettingsStore.writeSettings.mock.invocationCallOrder[0]
    expect(capturedAt).toBeLessThan(writtenAt)
  })

  it("does not persist an unknown version", async () => {
    // getAppVersion falls back to "unknown" when package.json cannot be read.
    // stored, the *next* launch reads it back as previous_version, where it
    // fails the version grammar and is dropped - one bad launch spoiling the
    // one after it. absence is handled silently, so absence is what it gets
    helpers.getAppVersion.mockReturnValue("unknown")
    await launch()

    expect(mockSettingsStore.writeSettings).not.toHaveBeenCalled()
    expect(mockAnalytics.capture).toHaveBeenCalledTimes(1)
  })

  it("still launches when the settings write fails", async () => {
    mockSettingsStore.writeSettings.mockRejectedValue(new Error("read-only"))
    await launch()

    expect(mockWindow.show).not.toThrow()
    expect(mockElectron.BrowserWindow).toHaveBeenCalledTimes(1)
  })

  it("still creates the window when the settings read fails", async () => {
    mockSettingsStore.readAll.mockRejectedValue(new Error("gone"))
    await launch()

    expect(mockElectron.BrowserWindow).toHaveBeenCalledTimes(1)
  })
})

/**
 * everything above drives a mocked analytics service, which will accept any
 * property bag at all. these replay the bag the launch actually builds through
 * the real one, because an allowed property name is only half the contract -
 * previous_version has a grammar, and a value that fails it is dropped behind a
 * console.warn production never shows anyone.
 */
describe("the launch payload survives the real validator", () => {
  const { Analytics: RealAnalytics } = jest.requireActual(
    "../src/main/services/analytics"
  )

  async function replayThroughRealAnalytics(stored) {
    mockSettingsStore.readAll.mockResolvedValue(stored)
    app.setupAppEvents()
    await settle()

    const [event, properties] = mockAnalytics.capture.mock.calls[0]
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
    real.capture(event, properties)

    return sent
  }

  let warn

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it("sends an upgrade's previous version without dropping anything", async () => {
    const [message] = await replayThroughRealAnalytics({
      last_version: "1.2.2"
    })

    expect(message.event).toBe("app_launched")
    expect(message.properties.previous_version).toBe("1.2.2")
    expect(message.properties.is_first_launch).toBe(false)
    // every drop and every normalisation warns, so silence is the assertion
    expect(warn).not.toHaveBeenCalled()
  })

  it("says nothing at all about a first launch's missing version", async () => {
    const [message] = await replayThroughRealAnalytics({})

    expect(message.properties).not.toHaveProperty("previous_version")
    expect(warn).not.toHaveBeenCalled()
  })

  it("would drop an unknown that reached the store some other way", async () => {
    // the write guard keeps this out, so it can only arrive from a hand-edited
    // settings file. pinned so the cost of that guard slipping stays visible:
    // the launch still sends, minus its previous_version
    const [message] = await replayThroughRealAnalytics({
      last_version: "unknown"
    })

    expect(message.properties).not.toHaveProperty("previous_version")
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("expected version")
    )
  })
})

describe("seeding the engine", () => {
  async function seedWith(result) {
    mockUpdater.seed.mockResolvedValue(result)
    app.services = {}
    await app.initializeServices()
  }

  function captures(event) {
    return mockAnalytics.capture.mock.calls.filter(([name]) => name === event)
  }

  it("stamps the engine version onto everything sent afterwards", async () => {
    await seedWith({ seeded: false, reason: "up-to-date", version: "2026.08.19" })

    // the engine is probed once per run, so this is the only chance to say
    expect(mockAnalytics.setEngineVersion).toHaveBeenCalledWith("2026.08.19")
  })

  it("gives the version to the engine, not only to analytics", async () => {
    await seedWith({ seeded: false, reason: "up-to-date", version: "2026.08.19" })

    // the menu and the issue report both name the engine, and the user can
    // switch telemetry off - so the app cannot keep its only copy in there
    expect(mockEngine.rememberVersion).toHaveBeenCalledWith("2026.08.19")
    expect(app.services.ytdlpEngine.getKnownVersion()).toBe("2026.08.19")
  })

  it("reports a seed that actually installed an engine", async () => {
    await seedWith({ seeded: true, reason: "missing", version: "2026.08.19" })

    expect(captures("engine_seeded")).toHaveLength(1)
    const [, properties] = captures("engine_seeded")[0]
    expect(properties.reason).toBe("missing")
    expect(properties.engine_version).toBe("2026.08.19")
  })

  it("says nothing when there was nothing to install", async () => {
    await seedWith({ seeded: false, reason: "up-to-date", version: "2026.08.19" })

    expect(captures("engine_seeded")).toHaveLength(0)
  })

  it("stamps no version when the seed could not say what runs", async () => {
    // a refused seed reports {seeded, reason} and nothing else. a probe that
    // never happened must not erase a version some other call established
    await seedWith({ seeded: false, reason: "busy" })

    expect(mockAnalytics.setEngineVersion).toHaveBeenCalledWith(undefined)
    expect(captures("engine_seeded")).toHaveLength(0)
  })
})

describe("the deferred engine update check", () => {
  let log

  beforeEach(() => {
    log = jest.spyOn(console, "log").mockImplementation(() => {})
    app.services.ytdlpUpdater = mockUpdater
  })

  afterEach(() => {
    log.mockRestore()
  })

  async function check(result) {
    mockUpdater.checkForUpdate.mockResolvedValue(result)
    await app.checkForEngineUpdate()
  }

  function captured() {
    return mockAnalytics.capture.mock.calls
  }

  it("reports an update that landed", async () => {
    await check({
      started: true,
      updated: true,
      from: "2026.08.19",
      to: "2026.09.01",
      reason: "completed"
    })

    expect(captured()).toHaveLength(1)
    const [event, properties] = captured()[0]
    expect(event).toBe("engine_updated")
    expect(properties.from_version).toBe("2026.08.19")
    expect(properties.to_version).toBe("2026.09.01")
  })

  it("moves later events onto the engine that is now running", async () => {
    await check({
      started: true,
      updated: true,
      from: "2026.08.19",
      to: "2026.09.01",
      reason: "completed"
    })

    expect(mockAnalytics.setEngineVersion).toHaveBeenCalledWith("2026.09.01")
  })

  it("omits a from_version the updater could not probe", async () => {
    await check({
      started: true,
      updated: true,
      from: null,
      to: "2026.09.01",
      reason: "completed"
    })

    const [, properties] = captured()[0]
    expect(Object.keys(properties)).not.toContain("from_version")
  })

  it("says nothing when the engine was already current", async () => {
    await check({ started: true, updated: false, reason: "up-to-date" })

    expect(captured()).toHaveLength(0)
  })

  it("says nothing when a completed swap changed no version", async () => {
    // "completed" with updated:false means the swap worked and the engine is
    // current. nothing failed, so there is nothing for a failure event to say
    await check({
      started: true,
      updated: false,
      from: "2026.09.01",
      to: "2026.09.01",
      reason: "completed"
    })

    expect(captured()).toHaveLength(0)
  })

  it("reports a check that failed, with the reason and the message", async () => {
    await check({
      started: true,
      updated: false,
      reason: "check-failed",
      error: "could not read the latest yt-dlp release tag"
    })

    const [event, properties] = captured()[0]
    expect(event).toBe("engine_update_failed")
    expect(properties.update_reason).toBe("check-failed")
    expect(properties.error_message).toBe(
      "could not read the latest yt-dlp release tag"
    )
  })

  it("omits the message when the failure carried none", async () => {
    await check({ started: true, updated: false, reason: "checksum-missing" })

    const [, properties] = captured()[0]
    expect(Object.keys(properties)).not.toContain("error_message")
  })

  it("reports a check that never ran because a download held the gate", async () => {
    // the update did not happen and this is why - which is the whole question
    await check({ started: false, reason: "busy" })

    const [event, properties] = captured()[0]
    expect(event).toBe("engine_update_failed")
    expect(properties.update_reason).toBe("busy")
  })

  it("reports a check that rejected instead of reporting", async () => {
    // runUpdateLocked can throw - a probe that rejects, a rename that does -
    // and nothing else in the pipeline says this install cannot even ask
    // whether its engine is stale
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockUpdater.checkForUpdate.mockRejectedValue(new Error("spawn EACCES"))

    await expect(app.checkForEngineUpdate()).resolves.toBeUndefined()

    expect(captured()).toHaveLength(1)
    const [event, properties] = captured()[0]
    expect(event).toBe("engine_update_failed")
    // not "check-failed": that one is the tag lookup failing and returning
    // normally. a rejection is our own code breaking, and merging the two
    // would hide a bug inside a common network blip
    expect(properties.update_reason).toBe("check-rejected")
    expect(properties.error_message).toBe("spawn EACCES")

    warn.mockRestore()
  })

  it("still resolves when the rejection carries no message", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockUpdater.checkForUpdate.mockRejectedValue(null)

    await expect(app.checkForEngineUpdate()).resolves.toBeUndefined()

    const [, properties] = captured()[0]
    expect(properties.update_reason).toBe("check-rejected")
    expect(Object.keys(properties)).not.toContain("error_message")

    warn.mockRestore()
  })

  it("still resolves when the rejection refuses to be read", async () => {
    // reading `.message` is a property access, and a getter can throw. this
    // one throws inside the catch that exists to handle it, so the failure the
    // event was about becomes an unhandled rejection instead of an event
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockUpdater.checkForUpdate.mockRejectedValue({
      get message() {
        throw new Error("not even this")
      }
    })

    await expect(app.checkForEngineUpdate()).resolves.toBeUndefined()

    const [, properties] = captured()[0]
    expect(properties.update_reason).toBe("check-rejected")
    expect(properties.error_message).toEqual(expect.any(String))

    warn.mockRestore()
  })
})

/**
 * as with the launch payload: the tests above drive a mocked service, which
 * accepts anything. these replay the bags the engine lifecycle really builds
 * through the real one, where update_reason is a vocabulary that has to have
 * been told about each value before it will send it.
 */
describe("the engine payloads survive the real validator", () => {
  const { Analytics: RealAnalytics } = jest.requireActual(
    "../src/main/services/analytics"
  )

  let warn
  let log

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    log = jest.spyOn(console, "log").mockImplementation(() => {})
    app.services.ytdlpUpdater = mockUpdater
  })

  afterEach(() => {
    warn.mockRestore()
    log.mockRestore()
  })

  async function replay() {
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

    for (const [event, properties] of mockAnalytics.capture.mock.calls) {
      real.capture(event, properties)
    }

    return sent
  }

  it("sends a seed whole", async () => {
    mockUpdater.seed.mockResolvedValue({
      seeded: true,
      reason: "corrupt",
      version: "2026.08.19"
    })
    app.services = {}
    await app.initializeServices()

    const [message] = await replay()

    expect(message.event).toBe("engine_seeded")
    expect(message.properties.reason).toBe("corrupt")
    expect(message.properties.engine_version).toBe("2026.08.19")
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every reason a seed can install for", async () => {
    // installDirectory() takes its reason positionally, so these three are the
    // ones a grep for `reason:` in the updater never finds
    for (const reason of ["missing", "corrupt", "bundled-newer"]) {
      mockAnalytics.capture.mockClear()
      mockUpdater.seed.mockResolvedValue({
        seeded: true,
        reason,
        version: "2026.08.19"
      })
      app.services = {}
      await app.initializeServices()

      const [message] = await replay()
      expect(message.properties.reason).toBe(reason)
    }

    expect(warn).not.toHaveBeenCalled()
  })

  it("scrubs the url out of what the updater said went wrong", async () => {
    // the updater's own http messages carry github urls verbatim - "HTTP 404
    // for <url>", "request timed out: <url>" - so this is the live path that
    // sends a url into a free-text property, not a hypothetical one
    mockUpdater.checkForUpdate.mockResolvedValue({
      started: true,
      updated: false,
      reason: "check-failed",
      error:
        "could not read the latest yt-dlp release tag (https://github.com/yt-dlp/yt-dlp/releases/latest)"
    })
    await app.checkForEngineUpdate()

    const [message] = await replay()

    expect(message.properties.error_message).not.toContain("github.com")
    expect(message.properties.error_message).toContain("[url]")
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends an update whole", async () => {
    mockUpdater.checkForUpdate.mockResolvedValue({
      started: true,
      updated: true,
      from: "2026.08.19",
      to: "2026.09.01",
      reason: "completed"
    })
    await app.checkForEngineUpdate()

    const [message] = await replay()

    expect(message.event).toBe("engine_updated")
    expect(message.properties.from_version).toBe("2026.08.19")
    expect(message.properties.to_version).toBe("2026.09.01")
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every reason an update can fail for", async () => {
    // every reason checkForUpdate() can return except the two that mean the
    // engine is current. each has to be in update_reason's vocabulary before
    // it will send, and an empty vocabulary is what fails this loudly
    const reasons = [
      "asset-layout-unexpected",
      "busy",
      "cancelled",
      "check-failed",
      "checksum-mismatch",
      "checksum-missing",
      "download-failed",
      "no-binary-available",
      "probe-failed",
      "repaired",
      "swap-failed",
      "swap-stranded",
      "unsupported-platform",
      "version-mismatch"
    ]

    for (const reason of reasons) {
      mockUpdater.checkForUpdate.mockResolvedValue({
        started: true,
        updated: false,
        reason,
        error: "something the updater said"
      })
      await app.checkForEngineUpdate()
    }

    // and the one index.js supplies itself
    mockUpdater.checkForUpdate.mockRejectedValue(new Error("spawn EACCES"))
    await app.checkForEngineUpdate()
    reasons.push("check-rejected")

    const sent = await replay()

    expect(sent.map((message) => message.properties.update_reason)).toEqual(
      reasons
    )
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("the analytics opt-out menu item", () => {
  it("sits in the Tools menu as a checkbox", () => {
    app.createMenu()

    const item = analyticsMenuItem()
    expect(item).toBeDefined()
    expect(item.type).toBe("checkbox")
  })

  it("shows the current preference", () => {
    mockAnalytics.isEnabled.mockReturnValue(false)
    app.createMenu()

    expect(analyticsMenuItem().checked).toBe(false)
  })

  it("routes the change through the analytics service", async () => {
    app.createMenu()
    await analyticsMenuItem().click({ checked: false })

    expect(mockAnalytics.setEnabled).toHaveBeenCalledWith(false)
    // going straight to the store would leave the running instance sending for
    // the rest of the session: the gate is only re-read at init()
    expect(mockSettingsStore.setAnalyticsEnabled).not.toHaveBeenCalled()
  })

  it("says nothing when the preference saved", async () => {
    app.createMenu()
    const menuItem = { checked: false }
    await analyticsMenuItem().click(menuItem)

    expect(mockElectron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(menuItem.checked).toBe(false)
  })

  it("puts the tick where the service is when the preference did not save", async () => {
    // derived from isEnabled(), never inverted from the click. a tick computed
    // from the service cannot disagree with it; a tick that flips agrees only
    // as long as every path gets the arithmetic right, and it has now been
    // wrong twice.
    //
    // so a failed opt-out leaves the tick OFF: the service went inert for the
    // session whether or not the write stuck, and that is what off means. the
    // dialog, not the checkbox, is what says it will not survive a restart.
    mockAnalytics.setEnabled.mockResolvedValue({
      success: false,
      error: "disk full"
    })
    mockAnalytics.isEnabled.mockReturnValue(false)
    app.createMenu()

    const menuItem = { checked: false }
    await analyticsMenuItem().click(menuItem)

    expect(menuItem.checked).toBe(false)
    expect(mockElectron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    const [, options] = mockElectron.dialog.showMessageBox.mock.calls[0]
    expect(options.type).toBe("error")
    expect(options.detail).toBe("disk full")
  })

  it("puts the tick back when an opt-in did not save", async () => {
    mockAnalytics.setEnabled.mockResolvedValue({
      success: false,
      error: "disk full"
    })
    mockAnalytics.isEnabled.mockReturnValue(false)
    app.createMenu()

    const menuItem = { checked: true }
    await analyticsMenuItem().click(menuItem)

    expect(menuItem.checked).toBe(false)
    expect(mockElectron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  describe("a click the user has already replaced", () => {
    // the handler closes over the live MenuItem, so an older click's failure
    // resuming late acts on the checkbox the NEWEST click left behind. both
    // orderings are reachable from one impatient double-click.

    it("says nothing about a tick that has moved on without it", async () => {
      mockAnalytics.setEnabled.mockResolvedValue({
        success: false,
        error: "disk full",
        superseded: true
      })
      // where the newer click left things: off, and the service agrees
      mockAnalytics.isEnabled.mockReturnValue(false)
      app.createMenu()

      const menuItem = { checked: false }
      await analyticsMenuItem().click(menuItem)

      expect(menuItem.checked).toBe(false)
      // and no dialog: an error about a click nobody is making any more is
      // noise, and it arrives with no way to tell which click it was about
      expect(mockElectron.dialog.showMessageBox).not.toHaveBeenCalled()
    })

    it("does not turn a live tick off for a superseded opt-out", async () => {
      // the reverse ordering: the older click was the opt-out, and the service
      // is now on because the newer one turned it on
      mockAnalytics.setEnabled.mockResolvedValue({
        success: false,
        error: "disk full",
        superseded: true
      })
      mockAnalytics.isEnabled.mockReturnValue(true)
      app.createMenu()

      const menuItem = { checked: true }
      await analyticsMenuItem().click(menuItem)

      expect(menuItem.checked).toBe(true)
      expect(mockElectron.dialog.showMessageBox).not.toHaveBeenCalled()
    })
  })
})

describe("the engine version in the Tools menu", () => {
  let log

  beforeEach(() => {
    log = jest.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
  })

  it("names the engine this install is actually running", () => {
    mockEngine.rememberVersion("2026.08.19")
    app.createMenu()

    expect(engineVersionMenuItem()).toBeDefined()
    expect(engineVersionMenuItem().label).toBe("Video engine: yt-dlp 2026.08.19")
  })

  it("says it does not know rather than inventing a version", () => {
    // a refused or failed seed reports no version, and setEngineVersion drops
    // falsy by design - so "unknown" is a state this line has to be able to sit
    // in for a whole run without claiming otherwise
    app.createMenu()

    expect(engineVersionMenuItem().label).toBe("Video engine: version unknown")
  })

  it("is a line to read, not a thing to click", () => {
    app.createMenu()

    expect(engineVersionMenuItem().enabled).toBe(false)
    expect(engineVersionMenuItem().click).toBeUndefined()
  })

  it("takes its own place above the analytics toggle", () => {
    mockEngine.rememberVersion("2026.08.19")
    app.createMenu()

    expect(toolsMenuShape()).toEqual([
      "Check for Updates",
      "<separator>",
      "Video engine: yt-dlp 2026.08.19",
      "<separator>",
      "Send usage data"
    ])
  })

  it("does not reach for a menu that has not been built yet", async () => {
    // the seed resolves inside initializeServices, which runs before
    // createMenu. rebuilding there would put a menu up early and then throw it
    // away moments later
    app.services = {}
    await app.initializeServices()

    expect(mockElectron.Menu.setApplicationMenu).not.toHaveBeenCalled()
  })

  it("follows the engine onto a version that lands after startup", async () => {
    mockEngine.rememberVersion("2026.08.19")
    app.createMenu()
    expect(engineVersionMenuItem().label).toBe("Video engine: yt-dlp 2026.08.19")

    app.services.ytdlpUpdater = mockUpdater
    mockUpdater.checkForUpdate.mockResolvedValue({
      started: true,
      updated: true,
      from: "2026.08.19",
      to: "2026.09.01",
      reason: "completed"
    })
    await app.checkForEngineUpdate()

    // a label is copied into the native menu when the item is inserted, so
    // there is nothing to mutate afterwards - the menu has to be rebuilt, and
    // it has to be handed back to electron for any of it to show
    expect(engineVersionMenuItem().label).toBe("Video engine: yt-dlp 2026.09.01")
    expect(mockElectron.Menu.setApplicationMenu).toHaveBeenCalledTimes(2)
  })

  it("leaves the analytics toggle as it found it when it rebuilds", async () => {
    mockAnalytics.isEnabled.mockReturnValue(false)
    mockEngine.rememberVersion("2026.08.19")
    app.createMenu()

    app.services.ytdlpUpdater = mockUpdater
    mockUpdater.checkForUpdate.mockResolvedValue({
      started: true,
      updated: true,
      from: "2026.08.19",
      to: "2026.09.01",
      reason: "completed"
    })
    await app.checkForEngineUpdate()

    const item = analyticsMenuItem()
    expect(item).toBeDefined()
    expect(item.type).toBe("checkbox")
    expect(item.checked).toBe(false)
  })

  it("rebuilds nothing when the update left the engine where it was", async () => {
    mockEngine.rememberVersion("2026.08.19")
    app.createMenu()

    app.services.ytdlpUpdater = mockUpdater
    await app.checkForEngineUpdate()

    expect(mockElectron.Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
  })

  it("rebuilds nothing when the version did not actually move", () => {
    mockEngine.rememberVersion("2026.08.19")
    app.createMenu()

    // an update reports the version it landed on, not that it differs. landing
    // back on the one already on the label is nothing to redraw for - and a
    // rebuild swaps the menu out from under anyone who has it open
    app.reportEngineUpdate({
      updated: true,
      from: "2026.08.19",
      to: "2026.08.19",
      reason: "completed"
    })

    expect(mockElectron.Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
  })
})

describe("quitting", () => {
  const quitEvent = () => ({ preventDefault: jest.fn() })

  it("drains queued events before the ipc handlers go", async () => {
    await app.onBeforeQuit(quitEvent())

    expect(mockAnalytics.flush).toHaveBeenCalledTimes(1)
    expect(mockAnalytics.flush.mock.invocationCallOrder[0]).toBeLessThan(
      mockIpcHandlers.cleanup.mock.invocationCallOrder[0]
    )
  })

  it("holds the quit open until the drain finishes", async () => {
    // before-quit does not await an async listener, so without cancelling the
    // quit first the flush races the process teardown and loses
    const event = quitEvent()
    await app.onBeforeQuit(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(mockElectron.app.quit).toHaveBeenCalledTimes(1)
    expect(mockAnalytics.flush.mock.invocationCallOrder[0]).toBeLessThan(
      mockElectron.app.quit.mock.invocationCallOrder[0]
    )
  })

  it("lets the second pass through instead of cancelling forever", async () => {
    await app.onBeforeQuit(quitEvent())

    const second = quitEvent()
    await app.onBeforeQuit(second)

    expect(second.preventDefault).not.toHaveBeenCalled()
    expect(mockAnalytics.flush).toHaveBeenCalledTimes(1)
  })

  it("drains when an update is installing, and only skips the teardown", async () => {
    // installing an update is still a quit, and it is the quit whose last
    // events matter most: it is the boundary between two versions, which is
    // the whole point of previous_version. what an install cannot tolerate is
    // the teardown - cancelling the downloads and tearing down ipc - so that
    // is what stays skipped, not the drain
    const cancelAll = jest.fn(() => 1)
    app.services.ytdlpEngine = { cancelAll }
    global.isUpdating = true

    try {
      const event = quitEvent()
      await app.onBeforeQuit(event)

      expect(mockAnalytics.flush).toHaveBeenCalledTimes(1)
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
      expect(mockAnalytics.flush.mock.invocationCallOrder[0]).toBeLessThan(
        mockElectron.app.quit.mock.invocationCallOrder[0]
      )

      expect(mockIpcHandlers.cleanup).not.toHaveBeenCalled()
      expect(cancelAll).not.toHaveBeenCalled()
    } finally {
      global.isUpdating = false
    }
  })

  it("re-issues the quit the installer asked for", async () => {
    // the installer is already spawned and waiting on this process to exit, so
    // cancelling its quit only works if the second one actually goes out - and
    // the pass that follows it must fall straight through
    global.isUpdating = true

    try {
      await app.onBeforeQuit(quitEvent())
      expect(mockElectron.app.quit).toHaveBeenCalledTimes(1)

      const second = quitEvent()
      await app.onBeforeQuit(second)

      expect(second.preventDefault).not.toHaveBeenCalled()
      expect(mockAnalytics.flush).toHaveBeenCalledTimes(1)
    } finally {
      global.isUpdating = false
    }
  })

  it("does not let a stalled drain strand an update install", async () => {
    global.isUpdating = true
    jest.useFakeTimers()
    mockAnalytics.flush.mockImplementation(() => new Promise(() => {}))

    try {
      const quitting = app.onBeforeQuit(quitEvent())
      jest.advanceTimersByTime(10000)
      await quitting

      expect(mockElectron.app.quit).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
      global.isUpdating = false
    }
  })

  it("does not let a stalled flush hold the app open", async () => {
    jest.useFakeTimers()
    mockAnalytics.flush.mockImplementation(() => new Promise(() => {}))

    try {
      const quitting = app.onBeforeQuit(quitEvent())
      jest.advanceTimersByTime(10000)
      await quitting

      expect(mockElectron.app.quit).toHaveBeenCalledTimes(1)
      expect(mockIpcHandlers.cleanup).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})
