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

function harness(startingCount = 0) {
  const sent = []
  let stored = { downloads_completed: startingCount }

  const settingsStore = {
    readAll: jest.fn(async () => ({ ...stored })),
    writeSettings: jest.fn(async (patch) => {
      stored = { ...stored, ...patch }
    }),
    ensureDownloadPath: jest.fn().mockResolvedValue("/tmp")
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

  handlers.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
  }

  return { handlers, sent, settingsStore, read: () => stored }
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
  test.each([[5], [15], [40]])("the %sth download asks", async (n) => {
    const { handlers, sent } = harness(n - 1)

    handlers.noteCompletedDownload()
    await settle()

    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe(IPC_CHANNELS.SUPPORT_MILESTONE)
    expect(sent[0].payload).toEqual({ count: n })
  })

  // the ones either side of a milestone, and a heavy user long past the end
  test.each([[1], [4], [6], [14], [16], [39], [41], [100], [500]])(
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
    const { handlers, sent } = harness(40)

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

  // this hangs off the hook the runner calls when a download reports success,
  // so a failure here must never turn a finished file into a failed one
  test("and the failure is swallowed rather than sent to the window", async () => {
    const { handlers, sent, settingsStore } = harness(4)
    settingsStore.readAll.mockRejectedValue(new Error("unreadable"))

    handlers.noteCompletedDownload()
    await settle()

    expect(sent).toEqual([])
  })

  test("a closed window is not written to", async () => {
    const { handlers, sent } = harness(4)
    handlers.mainWindow.isDestroyed = () => true

    handlers.noteCompletedDownload()
    await settle()

    expect(sent).toEqual([])
  })
})
