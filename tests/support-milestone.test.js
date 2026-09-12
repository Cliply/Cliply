// how often the coffee ask is allowed to appear
//
// the whole design rests on it stopping. Asking every ten downloads for as long
// as somebody keeps using the app turns a thank-you into a toll booth, and
// nobody who has declined three times says yes on the fourth. So these are
// mostly tests that it stays quiet.

jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  dialog: { showOpenDialog: jest.fn() },
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0") }
}))

const IPCHandlers = require("../src/main/ipc-handlers")
const { IPC_CHANNELS } = require("../src/main/utils/constants")

function harness(startingCount = 0, overrides = {}) {
  const sent = []
  const captured = []
  let stored = { downloads_completed: startingCount }

  const settingsStore = {
    readAll: jest.fn(async () => ({ ...stored })),
    writeSettings: jest.fn(async (patch) => {
      stored = { ...stored, ...patch }
    }),
    ensureDownloadPath: jest.fn().mockResolvedValue("/tmp"),
    ...overrides
  }

  const handlers = new IPCHandlers({
    cookieManager: {
      hasValidCookies: () => false,
      hasYouTubeCookies: () => false
    },
    ytdlpEngine: {},
    ytdlpUpdater: null,
    settingsStore,
    analytics: null
  })

  handlers.capture = (event, props) => captured.push({ event, props })

  handlers.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
  }

  return { handlers, sent, captured, settingsStore, read: () => stored }
}

// let the fire-and-forget promise chain settle
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("counting downloads", () => {
  test("a finished download is counted", async () => {
    const { handlers, read } = harness(0)

    handlers.noteCompletedDownload()
    await settle()

    expect(read().downloads_completed).toBe(1)
  })

  test("counting resumes from what was already stored", async () => {
    const { handlers, read } = harness(7)

    handlers.noteCompletedDownload()
    await settle()

    expect(read().downloads_completed).toBe(8)
  })

  test("a settings file with junk in it does not break counting", async () => {
    const { handlers, read } = harness("not a number")

    handlers.noteCompletedDownload()
    await settle()

    expect(read().downloads_completed).toBe(1)
  })
})

describe("when the ask appears", () => {
  test.each([[5], [15], [40], [60], [100]])(
    "the %sth download asks",
    async (n) => {
      const { handlers, sent } = harness(n - 1)

      handlers.noteCompletedDownload()
      await settle()

      expect(sent).toHaveLength(1)
      expect(sent[0].channel).toBe(IPC_CHANNELS.SUPPORT_MILESTONE)
      expect(sent[0].payload).toEqual({ count: n })
    }
  )

  // the ones either side of a milestone, and a heavy user long past the end
  test.each([[1], [4], [6], [14], [16], [39], [41], [59], [61], [99], [101], [500]])(
    "the %sth download says nothing",
    async (n) => {
      const { handlers, sent } = harness(n - 1)

      handlers.noteCompletedDownload()
      await settle()

      expect(sent).toEqual([])
    }
  )

  // the point of the sequence: it ends
  test("nothing is ever sent again after the last milestone", async () => {
    const { handlers, sent } = harness(100)

    for (let i = 0; i < 200; i++) {
      handlers.noteCompletedDownload()
      await settle()
    }

    expect(sent).toEqual([])
  })
})

describe("when it must stay out of the way", () => {
  test("a settings write that fails does not throw at the caller", async () => {
    const { handlers, settingsStore } = harness(4)
    settingsStore.writeSettings.mockRejectedValue(new Error("disk full"))

    expect(() => handlers.noteCompletedDownload()).not.toThrow()
    await settle()
  })

  /**
   * the counter is read once, when the handlers are built. a read that fails
   * leaves this install counting from zero for the session rather than
   * refusing to count at all, and says nothing to the window about it - this
   * hangs off the path where a download reports success, and a finished file
   * must not be reported as a failed one.
   */
  test("and a counter that could not be read still counts, quietly", async () => {
    const { handlers, sent, read } = harness(4, {
      readAll: jest.fn().mockRejectedValue(new Error("unreadable"))
    })

    await handlers.lifetimeReady
    handlers.noteCompletedDownload()
    await settle()

    expect(sent).toEqual([])
    expect(read().downloads_completed).toBe(1)
  })

  test("a closed window is not written to", async () => {
    const { handlers, sent } = harness(4)
    handlers.mainWindow.isDestroyed = () => true

    handlers.noteCompletedDownload()
    await settle()

    expect(sent).toEqual([])
  })
})

