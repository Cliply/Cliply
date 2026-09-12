/**
 * the playlist ipc layer: listing a playlist, validating a selection, and the
 * one job that covers n videos.
 *
 * these drive the real IPCHandlers against a fake engine, because the point of
 * this layer is what it refuses and what it hands over - not what yt-dlp then
 * does with it. the engine's own contract is pinned in
 * tests/ytdlp-playlist.test.js and tests/ytdlp-playlist-progress.test.js.
 *
 * the archive directory tests use a real temp userData folder: "the directory
 * is missing" is the failure this handler exists to prevent, and a stubbed fs
 * cannot tell us whether it did.
 */

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn(),
    removeAllListeners: jest.fn(),
    // invoke handlers live in their own registry, and cleanup() empties it
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

const IPCHandlers = require("../src/main/ipc-handlers")
const { DownloadHistory } = require("../src/main/services/download-history")
const { ERROR_CODES, PLAYLIST_MAX_ITEMS } = require("../src/main/services/ytdlp-engine")
const { ERROR_CATEGORIES } = require("../src/main/utils/error-taxonomy")

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

const URL = "https://www.youtube.com/playlist?list=PLLojVvWCZ5N4"

// what --flat-playlist --dump-single-json really returns, trimmed to the
// fields the mapper reads. a private video has a null title and no duration
const LISTING = {
  id: "PLLojVvWCZ5N4",
  title: "Short talks",
  uploader: "TED",
  playlist_count: 3,
  entries: [
    { id: "aaaaaaaaaaa", title: "One", duration: 307 },
    { id: "bbbbbbbbbbb", title: null, duration: null },
    { id: "ccccccccccc", title: "Three", duration: 401 }
  ]
}

// every workspace a test built, removed once it is done with it
const workspaces = []

afterEach(() => {
  while (workspaces.length) {
    fs.rmSync(workspaces.pop(), { recursive: true, force: true })
  }
})

