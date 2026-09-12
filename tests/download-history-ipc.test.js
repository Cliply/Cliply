/**
 * the download history where the app actually wires it up
 *
 * the service's own behaviour is pinned in tests/download-history.test.js.
 * These are about the wiring: the file the handlers put it in, the three
 * channels the renderer reads it through, and the one thing that has to be
 * true across two launches - a download that was running when the app went
 * away comes back as interrupted rather than as still running.
 */

jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), removeAllListeners: jest.fn() },
  dialog: { showOpenDialog: jest.fn() },
  app: { getVersion: jest.fn(() => "1.2.3") },
  shell: { openExternal: jest.fn(), openPath: jest.fn() }
}))

const { EventEmitter } = require("events")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { ipcMain } = require("electron")
const IPCHandlers = require("../src/main/ipc-handlers")

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

const settle = () => new Promise((resolve) => setImmediate(resolve))

const workspaces = []

afterEach(() => {
  while (workspaces.length) {
    fs.rmSync(workspaces.pop(), { recursive: true, force: true })
  }
})

function createWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-history-ipc-"))
  workspaces.push(workspace)

  const userDataPath = path.join(workspace, "userData")
  const outputDir = path.join(workspace, "downloads")
  fs.mkdirSync(userDataPath, { recursive: true })
  fs.mkdirSync(outputDir, { recursive: true })

  return { userDataPath, outputDir }
}

// a second launch of the app over the same userData folder
function createHandlers({ userDataPath, outputDir }) {
  const handles = []

  const engine = {
    getUserDataPath: () => userDataPath,
    downloadCombined: jest.fn(() => {
      const handle = new FakeHandle()
      handles.push(handle)
      return handle
    }),
    setPotEnabled: jest.fn(),
    getPotPaths: jest.fn(() => null),
    getDenoPath: jest.fn(() => "/deno")
  }

  const handlers = new IPCHandlers({
    cookieManager: { hasValidCookies: jest.fn(() => true) },
    ytdlpEngine: engine,
    ytdlpUpdater: null,
    settingsStore: {
      ensureDownloadPath: jest.fn().mockResolvedValue(outputDir),
      setPotEnabled: jest.fn().mockResolvedValue({ success: true })
    }
  })

  handlers.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: jest.fn() }
  }

  return { handlers, engine, handles }
}

function request(overrides = {}) {
  return {
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    height: 1080,
    container: "mp4",
    download_id: "combined_1",
    title: "A Video",
    ...overrides
  }
}

// start one download and let the runner reach the engine
async function start(handlers, overrides) {
  const response = await handlers.handleDownloadCombined(null, request(overrides))
  await settle()
  await handlers.history.flush()
  return response
}

/**
 * let a settle reach the disk
 *
 * the runner starts its writes and never awaits them - three per download, and
 * a file that is not there yet is the whole difference between this suite
 * passing and it deleting the workspace out from under a pending rename
 */
async function written(handlers) {
  await settle()
  await handlers.history.flush()
}

function historyFile(userDataPath) {
  return path.join(userDataPath, "downloads", "history.json")
}

describe("where the history lives", () => {
  test("one file under userData, beside the playlist archives", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers)
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    const saved = JSON.parse(fs.readFileSync(historyFile(workspace.userDataPath), "utf8"))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      download_id: "combined_1",
      kind: "video",
      platform: "youtube",
      title: "A Video",
      label: "1080p mp4",
      status: "completed",
      filename: "a.mp4"
    })
    // what a retry re-sends, in the spelling the renderer sent it
    expect(saved[0].request).toMatchObject({
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      height: 1080,
      container: "mp4"
    })
  })

  test("an engine that cannot say where userData is still answers the channel", async () => {
    // the stub engine several suites build. a history with nowhere to write is
    // a panel that forgets, not an app that cannot start a download
    const handlers = new IPCHandlers({
      cookieManager: { hasValidCookies: jest.fn(() => true) },
      ytdlpEngine: {},
      ytdlpUpdater: null,
      settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") }
    })

    const response = await handlers.handleGetHistory(null)

    expect(response.success).toBe(true)
    expect(response.data).toEqual([])
  })
})

describe("across two launches", () => {
  test("a download that was running comes back interrupted", async () => {
    const workspace = createWorkspace()
    const first = createHandlers(workspace)

    await start(first.handlers)

    // the quit path: mark what was live, then kill the processes. reversed, the
    // cancels would settle each row as `cancelled` and the user would reopen to
    // downloads they never stopped
    await first.handlers.history.interruptLive()
    first.handlers.cleanup()
    first.handles[0].reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }))
    await written(first.handlers)

    const second = createHandlers(workspace)
    await second.handlers.history.load()

    const response = await second.handlers.handleGetHistory(null)
    expect(response.data).toHaveLength(1)
    expect(response.data[0].status).toBe("interrupted")
    // and the request is still there, which is what makes the row retryable
    expect(response.data[0].request.url).toBe(
      "https://www.youtube.com/watch?v=abcdefghijk"
    )
  })
})

describe("the three channels", () => {
  test("get-history answers with the rows themselves", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers)
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    const response = await handlers.handleGetHistory(null)

    // the array is the data, as it is for download:get-all: the renderer reads
    // response.data straight as the rows it hydrates from
    expect(response.success).toBe(true)
    expect(Array.isArray(response.data)).toBe(true)
    expect(response.data[0].download_id).toBe("combined_1")
  })

  test("clear-history keeps a download that is still running", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers, { download_id: "combined_done" })
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    await start(handlers, { download_id: "combined_live" })

    const response = await handlers.handleClearHistory(null)

    expect(response.success).toBe(true)
    expect(response.data.map((row) => row.download_id)).toEqual(["combined_live"])

    handles[1].resolve({ filePath: path.join(workspace.outputDir, "b.mp4") })
    await written(handlers)
  })

  test("remove-history forgets one row and answers with what is left", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers, { download_id: "combined_1" })
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)
    await start(handlers, { download_id: "combined_2" })
    handles[1].resolve({ filePath: path.join(workspace.outputDir, "b.mp4") })
    await written(handlers)

    const response = await handlers.handleRemoveHistory(null, {
      downloadId: "combined_1"
    })

    expect(response.data.map((row) => row.download_id)).toEqual(["combined_2"])
  })

  test("remove-history refuses a request with no download id", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    const workspace = createWorkspace()
    const { handlers } = createHandlers(workspace)

    const response = await handlers.handleRemoveHistory(null, {})

    expect(response.success).toBe(false)
    error.mockRestore()
  })

  test("are registered, and are removed again on cleanup", () => {
    const workspace = createWorkspace()
    ipcMain.handle.mockClear()
    ipcMain.removeAllListeners.mockClear()

    const { handlers } = createHandlers(workspace)

    const registered = ipcMain.handle.mock.calls.map(([channel]) => channel)
    expect(registered).toEqual(
      expect.arrayContaining([
        "download:get-history",
        "download:clear-history",
        "download:remove-history"
      ])
    )

    handlers.cleanup()

    // a channel left registered survives into the next IPCHandlers and answers
    // out of the old one's history
    const removed = ipcMain.removeAllListeners.mock.calls.map(([channel]) => channel)
    expect(removed).toEqual(
      expect.arrayContaining([
        "download:get-history",
        "download:clear-history",
        "download:remove-history"
      ])
    )
  })
})
