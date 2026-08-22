/**
 * the renderer's telemetry, from the ipc boundary inwards.
 *
 * the renderer is the least-trusted caller in this design and that is by
 * construction: its property bag is forwarded wholesale, and the event
 * allowlist, the per-property allowlist, the value validation and the redaction
 * on this side are what make forwarding it safe. so these drive the real
 * handler and the real Analytics against a fake posthog client, and the bags
 * they drive are the ones the renderer suite records off the real hooks
 * (src/main/renderer/src/lib/hooks/analyticsCallSites.test.tsx) - a
 * hand-written bag would only prove this file's own arithmetic.
 *
 * silence on console.warn is the assertion for a payload that must survive:
 * every drop and every normalisation warns, and production shows nobody.
 */

jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), removeAllListeners: jest.fn() },
  dialog: { showOpenDialog: jest.fn() },
  app: { getVersion: jest.fn(() => "1.2.3") },
  shell: { openExternal: jest.fn(), openPath: jest.fn() }
}))

const { ipcMain } = require("electron")

const IPCHandlers = require("../src/main/ipc-handlers")
const { IPC_CHANNELS } = require("../src/main/utils/constants")

// the one file both test runners read. the renderer suite proves this is what
// its call sites really build; this suite proves it is what the boundary really
// accepts. neither half means much without the other.
const payloads = require("../src/main/renderer/src/lib/analytics-payloads.fixture.json")

// requireActual on purpose: a suite that mocks services/ytdlp-engine takes
// redactLogLine down with it, and every text-bearing event then dies inside
// capture()'s catch - a replay that passes having sent nothing
const { Analytics: RealAnalytics } = jest.requireActual(
  "../src/main/services/analytics"
)

let warn

