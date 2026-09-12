/**
 * the two channels the downloads panel's second pass added
 *
 * `system:show-in-folder` is the only channel that takes a path from the
 * renderer and hands it to the shell, so what it owes is the refusal: a path
 * outside the download folder is not revealed, whatever it names. The other is
 * the lifetime count the panel shows above the list, which is the same counter
 * the support milestones are counted by.
 */

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn(),
    removeAllListeners: jest.fn(),
    removeHandler: jest.fn()
  },
  dialog: { showOpenDialog: jest.fn() },
  app: { getVersion: jest.fn(() => "1.2.3") },
  shell: {
    openExternal: jest.fn(),
    openPath: jest.fn(),
    showItemInFolder: jest.fn()
  }
}))

const fs = require("fs")
const os = require("os")
const path = require("path")

const { shell } = require("electron")
const IPCHandlers = require("../src/main/ipc-handlers")

const workspaces = []

afterEach(() => {
  jest.clearAllMocks()

  while (workspaces.length) {
    fs.rmSync(workspaces.pop(), { recursive: true, force: true })
  }
})

function createWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-reveal-"))
  workspaces.push(workspace)

  const downloads = path.join(workspace, "downloads")
  fs.mkdirSync(downloads, { recursive: true })

  return { workspace, downloads }
}

function createHandlers(downloads, settings = {}) {
  const handlers = new IPCHandlers({
    cookieManager: { hasValidCookies: jest.fn(() => true) },
    ytdlpEngine: {},
    ytdlpUpdater: null,
    settingsStore: {
      ensureDownloadPath: jest.fn().mockResolvedValue(downloads),
      readAll: jest.fn().mockResolvedValue(settings),
      writeSettings: jest.fn().mockResolvedValue(undefined)
    }
  })

  handlers.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: jest.fn() }
  }

  return handlers
}

/** what the renderer would have received on `download:progress` */
const sentEvents = (handlers) =>
  handlers.mainWindow.webContents.send.mock.calls
    .filter(([channel]) => channel === "download:progress")
    .map(([, payload]) => payload)