function createHandlers({ listing = LISTING, listingError = null } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-playlist-"))
  workspaces.push(workspace)
  const userDataPath = path.join(workspace, "userData")
  const outputDir = path.join(workspace, "downloads")
  fs.mkdirSync(userDataPath, { recursive: true })
  fs.mkdirSync(outputDir, { recursive: true })

  const runs = []

  const engine = {
    getUserDataPath: () => userDataPath,
    getPlaylistInfo: jest.fn(() =>
      listingError ? Promise.reject(listingError) : Promise.resolve(listing)
    ),
    run: jest.fn((operation, params) => {
      const handle = new FakeHandle()
      // recorded at spawn time, so a test can ask what the filesystem looked
      // like at the moment the handle was made rather than afterwards
      runs.push({
        operation,
        params,
        handle,
        archiveDirExisted: fs.existsSync(path.dirname(params.archiveFile))
      })
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
    // a real history with no file: its rows behave exactly as they do in the
    // app, and nothing is written into the temp userData folder this suite
    // deletes the moment a test ends. tests/download-history-ipc.test.js is
    // where the file itself is pinned
    downloadHistory: new DownloadHistory()
  })

  return { handlers, engine, runs, userDataPath, outputDir, workspace }
}

// a valid request, so each test only has to say what it is changing
function request(overrides = {}) {
  return {
    url: URL,
    playlist_id: "PLLojVvWCZ5N4",
    entries: [
      { index: 1, id: "aaaaaaaaaaa" },
      { index: 3, id: "ccccccccccc" }
    ],
    height: 1080,
    download_id: "playlist_1",
    title: "Short talks",
    ...overrides
  }
}

describe("listing a playlist", () => {
  test("returns the rows the picker draws", async () => {
    const { handlers, engine } = createHandlers()

    const response = await handlers.handleGetPlaylistInfo(null, { url: URL })

    expect(engine.getPlaylistInfo).toHaveBeenCalledWith(URL)
    expect(response.success).toBe(true)
    expect(response.data.playlist_id).toBe("PLLojVvWCZ5N4")
    expect(response.data.count).toBe(3)
    expect(response.data.entries).toHaveLength(3)
    // no title and no duration is a deleted or private video
    expect(response.data.entries[1].unavailable).toBe(true)
    expect(response.data.entries[0].unavailable).toBe(false)
  })

  test("refuses a platform that has no playlists, without spawning anything", async () => {
    const { handlers, engine } = createHandlers()

    const response = await handlers.handleGetPlaylistInfo(null, {
      url: "https://pin.it/abc",
      platform: "pinterest"
    })

    expect(response.success).toBe(false)
    expect(response.error.category).toBe(ERROR_CATEGORIES.INVALID_URL)
    expect(engine.getPlaylistInfo).not.toHaveBeenCalled()
  })

  test("a failed listing keeps its classification", async () => {
    const error = new Error("YouTube asked us to confirm you're not a bot.")
    error.code = ERROR_CODES.BOT_DETECTION
    const { handlers, engine } = createHandlers({ listingError: error })
    jest.spyOn(console, "error").mockImplementation(() => {})

    const response = await handlers.handleGetPlaylistInfo(null, { url: URL })

    expect(response.success).toBe(false)
    expect(response.error.category).toBe(ERROR_CATEGORIES.BOT_DETECTION)
    // the metadata fetch is where a blocked install is usually discovered
    expect(engine.setPotEnabled).toHaveBeenCalledWith(true)
  })
})

describe("starting a playlist download", () => {
  test("reserves one id and hands the engine the selection it validated", async () => {
    const { handlers, runs } = createHandlers()

    const response = await handlers.handleDownloadPlaylist(null, request())
    await settle()

    expect(response.success).toBe(true)
    expect(response.data).toEqual({
      download_id: "playlist_1",
      status: "started",
      type: "combined",
      items_total: 2
    })

    // one download id for the whole playlist, not one per video
    expect(handlers.runner.size).toBe(1)
    expect(runs).toHaveLength(1)
    expect(runs[0].operation).toBe("playlist-combined")
    // {index, id} pairs: the indices become the -I spec, the ids decide what
    // the archive is allowed to skip
    expect(runs[0].params.playlistEntries).toEqual([
      { index: 1, id: "aaaaaaaaaaa" },
      { index: 3, id: "ccccccccccc" }
    ])
    expect(runs[0].params.height).toBe(1080)
    expect(runs[0].params.outputTemplate).toContain("%(playlist_index)")
    expect(runs[0].params.ignoreArchive).toBeUndefined()
  })

  test("the audio tab runs the audio operation with its own template", async () => {
    const { handlers, runs } = createHandlers()

    const response = await handlers.handleDownloadPlaylist(
      null,
      request({ type: "audio", audio_mode: "m4a", height: undefined })
    )
    await settle()

    expect(response.data.type).toBe("audio")
    expect(runs[0].operation).toBe("playlist-audio")
    expect(runs[0].params.audioMode).toBe("m4a")
    // the audio name carries no height - there is none to carry
    expect(runs[0].params.outputTemplate).not.toContain("%(height)s")
  })

  test("the archive directory exists before the process is created", async () => {
    // measured on the shipped binary: a run whose archive directory is missing
    // exits 1 at the end of an otherwise perfect download and the archive is
    // never written, so resume silently never works again
    const { handlers, runs, userDataPath } = createHandlers()

    expect(fs.existsSync(path.join(userDataPath, "playlists"))).toBe(false)

    await handlers.handleDownloadPlaylist(null, request())
    await settle()

    expect(runs[0].archiveDirExisted).toBe(true)
    expect(path.dirname(runs[0].params.archiveFile)).toBe(
      path.join(userDataPath, "playlists")
    )
  })

  test("the archive is scoped per quality, so a re-run at 4K is a real download", async () => {
    const { handlers, runs } = createHandlers()

    await handlers.handleDownloadPlaylist(null, request())
    await settle()
    await handlers.handleDownloadPlaylist(
      null,
      request({ height: 2160, download_id: "playlist_2" })
    )
    await settle()

    expect(runs[0].params.archiveFile).toContain("1080p-mp4")
    expect(runs[1].params.archiveFile).toContain("2160p-mp4")
    expect(runs[0].params.archiveFile).not.toBe(runs[1].params.archiveFile)
  })

  test("only a literal true drops the archive", async () => {
    const { handlers, runs } = createHandlers()

    await handlers.handleDownloadPlaylist(
      null,
      request({ ignore_archive: true })
    )
    await settle()
    await handlers.handleDownloadPlaylist(
      null,
      request({ ignore_archive: "yes", download_id: "playlist_2" })
    )
    await settle()

    expect(runs[0].params.ignoreArchive).toBe(true)
    expect(runs[1].params.ignoreArchive).toBeUndefined()
  })

  test("a repeated download id is refused rather than cross-wired", async () => {
    const { handlers } = createHandlers()
    jest.spyOn(console, "warn").mockImplementation(() => {})

    await handlers.handleDownloadPlaylist(null, request())
    await settle()
    const second = await handlers.handleDownloadPlaylist(null, request())

    expect(second.success).toBe(false)
    expect(second.error.code).toBe("DUPLICATE_DOWNLOAD")
  })
})

describe("selections that never reach a process", () => {
  const refusals = [
    ["an empty selection", { entries: [] }],
    ["a selection that is not a list", { entries: "1,2" }],
    ["a position that is not an integer", { entries: [{ index: 1.5, id: "aaaaaaaaaaa" }] }],
    ["a position sent as a string", { entries: [{ index: "1", id: "aaaaaaaaaaa" }] }],
    ["a position below the first", { entries: [{ index: 0, id: "aaaaaaaaaaa" }] }],
    [
      "a position past the cap",
      { entries: [{ index: PLAYLIST_MAX_ITEMS + 1, id: "aaaaaaaaaaa" }] }
    ],
    ["an id that is not one", { entries: [{ index: 1, id: "aaa bbb" }] }],
    ["an id that is missing", { entries: [{ index: 1 }] }],
    [
      "the same position twice",
      {
        entries: [
          { index: 1, id: "aaaaaaaaaaa" },
          { index: 1, id: "aaaaaaaaaaa" }
        ]
      }
    ],
    ["no playlist id to scope the archive by", { playlist_id: undefined }],
    ["a quality that is not one", { height: "best" }],
    ["an audio format we do not offer", { type: "audio", audio_mode: "wav" }]
  ]

  test.each(refusals)("%s", async (_name, overrides) => {
    const { handlers, engine } = createHandlers()
    jest.spyOn(console, "error").mockImplementation(() => {})

    const response = await handlers.handleDownloadPlaylist(
      null,
      request(overrides)
    )
    await settle()

    expect(response.success).toBe(false)
    expect(engine.run).not.toHaveBeenCalled()
    // nothing was reserved either, so the id stays usable
    expect(handlers.runner.size).toBe(0)
  })

  test("a selection the listing marked unavailable", async () => {
    // a private video cannot be downloaded, and every attempt spends one of
    // yt-dlp's five allowed failures before it abandons the rest
    const { handlers, engine } = createHandlers()
    jest.spyOn(console, "error").mockImplementation(() => {})

    await handlers.handleGetPlaylistInfo(null, { url: URL })

    const response = await handlers.handleDownloadPlaylist(
      null,
      request({
        entries: [
          { index: 1, id: "aaaaaaaaaaa" },
          { index: 2, id: "bbbbbbbbbbb" }
        ]
      })
    )

    expect(response.success).toBe(false)
    expect(response.error.category).toBe(ERROR_CATEGORIES.VIDEO_UNAVAILABLE)
    expect(engine.run).not.toHaveBeenCalled()
  })

  test("a selection of nothing but unavailable rows says so plainly", async () => {
    const { handlers } = createHandlers()

    await handlers.handleGetPlaylistInfo(null, { url: URL })

    const response = await handlers.handleDownloadPlaylist(
      null,
      request({ entries: [{ index: 2, id: "bbbbbbbbbbb" }] })
    )

    expect(response.error.message).toBe(
      "None of the selected videos can be downloaded."
    )
  })

  test("a different playlist is not checked against the listing we hold", async () => {
    // main has no listing of it, and inventing a refusal would be worse than
    // letting yt-dlp answer
    const { handlers, engine } = createHandlers()

    await handlers.handleGetPlaylistInfo(null, { url: URL })

    const response = await handlers.handleDownloadPlaylist(
      null,
      request({
        playlist_id: "PLsomethingelse",
        entries: [{ index: 2, id: "bbbbbbbbbbb" }]
      })
    )
    await settle()

    expect(response.success).toBe(true)
    expect(engine.run).toHaveBeenCalled()
  })

  test("a non-youtube playlist download", async () => {
    const { handlers, engine } = createHandlers()

    const response = await handlers.handleDownloadPlaylist(
      null,
      request({ platform: "tiktok" })
    )

    expect(response.success).toBe(false)
    expect(response.error.category).toBe(ERROR_CATEGORIES.INVALID_URL)
    expect(engine.run).not.toHaveBeenCalled()
  })

  test("an unusable download id, before anything is reserved", async () => {
    const { handlers, engine } = createHandlers()

    const response = await handlers.handleDownloadPlaylist(
      null,
      request({ download_id: "not a valid id" })
    )

    expect(response.error.code).toBe("INVALID_DOWNLOAD_ID")
    expect(engine.run).not.toHaveBeenCalled()
  })
})

describe("an app data folder we cannot write to", () => {
  // windows ignores the mode bits this relies on
  const canChmod = process.platform !== "win32"

  ;(canChmod ? test : test.skip)(
    "refuses with its own wording rather than a generic retry prompt",
    async () => {
      const { handlers, engine, userDataPath } = createHandlers()
      jest.spyOn(console, "error").mockImplementation(() => {})
      fs.chmodSync(userDataPath, 0o555)

      try {
        const response = await handlers.handleDownloadPlaylist(null, request())

        expect(response.success).toBe(false)
        expect(response.error.message).toBe(
          "Cliply couldn't prepare its record of this download."
        )
        expect(response.error.suggestion).toBe(
          "Check permissions on Cliply's app data folder and try again."
        )
        expect(response.error.category).toBe(ERROR_CATEGORIES.PERMISSION_ERROR)
        // the category alone would have the renderer telling a russian reader
        // to pick a different download folder, which is not the folder this
        // is about. the wording names itself so it can be translated as itself
        expect(response.error.wordingCode).toBe("RECORDS_UNWRITABLE")
        expect(engine.run).not.toHaveBeenCalled()
      } finally {
        fs.chmodSync(userDataPath, 0o755)
      }
    }
  )
})

describe("what a finished playlist reports back", () => {
  test("a partial run reaches the renderer as completed, with its counts", async () => {
    const { handlers, runs } = createHandlers()
    const events = []
    handlers.sendDownloadEvent = (downloadId, payload) =>
      events.push({ downloadId, ...payload })

    await handlers.handleDownloadPlaylist(null, request())
    await settle()

    runs[0].handle.resolve({
      filePath: "/downloads/PL/001 - One [aaa] 1080p.mp4",
      stderr: "ERROR: [youtube] ccc: Video unavailable",
      files: ["/downloads/PL/001 - One [aaa] 1080p.mp4"],
      itemsSaved: 1,
      itemsReused: 0,
      itemsSkipped: 1,
      itemsTotal: 2
    })
    await settle()
    await settle()

    const terminal = events[events.length - 1]
    expect(terminal.status).toBe("completed")
    expect(terminal.items_saved).toBe(1)
    expect(terminal.items_skipped).toBe(1)
    expect(terminal.items_total).toBe(2)
  })

  test("items skipped for bot detection still turn the escalation on", async () => {
    // the run completed, so the ordinary refusal check - which only looks at
    // failures - would never see this one
    const { handlers, engine, runs } = createHandlers()

    await handlers.handleDownloadPlaylist(null, request())
    await settle()

    runs[0].handle.resolve({
      filePath: null,
      stderr: "ERROR: [youtube] ccc: Sign in to confirm you're not a bot",
      files: ["/downloads/PL/001 - One [aaa] 1080p.mp4"],
      itemsSaved: 1,
      itemsReused: 0,
      itemsSkipped: 1,
      itemsTotal: 2
    })
    await settle()
    await settle()

    expect(engine.setPotEnabled).toHaveBeenCalledWith(true)
  })

  test("a run that skipped nothing leaves it alone", async () => {
    const { handlers, engine, runs } = createHandlers()

    await handlers.handleDownloadPlaylist(null, request())
    await settle()

    runs[0].handle.resolve({
      filePath: "/downloads/PL/003 - Three [ccc] 1080p.mp4",
      stderr: "",
      files: ["/downloads/PL/001.mp4", "/downloads/PL/003.mp4"],
      itemsSaved: 2,
      itemsReused: 0,
      itemsSkipped: 0,
      itemsTotal: 2
    })
    await settle()
    await settle()

    expect(engine.setPotEnabled).not.toHaveBeenCalled()
  })
})

describe("what a downloads list would see", () => {
  test("a playlist reserves one row, and that row says it is a playlist", async () => {
    const { handlers } = createHandlers()

    await handlers.handleDownloadPlaylist(null, request())
    await settle()

    const rows = await handlers.handleGetList(null)

    expect(rows.data.rows).toHaveLength(1)
    expect(rows.data.rows[0]).toMatchObject({
      download_id: "playlist_1",
      // one row covering n videos: `kind` is what the panel draws from, and
      // "combined" - what this fetches, which analytics and the audit log read
      // - stays on the reservation rather than on the row
      kind: "playlist",
      // the count is what a playlist row has instead of a quality
      label: "2 videos",
      request: {
        url: URL,
        title: "Short talks",
        platform: "youtube",
        playlist_id: "PLLojVvWCZ5N4",
        // the selection travels with it, so a retry downloads the videos that
        // were picked rather than the whole playlist
        entries: [
          { index: 1, id: "aaaaaaaaaaa" },
          { index: 3, id: "ccccccccccc" }
        ],
        // "video" rather than "combined": this is the wire spelling the
        // renderer sends and the one a retry re-sends
        type: "video",
        height: 1080
      }
    })
  })

  test("an audio playlist of one carries its mode and says video, not videos", async () => {
    const { handlers } = createHandlers()

    await handlers.handleDownloadPlaylist(
      null,
      request({
        type: "audio",
        audio_mode: "mp3",
        height: undefined,
        entries: [{ index: 1, id: "aaaaaaaaaaa" }]
      })
    )
    await settle()

    const rows = await handlers.handleGetList(null)

    expect(rows.data.rows[0]).toMatchObject({
      label: "1 video",
      request: { type: "audio", audio_mode: "mp3" }
    })
    expect(rows.data.rows[0].request.height).toBeUndefined()
  })
})

/**
 * the url is what decides the platform, not the label beside it
 *
 * `platform` is an optional field the renderer's own playlist client never
 * sends, so enforcing it alone enforced nothing: a vimeo link with no platform
 * on it reached the engine, which accepts any http(s) host. the host is read
 * off the url itself instead, and the label is still honoured when one is sent.
 */
describe("only a youtube link is a playlist", () => {
  const accepted = [
    ["the canonical playlist url", "https://www.youtube.com/playlist?list=PLLojVvWCZ5N4"],
    ["no www at all", "https://youtube.com/playlist?list=PLLojVvWCZ5N4"],
    ["the mobile site", "https://m.youtube.com/playlist?list=PLLojVvWCZ5N4"],
    ["youtube music", "https://music.youtube.com/playlist?list=PLLojVvWCZ5N4"],
    ["a short link inside a playlist", "https://youtu.be/aaaaaaaaaaa?list=PLLojVvWCZ5N4"]
  ]

  const refused = [
    ["another site entirely", "https://vimeo.com/showcase/123"],
    // the interesting part of a hostname is its end, not whether our word
    // appears somewhere in it
    ["a lookalike that only starts with ours", "https://youtube.com.evil.com/playlist?list=PL1"],
    ["a lookalike that only ends with ours", "https://notyoutube.com/playlist?list=PL1"],
    ["a lookalike of the short domain", "https://myyoutu.be/aaaaaaaaaaa"],
    ["a scheme we never run", "file:///etc/passwd"],
    // the engine refuses this too, one layer later - this only says so sooner
    ["a link with no scheme at all", "youtube.com/playlist?list=PLLojVvWCZ5N4"]
  ]

  test.each(refused)("the listing refuses %s", async (_name, url) => {
    const { handlers, engine } = createHandlers()

    // no platform field: this is exactly what playlistApi sends
    const response = await handlers.handleGetPlaylistInfo(null, { url })

    expect(response.success).toBe(false)
    expect(response.error.category).toBe(ERROR_CATEGORIES.INVALID_URL)
    expect(engine.getPlaylistInfo).not.toHaveBeenCalled()
  })

  test.each(refused)("the download refuses %s", async (_name, url) => {
    const { handlers, engine } = createHandlers()

    const response = await handlers.handleDownloadPlaylist(null, request({ url }))
    await settle()

    expect(response.success).toBe(false)
    expect(response.error.category).toBe(ERROR_CATEGORIES.INVALID_URL)
    expect(engine.run).not.toHaveBeenCalled()
    // nothing was reserved either, so the id stays usable
    expect(handlers.runner.size).toBe(0)
  })

  test.each(accepted)("the listing accepts %s", async (_name, url) => {
    const { handlers, engine } = createHandlers()

    const response = await handlers.handleGetPlaylistInfo(null, { url })

    expect(response.success).toBe(true)
    expect(engine.getPlaylistInfo).toHaveBeenCalledWith(url)
  })

  test.each(accepted)("the download accepts %s", async (_name, url) => {
    const { handlers, engine } = createHandlers()

    const response = await handlers.handleDownloadPlaylist(null, request({ url }))
    await settle()

    expect(response.success).toBe(true)
    expect(engine.run).toHaveBeenCalled()
  })

  test("a youtube label on somebody else's link is still refused", async () => {
    // the label is not evidence: it arrives from the renderer beside the url
    const { handlers, engine } = createHandlers()

    const listing = await handlers.handleGetPlaylistInfo(null, {
      url: "https://vimeo.com/showcase/123",
      platform: "youtube"
    })
    const download = await handlers.handleDownloadPlaylist(
      null,
      request({ url: "https://vimeo.com/showcase/123", platform: "youtube" })
    )
    await settle()

    expect(listing.success).toBe(false)
    expect(download.success).toBe(false)
    expect(engine.getPlaylistInfo).not.toHaveBeenCalled()
    expect(engine.run).not.toHaveBeenCalled()
  })
})