// the prompt is only worth keeping if it can be told whether anyone acts on it,
// and worth trimming if the later steps convert at nothing
describe("what analytics can answer", () => {
  test("a prompt that is shown is captured, with its milestone", async () => {
    const { handlers, captured } = harness(14)

    handlers.noteCompletedDownload()
    await settle()

    expect(captured).toEqual([
      { event: "support_prompt_shown", props: { milestone: 15 } }
    ])
  })

  // otherwise a shown rate would be a download counter with extra steps
  test("a download that is not a milestone captures nothing", async () => {
    const { handlers, captured } = harness(20)

    handlers.noteCompletedDownload()
    await settle()

    expect(captured).toEqual([])
  })

  // each step is separable, which is the join that says whether 60 and 100
  // earn their place or just annoy people who already said no twice
  test("each step reports its own number", async () => {
    const seen = []

    for (const n of [5, 15, 40, 60, 100]) {
      const { handlers, captured } = harness(n - 1)
      handlers.noteCompletedDownload()
      await settle()
      seen.push(captured[0].props.milestone)
    }

    expect(seen).toEqual([5, 15, 40, 60, 100])
  })

  // the renderer reports the click, so main's allowlist has to let it through
  // - it is refused by default, and a refusal here would silently lose the
  // half of the funnel that says whether anyone acts
  test("the renderer is allowed to report the click", async () => {
    const { handlers, captured } = harness(0)
    handlers.analytics = {}

    const response = await handlers.handleAnalyticsTrack(null, {
      event: "support_prompt_clicked",
      properties: { milestone: 15 }
    })

    expect(response.success).not.toBe(false)
    expect(captured).toContainEqual({
      event: "support_prompt_clicked",
      props: expect.objectContaining({ milestone: 15 })
    })
  })

  test("an event the renderer invented is still refused", async () => {
    const { handlers, captured } = harness(0)
    handlers.analytics = {}

    await handlers.handleAnalyticsTrack(null, { event: "support_prompt_shown" })

    expect(captured).toEqual([])
  })
})

// two downloads can finish in the same tick - the engine allows concurrent
// operations - and each completion is a read, an increment and a write.
// Unserialised they both read 4, both write 5, and both announce milestone 5:
// one file goes uncounted and the user is asked for a coffee twice at once.
describe("two downloads finishing together", () => {
  test("counts both, and asks only once", async () => {
    const { handlers, sent, read } = harness(4)

    handlers.noteCompletedDownload()
    handlers.noteCompletedDownload()
    await settle()

    expect(read().downloads_completed).toBe(6)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toEqual({ count: 5 })
  })

  // and the analytics half must not double count either, or the shown rate is
  // inflated by exactly the users who download fastest
  test("captures one shown event, not two", async () => {
    const { handlers, captured } = harness(4)

    handlers.noteCompletedDownload()
    handlers.noteCompletedDownload()
    await settle()

    expect(captured).toEqual([
      { event: "support_prompt_shown", props: { milestone: 5 } }
    ])
  })

  /**
   * a failed write must not wedge every later completion behind it - and the
   * download it lost is not lost any more: each write persists the total as it
   * stands, so the one that lands repairs the one that did not.
   */
  test("a write that throws does not stop the next one counting", async () => {
    const { handlers, settingsStore, read } = harness(0)
    const realWrite = settingsStore.writeSettings
    settingsStore.writeSettings = async () => {
      settingsStore.writeSettings = realWrite
      throw new Error("disk full")
    }

    handlers.noteCompletedDownload()
    handlers.noteCompletedDownload()
    await settle()

    expect(read().downloads_completed).toBe(2)
  })
})