describe("revealing a downloaded file", () => {
  test("shows a file that is inside the download folder", async () => {
    const { downloads } = createWorkspace()
    const target = path.join(downloads, "holiday.mp4")
    fs.writeFileSync(target, "x")

    const handlers = createHandlers(downloads)
    const response = await handlers.handleShowInFolder(null, { path: target })

    expect(response.success).toBe(true)
    expect(shell.showItemInFolder).toHaveBeenCalledWith(target)
  })

  // yt-dlp writes a playlist into a folder of its own under the download
  // folder, so a row's path is often a level or two down
  test("and one in a folder under it", async () => {
    const { downloads } = createWorkspace()
    const target = path.join(downloads, "Lo-fi beats", "01 - first.mp4")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, "x")

    const handlers = createHandlers(downloads)
    const response = await handlers.handleShowInFolder(null, { path: target })

    expect(response.success).toBe(true)
    expect(shell.showItemInFolder).toHaveBeenCalledWith(target)
  })

  /**
   * the renderer only ever sends back a path main itself reported, so this is
   * not about the panel: it is about what the channel would do for anything
   * else that learned the channel's name.
   */
  test("refuses a path outside the download folder", async () => {
    const { workspace, downloads } = createWorkspace()
    const outside = path.join(workspace, "secrets.txt")
    fs.writeFileSync(outside, "x")

    const handlers = createHandlers(downloads)
    const response = await handlers.handleShowInFolder(null, { path: outside })

    expect(response.success).toBe(false)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  test("and one that climbs out of it", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads)

    const response = await handlers.handleShowInFolder(null, {
      path: path.join(downloads, "..", "..", "etc", "passwd")
    })

    expect(response.success).toBe(false)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  // the folder itself is not a file in it, and `openDownloadFolder` is the
  // channel for that
  test("and the download folder itself", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads)

    const response = await handlers.handleShowInFolder(null, {
      path: downloads
    })

    expect(response.success).toBe(false)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  test("and a request with no path at all", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads)

    const response = await handlers.handleShowInFolder(null, {})

    expect(response.success).toBe(false)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  /**
   * a string can be inside a folder while the file it names is not: link a
   * directory under the download folder to anywhere on disk and every path
   * below it passes a comparison of strings. The folder the user configured may
   * still be a link - that one is their own choice.
   */
  test("refuses a file reached through a symlinked directory", async () => {
    const { workspace, downloads } = createWorkspace()
    const elsewhere = path.join(workspace, "elsewhere")
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.writeFileSync(path.join(elsewhere, "outside.txt"), "x")
    fs.symlinkSync(elsewhere, path.join(downloads, "linked"))

    const handlers = createHandlers(downloads)
    const response = await handlers.handleShowInFolder(null, {
      path: path.join(downloads, "linked", "outside.txt")
    })

    expect(response.success).toBe(false)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  test("and a file that is itself a symlink out of the folder", async () => {
    const { workspace, downloads } = createWorkspace()
    const outside = path.join(workspace, "secrets.txt")
    fs.writeFileSync(outside, "x")
    fs.symlinkSync(outside, path.join(downloads, "innocent.txt"))

    const handlers = createHandlers(downloads)
    const response = await handlers.handleShowInFolder(null, {
      path: path.join(downloads, "innocent.txt")
    })

    expect(response.success).toBe(false)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  /**
   * `shell.showItemInFolder` returns nothing at all, so a file that has been
   * moved or deleted since the download would be reported as revealed and the
   * row would sit there having done nothing. It is answered instead as "not
   * shown", which is what the row's fallback to the download folder reads.
   */
  test("answers a file that is no longer there with shown: false", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads)

    const response = await handlers.handleShowInFolder(null, {
      path: path.join(downloads, "was-here.mp4")
    })

    expect(response).toEqual({
      success: true,
      data: { shown: false, path: path.join(downloads, "was-here.mp4") }
    })
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe("the lifetime download count", () => {
  test("reads the counter the milestones are counted by", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, { downloads_completed: 128 })

    const response = await handlers.handleGetDownloadCount(null)

    expect(response).toEqual({ success: true, data: { count: 128 } })
  })

  test("a fresh install has finished nothing", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, {})

    const response = await handlers.handleGetDownloadCount(null)

    expect(response.data.count).toBe(0)
  })

  /**
   * a settings file somebody edited by hand, or a build that wrote something
   * strange into it. the panel draws this number straight, so "Infinity media
   * downloaded", a half a download and a negative total are all worse than a
   * zero. "Infinity" is the one that is easy to miss: it is valid json and
   * `Number()` takes it.
   */
  test.each([
    ["lots", 0],
    [-5, 0],
    [1.5, 1],
    ["Infinity", 0],
    [null, 0],
    ["12", 12]
  ])("a counter of %p reads as %i", async (stored, expected) => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, { downloads_completed: stored })

    const response = await handlers.handleGetDownloadCount(null)

    expect(response.data.count).toBe(expected)
  })

  /**
   * the number the panel shows is the one in memory, not a second read of the
   * file: a completion that has not reached the disk yet has still happened,
   * and the renderer must never be told a total smaller than the one an event
   * already carried.
   */
  test("counts this session's completions without re-reading the file", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, { downloads_completed: 128 })
    await handlers.lifetimeReady

    handlers.sendDownloadEvent("d1", { status: "completed", progress: 100 })

    const response = await handlers.handleGetDownloadCount(null)

    expect(response.data.count).toBe(129)
  })

  // the panel hydrates in the first moments of a session, and answering 0 there
  // would put a zero in front of somebody with a hundred downloads behind them
  test("and waits for the read rather than answering zero", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, { downloads_completed: 128 })

    // no await on lifetimeReady: the handler owes that wait itself
    const response = await handlers.handleGetDownloadCount(null)

    expect(response.data.count).toBe(128)
  })
})

/**
 * the completed event is what moves the panel's number, so the count has to be
 * on it. Main counting and stamping is the whole fix: a renderer keeping its own
 * tally cannot survive hydration replaying a completion over an older snapshot.
 */
describe("the count on a completed event", () => {
  test("rides out with the completion, counting it", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, { downloads_completed: 4 })
    await handlers.lifetimeReady

    handlers.sendDownloadEvent("d1", { status: "completed", progress: 100 })

    expect(sentEvents(handlers)).toEqual([
      {
        downloadId: "d1",
        status: "completed",
        progress: 100,
        lifetimeCompleted: 5
      }
    ])
  })

  test("and two in one tick are counted once each", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, { downloads_completed: 4 })
    await handlers.lifetimeReady

    handlers.sendDownloadEvent("d1", { status: "completed", progress: 100 })
    handlers.sendDownloadEvent("d2", { status: "completed", progress: 100 })

    expect(sentEvents(handlers).map((event) => event.lifetimeCompleted)).toEqual(
      [5, 6]
    )
  })

  test.each([["downloading"], ["queued"], ["failed"], ["cancelled"]])(
    "a %s event carries no count and counts nothing",
    async (status) => {
      const { downloads } = createWorkspace()
      const handlers = createHandlers(downloads, { downloads_completed: 4 })
      await handlers.lifetimeReady

      handlers.sendDownloadEvent("d1", { status, progress: 10 })

      expect(sentEvents(handlers)[0].lifetimeCompleted).toBeUndefined()
      expect(handlers.lifetimeCompleted).toBe(4)
    }
  )

  // the window can be on its way out while a download lands. the file it wrote
  // is still a file this install downloaded
  test("and a completion with no window left to tell still counts", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, { downloads_completed: 4 })
    await handlers.lifetimeReady
    handlers.mainWindow.isDestroyed = () => true

    handlers.sendDownloadEvent("d1", { status: "completed", progress: 100 })

    expect(handlers.lifetimeCompleted).toBe(5)
  })
})
