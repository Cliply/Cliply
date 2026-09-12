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
  return new IPCHandlers({
    cookieManager: { hasValidCookies: jest.fn(() => true) },
    ytdlpEngine: {},
    ytdlpUpdater: null,
    settingsStore: {
      ensureDownloadPath: jest.fn().mockResolvedValue(downloads),
      readAll: jest.fn().mockResolvedValue(settings)
    }
  })
}

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

  // a settings file somebody edited by hand. the panel draws this number, and
  // "NaN media downloaded" is worse than zero
  test("and so has one whose counter is not a number", async () => {
    const { downloads } = createWorkspace()
    const handlers = createHandlers(downloads, { downloads_completed: "lots" })

    const response = await handlers.handleGetDownloadCount(null)

    expect(response.data.count).toBe(0)
  })
})
