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
  ipcMain: {
    handle: jest.fn(),
    removeAllListeners: jest.fn(),
    removeHandler: jest.fn()
  },
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
const { DownloadHistory } = require("../src/main/services/download-history")

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
function createHandlers({ userDataPath, outputDir }, { history = null } = {}) {
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
    },
    ...(history ? { downloadHistory: history } : null)
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
    expect(response.data).toEqual({ epoch: 0, rows: [] })
  })
})

describe("the hydration read", () => {
  test("waits for the file rather than saying this install has no history", async () => {
    // the renderer hydrates once and nothing pushes a correction afterwards, so
    // an answer given before the read lands is the answer the panel keeps
    const workspace = createWorkspace()
    const saved = [
      {
        download_id: "combined_old",
        kind: "video",
        status: "completed",
        started_at: 1000,
        title: "From a previous run"
      }
    ]
    fs.mkdirSync(path.join(workspace.userDataPath, "downloads"), { recursive: true })
    fs.writeFileSync(
      historyFile(workspace.userDataPath),
      JSON.stringify(saved),
      "utf8"
    )

    let release
    const held = new Promise((resolve) => {
      release = resolve
    })

    // the read the constructor's load() is waiting on, held open
    const history = new DownloadHistory({
      filePath: historyFile(workspace.userDataPath)
    })
    history.readFile = () => held

    const { handlers } = createHandlers(workspace, { history })

    const answering = handlers.handleGetHistory(null)
    release(saved)

    const response = await answering
    expect(response.data.rows).toHaveLength(1)
    expect(response.data.rows[0].download_id).toBe("combined_old")
  })

  /**
   * the other half of "the load barrier is not enough"
   *
   * a row's status is written inside the same chained work that persists it, so
   * a terminal upsert queued behind an earlier write has not touched the rows
   * in memory yet. the renderer reloading in that window would hydrate a
   * download that is already over as a live row - and it is a row nothing can
   * repair: the completion event went out before the new subscription existed,
   * the runner has already forgotten the id, and draining the write later emits
   * nothing. Stop would find nothing, Retry would not be offered, and the live
   * duplicate rule would refuse to download it again.
   */
  test("includes a completion that is still queued behind an earlier write", async () => {
    const workspace = createWorkspace()

    const history = new DownloadHistory({
      filePath: historyFile(workspace.userDataPath)
    })

    // the first write to the file, held open: everything the download does
    // after it is recorded but not yet applied
    let releaseWrite
    const held = new Promise((resolve) => {
      releaseWrite = resolve
    })
    const persist = history.persist.bind(history)
    let first = true

    history.persist = async () => {
      if (first) {
        first = false
        await held
      }

      return persist()
    }

    const { handlers, handles } = createHandlers(workspace, { history })

    await handlers.handleDownloadCombined(null, request())
    await settle()

    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await settle()

    // the runner has let go of it, so the history is the only thing left that
    // knows this download ever happened
    expect(handlers.runner.list()).toEqual([])

    const answering = handlers.handleGetHistory(null)
    releaseWrite()

    const response = await answering

    expect(response.data.rows).toHaveLength(1)
    expect(response.data.rows[0]).toMatchObject({
      download_id: "combined_1",
      status: "completed",
      filename: "a.mp4"
    })
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
    expect(response.data.rows).toHaveLength(1)
    expect(response.data.rows[0].status).toBe("interrupted")
    // and the request is still there, which is what makes the row retryable
    expect(response.data.rows[0].request.url).toBe(
      "https://www.youtube.com/watch?v=abcdefghijk"
    )
  })
})

describe("the three channels", () => {
  test("get-history answers with the rows, and which clear they predate", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers)
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    const response = await handlers.handleGetHistory(null)

    // {epoch, rows}, as download:get-all answers: the rows are what the
    // renderer hydrates from, and the epoch is the one thing it cannot work
    // out for itself
    expect(response.success).toBe(true)
    expect(response.data.epoch).toBe(0)
    expect(response.data.rows[0].download_id).toBe("combined_1")
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
    expect(response.data.rows.map((row) => row.download_id)).toEqual([
      "combined_live"
    ])
    // the clear is what moved the epoch, and its own answer carries the new one
    expect(response.data.epoch).toBe(1)

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

    expect(response.data.rows.map((row) => row.download_id)).toEqual([
      "combined_2"
    ])
    expect(response.data.epoch).toBe(1)
  })

  /**
   * the epoch is the one thing the renderer cannot work out for itself: which
   * side of a clear a snapshot was read on. It counts the times a row left the
   * history, so a download finishing is not one of them.
   */
  test("the epoch moves when a row leaves the history, and not otherwise", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers, { download_id: "combined_1" })
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    // a download that started and finished is not a row leaving
    expect((await handlers.handleGetHistory(null)).data.epoch).toBe(0)
    expect((await handlers.handleGetAllDownloads(null)).data.epoch).toBe(0)

    await handlers.handleClearHistory(null)

    expect((await handlers.handleGetHistory(null)).data.epoch).toBe(1)
    // both snapshots answer with the same number: they describe one history
    expect((await handlers.handleGetAllDownloads(null)).data.epoch).toBe(1)

    await start(handlers, { download_id: "combined_2" })
    handles[1].resolve({ filePath: path.join(workspace.outputDir, "b.mp4") })
    await written(handlers)

    expect((await handlers.handleGetHistory(null)).data.epoch).toBe(1)

    await handlers.handleRemoveHistory(null, { downloadId: "combined_2" })

    expect((await handlers.handleGetHistory(null)).data.epoch).toBe(2)
  })

  /**
   * the epoch moves before the history does. A snapshot read taken between the
   * two would otherwise carry the new number over rows the clear is about to
   * delete, and the renderer would keep them for the rest of the session.
   */
  test("a snapshot taken while a clear is running is not counted as after it", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers, { download_id: "combined_1" })
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    const realClear = handlers.history.clear.bind(handlers.history)
    handlers.history.clear = async () => {
      await held
      return realClear()
    }

    const clearing = handlers.handleClearHistory(null)
    const during = await handlers.handleGetHistory(null)

    release()
    const cleared = await clearing

    // the snapshot still holds the row the clear is about to delete, and its
    // epoch is the clear's own: the renderer reads it as not newer than the
    // clear, which is what makes it discard those rows
    expect(during.data.rows.map((row) => row.download_id)).toEqual([
      "combined_1"
    ])
    expect(during.data.epoch).toBe(cleared.data.epoch)
    expect(cleared.data.rows).toEqual([])
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
    ipcMain.removeHandler.mockClear()

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

    /**
     * removeHandler, not removeAllListeners: an invoke handler is not a
     * listener and lives in its own registry, so the loop over the other
     * channels does not touch it. a channel left registered makes the next
     * `handle` for it throw, and until then the old closure - holding the old
     * history and the old runner - is what answers the renderer
     */
    const removed = ipcMain.removeHandler.mock.calls.map(([channel]) => channel)
    expect(removed).toEqual([
      "download:get-history",
      "download:clear-history",
      "download:remove-history",
      // the panel's second pass added these two, and they are unregistered on
      // the same path for the same reason
      "system:show-in-folder",
      "settings:get-download-count"
    ])
  })
})
