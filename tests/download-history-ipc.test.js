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
function createHandlers(
  { userDataPath, outputDir },
  { history = null, settings = null } = {}
) {
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
      setPotEnabled: jest.fn().mockResolvedValue({ success: true }),
      writeSettings: jest.fn().mockResolvedValue(undefined),
      ...settings
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

    const response = await handlers.handleGetList(null)

    expect(response.success).toBe(true)
    expect(response.data).toMatchObject({ rows: [], lifetimeCompleted: 0 })
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

    const answering = handlers.handleGetList(null)
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

    const answering = handlers.handleGetList(null)
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

    const response = await second.handlers.handleGetList(null)
    expect(response.data.rows).toHaveLength(1)
    expect(response.data.rows[0].status).toBe("interrupted")
    // and the request is still there, which is what makes the row retryable
    expect(response.data.rows[0].request.url).toBe(
      "https://www.youtube.com/watch?v=abcdefghijk"
    )
  })
})

describe("the list main pushes and answers with", () => {
  /**
   * every downloads:list push this window has been sent, past the one the
   * lifetime counter sends when its own read lands
   */
  const pushes = (handlers) =>
    handlers.mainWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === "downloads:list")
      .map(([, snapshot]) => snapshot)
      .slice(1)

  test("get-list answers with the rows and the count", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers)
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    const response = await handlers.handleGetList(null)

    expect(response.success).toBe(true)
    expect(response.data.rows[0]).toMatchObject({
      download_id: "combined_1",
      status: "completed"
    })
    expect(response.data.lifetimeCompleted).toBe(1)
  })

  /**
   * the whole point of the push model: the snapshot is built from memory after
   * the change it announces, so there is no window in which it can describe the
   * list as it was. The disk write is queued behind it and says nothing.
   */
  test("a snapshot after a clear never holds the cleared row", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers)
    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    let releaseWrite
    const held = new Promise((resolve) => {
      releaseWrite = resolve
    })
    const realPersist = handlers.history.persist.bind(handlers.history)
    handlers.history.persist = async () => {
      await held
      return realPersist()
    }

    const clearing = handlers.handleClearHistory(null)
    const duringTheWrite = await handlers.handleGetList(null)

    releaseWrite()
    const cleared = await clearing

    expect(duringTheWrite.data.rows).toEqual([])
    expect(cleared.data.rows).toEqual([])
    expect(cleared.data.seq).toBeGreaterThan(duringTheWrite.data.seq)
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
    // and every window hears the same thing, whether or not it asked
    expect(pushes(handlers).at(-1).rows.map((row) => row.download_id)).toEqual([
      "combined_live"
    ])

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
  })

  /**
   * the list changes when a download is accepted, when it takes a slot and when
   * it settles, and when the user clears or removes a row. A percentage is not
   * a change to the list, and pushing one four times a second per download
   * would be a list rebuilt on every frame.
   */
  test("a push for every change to the list, and none for progress", async () => {
    const workspace = createWorkspace()
    const { handlers, handles } = createHandlers(workspace)

    await start(handlers)

    // the reservation, and the slot it took
    expect(pushes(handlers)).toHaveLength(2)
    expect(pushes(handlers)[0].rows[0]).toMatchObject({
      download_id: "combined_1",
      status: "queued"
    })
    expect(pushes(handlers)[1].rows[0].status).toBe("downloading")

    handles[0].emit("progress", { progress: 42 })
    await settle()

    expect(pushes(handlers)).toHaveLength(2)

    handles[0].resolve({ filePath: path.join(workspace.outputDir, "a.mp4") })
    await written(handlers)

    expect(pushes(handlers)).toHaveLength(3)
    expect(pushes(handlers)[2].rows[0].status).toBe("completed")

    await handlers.handleClearHistory(null)
    await handlers.handleRemoveHistory(null, { downloadId: "combined_1" })

    expect(pushes(handlers)).toHaveLength(5)

    // one counter for the pushes and the replies both, strictly increasing
    const seqs = [
      ...pushes(handlers).map((snapshot) => snapshot.seq),
      (await handlers.handleGetList(null)).data.seq
    ]
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  /**
   * the count is a second read, and the list carries it. A reply given before
   * that read lands says this install has downloaded nothing, and on a quiet
   * install nothing corrects it until the next download finishes.
   */
  test("get-list waits for the lifetime count as well as the history", async () => {
    const workspace = createWorkspace()
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })

    const { handlers } = createHandlers(workspace, {
      settings: {
        readAll: jest.fn(async () => {
          await held
          return { downloads_completed: 128 }
        })
      }
    })

    const answering = handlers.handleGetList(null)
    release()

    expect((await answering).data.lifetimeCompleted).toBe(128)
  })

  test("...and the list is sent again once that read lands", async () => {
    const workspace = createWorkspace()
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })

    const { handlers } = createHandlers(workspace, {
      settings: {
        readAll: jest.fn(async () => {
          await held
          return { downloads_completed: 128 }
        })
      }
    })

    release()
    await handlers.lifetimeReady

    const sent = handlers.mainWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === "downloads:list")
      .map(([, snapshot]) => snapshot)

    expect(sent.at(-1).lifetimeCompleted).toBe(128)
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
        "download:get-list",
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
      "download:get-list",
      "download:clear-history",
      "download:remove-history",
      // the panel's second pass added these two, and they are unregistered on
      // the same path for the same reason
      "system:show-in-folder",
      "settings:get-download-count"
    ])
  })
})