beforeEach(() => {
  jest.clearAllMocks()
  warn = jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

/**
 * handlers wired to a real Analytics with a fake client
 * @returns {Promise<{handlers: Object, sent: Array}>}
 */
async function createHandlers() {
  const sent = []

  const analytics = new RealAnalytics({
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

  await analytics.init()

  const handlers = new IPCHandlers({
    cookieManager: { hasValidCookies: () => true },
    ytdlpEngine: {},
    ytdlpUpdater: null,
    settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") },
    analytics
  })

  warn.mockClear()

  return { handlers, sent }
}

/** put bags through the handler the way the preload bridge would */
async function send(handlers, bags) {
  const results = []

  for (const bag of bags) {
    results.push(await handlers.handleAnalyticsTrack(null, bag))
  }

  return results
}

describe("the channel", () => {
  it("is registered and cleaned up", async () => {
    const { handlers } = await createHandlers()

    const registered = ipcMain.handle.mock.calls.map(([channel]) => channel)
    expect(registered).toContain(IPC_CHANNELS.ANALYTICS_TRACK)

    handlers.cleanup()

    const removed = ipcMain.removeAllListeners.mock.calls.map(
      ([channel]) => channel
    )
    expect(removed).toContain(IPC_CHANNELS.ANALYTICS_TRACK)
  })
})

describe("what the renderer's call sites send", () => {
  it("survives the real validator whole", async () => {
    const { handlers, sent } = await createHandlers()

    const results = await send(handlers, payloads.callSites)

    expect(results.every((result) => result.success)).toBe(true)
    expect(sent).toHaveLength(payloads.callSites.length)

    for (const [index, message] of sent.entries()) {
      const bag = payloads.callSites[index]

      expect(message.event).toBe(bag.event)
      // every property the renderer sent is still there, unchanged. the super
      // properties this module adds itself ride along beside them
      expect(message.properties).toMatchObject(bag.properties)
    }

    expect(warn).not.toHaveBeenCalled()
  })

  it("says nothing about a url, a title or a file", async () => {
    const { handlers, sent } = await createHandlers()

    await send(handlers, payloads.callSites)

    const serialised = JSON.stringify(sent)
    expect(serialised).not.toContain("http")
    expect(serialised).not.toContain("Holiday")
    expect(serialised).not.toContain(".mp4")
  })

  it("keeps a failure message usable without the path inside it", async () => {
    // the engine's own wording is fixed and safe, which is why a replay built
    // only from it proves nothing. this is a message nobody wrote for telemetry
    const { handlers, sent } = await createHandlers()

    await send(handlers, payloads.unvouchedText)

    const [message] = sent
    const text = message.properties.error_message

    expect(text).not.toContain("/Users/someone")
    expect(text).not.toContain("Holiday")
    expect(text).not.toContain(".mp4")
    // still a failure somebody can act on, which is the point of free text
    expect(text).toContain("Permission denied")
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("what the renderer may not do", () => {
  it("refuses the events main owns", async () => {
    // the renderer knows none of these first-hand: it would be reporting a
    // download it cannot see the end of, or a launch it was not present for
    const { handlers, sent } = await createHandlers()

    const results = await send(
      handlers,
      [
        "download_completed",
        "download_failed",
        "download_cancelled",
        "app_launched",
        "engine_seeded",
        "engine_updated",
        "engine_update_failed",
        "cookies_imported"
      ].map((event) => ({ event, properties: { platform: "youtube" } }))
    )

    expect(results.every((result) => result.success === false)).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it("refuses an event it invented, or one that is not a name at all", async () => {
    const { handlers, sent } = await createHandlers()

    const results = await send(handlers, [
      { event: "url_submitted_v2", properties: {} },
      { event: "", properties: {} },
      { event: 42, properties: {} },
      { event: { toString: () => "url_submitted" }, properties: {} },
      { event: ["url_submitted"], properties: {} },
      { event: null, properties: {} },
      { properties: {} },
      {},
      null,
      undefined
    ])

    expect(results.every((result) => result.success === false)).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it("drops a property nobody declared for the event", async () => {
    const { handlers, sent } = await createHandlers()

    await send(handlers, [
      {
        event: "url_submitted",
        properties: {
          platform: "youtube",
          url_kind: "video",
          video_title: "My Holiday Video",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          file_path: "/Users/someone/Movies/clip.mp4"
        }
      }
    ])

    const [message] = sent
    expect(message.properties).not.toHaveProperty("video_title")
    expect(message.properties).not.toHaveProperty("url")
    expect(message.properties).not.toHaveProperty("file_path")
    expect(message.properties.platform).toBe("youtube")
    expect(JSON.stringify(message.properties)).not.toContain("Holiday")
  })

  it("drops a declared property carrying something it should not", async () => {
    const { handlers, sent } = await createHandlers()

    await send(handlers, [
      {
        event: "url_submitted",
        properties: {
          // a hostname is not a platform, and neither is a url
          platform: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          url_kind: "My Holiday Video"
        }
      }
    ])

    const [message] = sent
    // unrecognised platforms normalize rather than drop: which sites people try
    // is one of the questions this exists to answer
    expect(message.properties.platform).toBe("unsupported")
    expect(message.properties).not.toHaveProperty("url_kind")
    expect(JSON.stringify(message.properties)).not.toContain("Holiday")
  })

  it("cannot reach an event by sending something other than a bag", async () => {
    const { handlers, sent } = await createHandlers()

    const results = await send(handlers, [
      { event: "url_submitted", properties: "platform=youtube" },
      { event: "url_submitted", properties: 7 },
      { event: "url_submitted" }
    ])

    expect(results.every((result) => result.success)).toBe(true)
    expect(sent).toHaveLength(3)
    for (const message of sent) {
      expect(message.properties).not.toHaveProperty("platform")
    }
  })
})

describe("the info failures the renderer has to name", () => {
  /**
   * media_info_failed reports whatever main put in `category`, and falls back
   * to UNKNOWN_ERROR when there is none. these two refusals carried none: they
   * are main's own, raised before the engine ran, so nothing classified them
   * and two named failure modes arrived as "we could not tell".
   */
  const { ERROR_CATEGORIES } = require("../src/main/utils/error-taxonomy")

  it("classifies a platform it does not serve", async () => {
    const { handlers } = await createHandlers()
    jest.spyOn(console, "error").mockImplementation(() => {})

    const result = await handlers.handleGetVideoInfo(null, {
      url: "https://www.instagram.com/p/abc/",
      platform: "instagram"
    })

    expect(result.success).toBe(false)
    expect(result.error.category).toBe(ERROR_CATEGORIES.INVALID_URL)
  })

  it("classifies a pin that turned out to be an image", async () => {
    const { handlers } = await createHandlers()
    jest.spyOn(console, "error").mockImplementation(() => {})

    // metadata with no formats in it - what an image pin looks like to the
    // engine, and what hasPlayableVideo() reads
    handlers.engine.getInfo = jest
      .fn()
      .mockResolvedValue({ title: "A Pin", duration: 0, formats: [] })

    const result = await handlers.handleGetVideoInfo(null, {
      url: "https://pin.it/abc123",
      platform: "pinterest"
    })

    expect(result.success).toBe(false)
    // its own category, not VIDEO_UNAVAILABLE: a pin that never held a video
    // is a user pointing a downloader at an image, which is a different thing
    // from a video that has gone away
    expect(result.error.code).toBe(ERROR_CATEGORIES.NOT_A_VIDEO)
    expect(result.error.category).toBe(ERROR_CATEGORIES.NOT_A_VIDEO)
  })

  it("gives the renderer a category the vocabulary holds", async () => {
    // the round trip: what main says here is what media_info_failed carries,
    // and a value outside ERROR_CATEGORIES would be dropped on the way out
    const { handlers, sent } = await createHandlers()
    jest.spyOn(console, "error").mockImplementation(() => {})

    const refusal = await handlers.handleGetVideoInfo(null, {
      url: "https://www.instagram.com/p/abc/",
      platform: "instagram"
    })

    await send(handlers, [
      {
        event: "media_info_failed",
        properties: {
          platform: "unsupported",
          error_category: refusal.error.category,
          error_stage: "fetch_info",
          error_message: refusal.error.message
        }
      }
    ])

    expect(sent[0].properties.error_category).toBe(
      ERROR_CATEGORIES.INVALID_URL
    )
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("a boundary that must not take the app down", () => {
  it("returns rather than throwing when there is no analytics service", async () => {
    const handlers = new IPCHandlers({
      cookieManager: { hasValidCookies: () => true },
      ytdlpEngine: {},
      ytdlpUpdater: null,
      settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") }
    })

    await expect(
      handlers.handleAnalyticsTrack(null, {
        event: "url_submitted",
        properties: { platform: "youtube" }
      })
    ).resolves.toEqual({ success: false })
  })

  it("returns rather than throwing when the capture does throw", async () => {
    const handlers = new IPCHandlers({
      cookieManager: { hasValidCookies: () => true },
      ytdlpEngine: {},
      ytdlpUpdater: null,
      settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") },
      analytics: {
        capture: () => {
          throw new Error("posthog exploded")
        }
      }
    })

    await expect(
      handlers.handleAnalyticsTrack(null, {
        event: "url_submitted",
        properties: { platform: "youtube" }
      })
    ).resolves.toEqual({ success: false })
  })
})
