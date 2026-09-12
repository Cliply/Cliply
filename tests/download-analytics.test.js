/**
 * the download pipeline's telemetry, driven end to end: a real DownloadRunner
 * settling against fake engine handles, through the real ipc translation, into
 * a recording analytics stub. the payload is what those two build *together* -
 * a hand-written property bag would only prove the test's own arithmetic.
 *
 * the second half replays every bag the first half recorded through the real
 * Analytics, because an allowed property name is only half the contract: each
 * value is checked against a kind, and a failing one is dropped behind a
 * console.warn that production never shows anyone.
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

const IPCHandlers = require("../src/main/ipc-handlers")
const { elapsedBucket, speedBucket } = require("../src/main/utils/analytics-helpers")
const { ERROR_CODES } = require("../src/main/services/ytdlp-engine")
const {
  classify,
  ERROR_STAGES,
  ERROR_CATEGORIES
} = require("../src/main/utils/error-taxonomy")

// a stand-in for an engine handle - the same shape download-runner.test.js uses
class FakeHandle extends EventEmitter {
  constructor() {
    super()
    this.cancelled = false
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    // nothing here rejects unobserved
    this.promise.catch(() => {})
  }

  cancel() {
    this.cancelled = true
    return true
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

function engineError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createHandlers({
  hasValidCookies = true,
  // "does the jar hold youtube cookies" is a wider question than "is it a
  // login", and the double used to answer both with the same flag - so a state
  // the real manager cannot produce (a login that holds no youtube cookies)
  // was the one being tested
  hasYouTubeCookies = hasValidCookies,
  importCookieFile
} = {}) {
  const captured = []
  // every download:progress payload main sent, in order. the download flows
  // report through this channel rather than through the ipc reply, so a test
  // that used to read a resolved result reads the events instead
  const events = []

  const cookieManager = {
    hasValidCookies: jest.fn(() => hasValidCookies),
    hasYouTubeCookies: jest.fn(() => hasYouTubeCookies),
    importCookieFile:
      importCookieFile || jest.fn().mockResolvedValue(true)
  }

  const handlers = new IPCHandlers({
    cookieManager,
    ytdlpEngine: {},
    ytdlpUpdater: null,
    settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") },
    analytics: {
      capture: (event, properties) => captured.push({ event, properties })
    }
  })

  handlers.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => events.push({ channel, payload }) }
  }

  return { handlers, captured, events, cookieManager }
}

/**
 * the last download:progress payload for one download, whatever its status
 * @param {Object[]} events - what the mainWindow stub recorded
 * @param {string} downloadId - the id the request carried
 * @returns {Object|undefined} the payload, without the channel around it
 */
function lastEvent(events, downloadId = "download_1") {
  return events
    .filter(({ payload }) => payload.downloadId === downloadId)
    .map(({ payload }) => payload)
    .pop()
}

/**
 * run one download to a terminal state through the real runner
 * @param {Object} handlers - the IPCHandlers under test
 * @param {Object} options - {type, platform, formatId, trimmed, progress}
 * @param {Function} finish - what to do with the handle to end the download
 * @returns {Promise<Object>} the runner's result
 */
async function runDownload(handlers, options, finish) {
  const handle = new FakeHandle()
  const { progress, ...runOptions } = options

  const running = handlers.runner.run({
    downloadId: "download_1",
    title: "A Video",
    createHandle: () => handle,
    ...runOptions
  })

  await settle()

  if (progress !== undefined) {
    handle.emit("progress", { progress })
  }

  finish(handle)
  return running
}

const VIDEO = {
  type: "combined",
  platform: "youtube",
  formatId: "1080p",
  trimmed: false
}

const AUDIO = {
  type: "audio",
  platform: "youtube",
  formatId: "mp3",
  trimmed: false
}

let warn

beforeEach(() => {
  // every drop and every normalisation warns; the suite asserts on silence, so
  // a stray real warning has to be visible to the assertions and to nobody else
  warn = jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("what the taxonomy does with a download failure", () => {
  it("classifies an antivirus kill out of the raw stderr", () => {
    // the engine reads this off stderr at mapError and puts the answer in
    // error.code - the only place the raw text is ever classified
    const fromText = classify(
      "ffmpeg exited with code 137: Killed",
      ERROR_STAGES.POSTPROCESS
    )
    expect(fromText.category).toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)

    // an explicit code we already own wins over pattern guessing, which is
    // what lets this call site trust what the engine decided
    const fromCode = classify(
      { code: "FFMPEG_ERROR", message: "ffmpeg exited with code 137: Killed" },
      ERROR_STAGES.POSTPROCESS
    )
    expect(fromCode.category).toBe(ERROR_CATEGORIES.FFMPEG_ERROR)
  })

  it("cannot classify the wording the engine hands the runner", () => {
    // this is why trackDownloadEvent classifies the code and not the message.
    // error.message is ERROR_METADATA's user-facing wording - the raw stderr
    // stays behind in error.details - and the wording matches almost none of
    // the patterns it was written about
    const unrecognised = [
      "This video isn't available for download.",
      "YouTube changed something the downloader needs to catch up with.",
      "Network interrupted the download.",
      "Not enough disk space to save this download.",
      "Your antivirus stopped the video processor.",
      "The video processor is missing.",
      "Something went wrong while processing the video."
    ]

    for (const message of unrecognised) {
      expect(classify(message, ERROR_STAGES.DOWNLOAD).category).toBe(
        ERROR_CATEGORIES.UNKNOWN_ERROR
      )
    }
  })
})

describe("what a pinterest/tiktok download hands the renderer", () => {
  /**
   * start one simple-platform download through the real ipc handler
   *
   * the invoke resolves at the acknowledgement now, so the run has to be
   * settled from outside it: the caller gets the reply and the handle the
   * engine was asked for, and finishes that handle itself.
   *
   * @param {Object} harness - what createHandlers returned
   * @param {Object} data - what to add to the request payload
   * @returns {Promise<Object>} {response, handle}
   */
  async function startSimpleDownload({ handlers }, data = {}) {
    const handle = new FakeHandle()
    handlers.engine.downloadSimple = jest.fn(() => handle)

    const response = await handlers.handleDownloadCombined(null, {
      url: "https://www.pinterest.com/pin/1/",
      platform: "pinterest",
      download_id: "download_1",
      ...data
    })

    // startDownload defers run() by a setImmediate, so nothing has spawned
    // until this returns
    await settle()

    return { response, handle }
  }

  /**
   * run one simple-platform download to failure through the real ipc handler
   * @param {Object} harness - what createHandlers returned
   * @param {Error} error - what the engine handle rejects with
   * @returns {Promise<Object>} {response, event} - the ack and the failed event
   */
  async function failSimpleDownload(harness, error) {
    const { response, handle } = await startSimpleDownload(harness)

    handle.reject(error)
    await settle()

    return { response, event: lastEvent(harness.events) }
  }

  it("acknowledges the start and reports the failure over the event", async () => {
    // the invoke answers as soon as the id is claimed, exactly as the youtube
    // flows do, and everything the handler used to translate into an ipc error
    // rides the download:progress event the runner emits
    const harness = createHandlers()

    const { response, event } = await failSimpleDownload(
      harness,
      engineError(
        ERROR_CODES.FFMPEG_AV_BLOCKED,
        "Your antivirus stopped the video processor."
      )
    )

    expect(response.success).toBe(true)
    expect(response.data).toEqual({
      download_id: "download_1",
      status: "started",
      type: "combined"
    })

    expect(event.status).toBe("failed")
    // the taxonomy the engine chose at mapError, not the patterns re-run
    // against wording written for a human: that would read UNKNOWN_ERROR
    expect(event.category).toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)
    expect(event.error).toBe("Your antivirus stopped the video processor.")
  })

  it("agrees with the event the runner already sent", async () => {
    // one download must not be one category in posthog and another on the row
    // the user is looking at
    const harness = createHandlers()
    const { captured } = harness

    const { event } = await failSimpleDownload(
      harness,
      engineError(
        ERROR_CODES.DISK_FULL,
        "Not enough disk space to save this download."
      )
    )

    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe("download_failed")
    expect(event.category).toBe(captured[0].properties.error_category)
    expect(event.category).toBe(ERROR_CATEGORIES.DISK_FULL)
  })

  it("still classifies a failure that arrived without a code", async () => {
    /**
     * a throw from outside the engine carries no taxonomy value, and the two
     * readers answer that differently now.
     *
     * the event repeats the code the failure arrived with, so an uncoded one
     * says DOWNLOAD_FAILED. this is what every other download kind has always
     * reported, and the simple platforms only looked different because the
     * handler classified the result itself before answering.
     *
     * analytics is where the patterns still run: trackDownloadEvent hands
     * classify() the code and the wording together, so the funnel keeps the
     * category the wording earns rather than the placeholder.
     */
    const harness = createHandlers()
    const { captured } = harness

    const { event } = await failSimpleDownload(
      harness,
      new Error("ERROR: unable to download webpage: The read operation timed out")
    )

    expect(event.category).toBe("DOWNLOAD_FAILED")
    expect(captured[0].properties.error_category).toBe(
      ERROR_CATEGORIES.NETWORK_ERROR
    )
  })

  it("reports a finished download on the event, not in the reply", async () => {
    // the three fields the old resolved result carried are on the completed
    // event, which is the only place the renderer will look for them once the
    // row lives in the downloads list. the reservation is deleted as that event
    // goes out, so nothing can go back for them afterwards
    const harness = createHandlers()
    jest.spyOn(fs, "statSync").mockReturnValue({ size: 5 })

    const { response, handle } = await startSimpleDownload(harness)

    expect(response.data.status).toBe("started")
    // the run has announced itself and nothing else: the reply went out while
    // the process ran
    expect(lastEvent(harness.events)).toEqual(
      expect.objectContaining({ status: "downloading", indeterminate: true })
    )

    handle.resolve({ filePath: "/downloads/pin.mp4" })
    await settle()

    expect(lastEvent(harness.events)).toEqual(
      expect.objectContaining({
        downloadId: "download_1",
        status: "completed",
        progress: 100,
        filename: "pin.mp4",
        file_path: "/downloads/pin.mp4",
        file_size: 5
      })
    )
  })

  it("parks behind the cap and still answers straight away", async () => {
    // three downloads hold every slot, so the fourth is accepted and queued.
    // the invoke must not wait for a slot: it resolves now, and the row says
    // `queued` until one comes free
    const harness = createHandlers()
    const { handlers } = harness
    const held = []

    for (let index = 0; index < 3; index++) {
      const handle = new FakeHandle()
      held.push(handle)
      handlers.runner.run({
        downloadId: `holding_${index}`,
        type: "combined",
        platform: "youtube",
        title: "A Video",
        createHandle: () => handle
      })
    }
    await settle()

    const { response, handle } = await startSimpleDownload(harness, {
      platform: "tiktok",
      url: "https://www.tiktok.com/@user/video/1"
    })

    expect(response.data).toEqual({
      download_id: "download_1",
      status: "started",
      type: "combined"
    })
    // no process for this one yet, only a place in the line
    expect(handlers.engine.downloadSimple).not.toHaveBeenCalled()
    expect(lastEvent(harness.events)).toEqual(
      expect.objectContaining({ downloadId: "download_1", status: "queued", progress: 0 })
    )

    held[0].resolve({ filePath: "/downloads/a.mp4" })
    await settle()

    expect(handlers.engine.downloadSimple).toHaveBeenCalledTimes(1)

    handle.resolve({ filePath: "/downloads/tik.mp4" })
    held[1].resolve({ filePath: "/downloads/b.mp4" })
    held[2].resolve({ filePath: "/downloads/c.mp4" })
    await settle()
  })

  it("hands the renderer's DownloadStatus[]/DownloadStatus contracts back as declared", async () => {
    // getAllDownloads() reads response.data straight as the array; getStatus()
    // reads it straight as one entry. both used to disagree with what the ipc
    // layer actually sent back
    const harness = createHandlers()
    const { handlers } = harness
    const { handle } = await startSimpleDownload(harness)

    const all = await handlers.handleGetAllDownloads()
    // {epoch, rows}: the rows are the contract, and the epoch says which side
    // of the user's clears they were read on
    expect(all.data.epoch).toBe(0)
    expect(all.data.rows).toEqual([
      expect.objectContaining({
        downloadId: "download_1",
        status: "downloading",
        // a row also carries what it would take to describe and retry it, so a
        // renderer that reloaded mid-download can rebuild the whole list
        label: "pinterest",
        request: { url: "https://www.pinterest.com/pin/1/", platform: "pinterest", title: "video" }
      })
    ])

    const one = await handlers.handleGetDownloadStatus(null, {
      downloadId: "download_1"
    })
    expect(one.data).toEqual(
      expect.objectContaining({ downloadId: "download_1", status: "downloading" })
    )

    handle.resolve({})
  })

  it("never lets an incoming format_id replace tiktok's anti-watermark preset", async () => {
    // 'b' is chosen specifically because yt-dlp scores the non-watermarked
    // stream above the watermarked one for it - a format_id from the ipc
    // payload used to be able to silently override that
    const harness = createHandlers()

    const { handle } = await startSimpleDownload(harness, {
      url: "https://www.tiktok.com/@user/video/1",
      platform: "tiktok",
      format_id: "worst"
    })
    handle.resolve({})

    expect(harness.handlers.engine.downloadSimple).toHaveBeenCalledWith(
      expect.objectContaining({ formatSelector: "b" })
    )
  })
})

/**
 * what a reservation carries for a downloads list
 *
 * `label` is the words beside the title, and `request` is what a retry
 * re-sends: the payload as the renderer spelled it, so it goes back through the
 * same validator rather than through a shape main invented. these are read off
 * download:get-all, which is how a renderer that reloaded mid-download rebuilds
 * its rows.
 */
describe("the request a reservation keeps", () => {
  async function rowFor(handlers) {
    await settle()
    const all = await handlers.handleGetAllDownloads()
    return all.data.rows[0]
  }

  it("a video keeps its quality, its container and everything optional it was sent", async () => {
    const { handlers } = createHandlers()
    const handle = new FakeHandle()
    handlers.engine.downloadCombined = jest.fn(() => handle)

    await handlers.handleDownloadCombined(null, {
      url: "https://youtu.be/abc",
      platform: "youtube",
      download_id: "download_1",
      height: 1080,
      container: "mp4",
      title: "A Video",
      audio_language: "hi",
      time_range: { start: 5, end: 65 },
      precise_cut: true
    })

    expect(await rowFor(handlers)).toMatchObject({
      label: "1080p mp4",
      request: {
        url: "https://youtu.be/abc",
        title: "A Video",
        platform: "youtube",
        height: 1080,
        container: "mp4",
        audio_language: "hi",
        time_range: { start: 5, end: 65 },
        precise_cut: true
      }
    })

    handle.resolve({})
  })

  it("a video that was sent none of the optional fields keeps none of them", async () => {
    // a retry has to re-send the request the user made, not a wider one: a key
    // that was never there must not come back as an explicit undefined
    const { handlers } = createHandlers()
    const handle = new FakeHandle()
    handlers.engine.downloadCombined = jest.fn(() => handle)

    await handlers.handleDownloadCombined(null, {
      url: "https://youtu.be/abc",
      platform: "youtube",
      download_id: "download_1",
      height: 720
    })

    const row = await rowFor(handlers)

    expect(row.label).toBe("720p mp4")
    expect(Object.keys(row.request).sort()).toEqual(["height", "platform", "title", "url"])

    handle.resolve({})
  })

  it("a container we never offered is labelled as the one that gets downloaded", async () => {
    // buildArgs falls back to mp4 for anything outside TIER_CONTAINERS, so a
    // label read straight off the payload would name a file that never existed
    const { handlers } = createHandlers()
    const handle = new FakeHandle()
    handlers.engine.downloadCombined = jest.fn(() => handle)

    await handlers.handleDownloadCombined(null, {
      url: "https://youtu.be/abc",
      platform: "youtube",
      download_id: "download_1",
      height: 1080,
      container: "webm"
    })

    const row = await rowFor(handlers)

    expect(row.label).toBe("1080p mp4")
    // the request is still what the renderer sent: a retry re-sends it and it
    // is normalised again on the way in, exactly as it was this time
    expect(row.request.container).toBe("webm")

    handle.resolve({})
  })

  it("audio keeps the mode, which is also its label", async () => {
    const { handlers } = createHandlers()
    const handle = new FakeHandle()
    handlers.engine.downloadAudio = jest.fn(() => handle)

    await handlers.handleDownloadAudio(null, {
      url: "https://youtu.be/abc",
      download_id: "download_1",
      audio_mode: "mp3",
      title: "A Song"
    })

    expect(await rowFor(handlers)).toMatchObject({
      label: "mp3",
      request: {
        url: "https://youtu.be/abc",
        title: "A Song",
        platform: "youtube",
        audio_mode: "mp3"
      }
    })

    handle.resolve({})
  })
})

describe("download_completed", () => {
  it("reports what was taken", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(captured).toHaveLength(1)
    const [{ event, properties }] = captured
    expect(event).toBe("download_completed")
    expect(properties.platform).toBe("youtube")
    expect(properties.media_type).toBe("video")
    expect(properties.quality).toBe("1080p")
    expect(properties.is_trimmed).toBe(false)
  })

  it("carries a trimmed download's is_trimmed", async () => {
    // the flag lives on the run options, not on the engine result - reading it
    // off the payload the runner sends is the only way it is true here
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, trimmed: true }, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(captured[0].properties.is_trimmed).toBe(true)
  })

  it("carries the audio mode the start event named", async () => {
    // the renderer sends download_started's audio_format straight off
    // request.audio_mode (useAudioDownload in lib/hooks), and main receives
    // that same string as the download's format id (handleDownloadAudio in
    // ipc-handlers.js). so this is the value, not one that merely looks like it
    const { handlers, captured } = createHandlers()

    for (const mode of ["mp3", "m4a", "original"]) {
      await runDownload(handlers, { ...AUDIO, formatId: mode }, (handle) =>
        handle.resolve({ filePath: "/downloads/a.m4a" })
      )
    }

    expect(captured.map((message) => message.properties.audio_format)).toEqual([
      "mp3",
      "m4a",
      "original"
    ])
  })

  it("says nothing about an audio mode a video download never had", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(captured[0].properties).not.toHaveProperty("audio_format")
  })

  it("names the same audio mode whichever way the download ended", async () => {
    // the design writes both terminal events as download_started's properties
    // plus their own, so a schema that is consistent on success and silent on
    // failure would be worse than either answer applied to both
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...AUDIO, formatId: "m4a" }, (handle) =>
      handle.resolve({ filePath: "/downloads/a.m4a" })
    )
    await runDownload(handlers, { ...AUDIO, formatId: "m4a" }, (handle) =>
      handle.reject(engineError(ERROR_CODES.DISK_FULL, "No space left."))
    )

    const [completed, failed] = captured

    expect(completed.event).toBe("download_completed")
    expect(failed.event).toBe("download_failed")
    expect(failed.properties.audio_format).toBe("m4a")
    expect(failed.properties.audio_format).toBe(
      completed.properties.audio_format
    )
  })

  it("says nothing about the title or the file it wrote", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/Users/someone/Movies/My Holiday Video.mp4" })
    )

    const serialised = JSON.stringify(captured[0].properties)
    expect(serialised).not.toContain("My Holiday Video")
    expect(serialised).not.toContain("/Users/someone")
    expect(captured[0].properties).not.toHaveProperty("video_title")
  })
})

describe("how long it took, and how fast", () => {
  const MIB = 1024 * 1024

  /**
   * complete one download against a clock and a file size we control
   * @param {Object} options - {elapsedMs, fileSize}
   * @returns {Promise<Object>} the properties the pipeline built
   */
  async function completeWith({ elapsedMs, fileSize }) {
    const { handlers, captured } = createHandlers()
    let now = 1_600_000_000_000

    // the reservation stamps the start and the completion reads it back, so
    // the clock is the only seam either of these measurements has
    jest.spyOn(Date, "now").mockImplementation(() => now)
    jest.spyOn(fs, "statSync").mockReturnValue({ size: fileSize })

    const handle = new FakeHandle()
    const running = handlers.runner.run({
      downloadId: "download_1",
      ...VIDEO,
      createHandle: () => handle
    })
    await settle()

    now += elapsedMs
    handle.resolve({ filePath: "/downloads/a.mp4" })
    await running

    return captured[0].properties
  }

  describe("elapsedBucket", () => {
    it("splits where a healthy download stops looking healthy", () => {
      // deliberately not even: under a minute is the line between a download
      // that behaved and one that did not, so the resolution is spent there
      const cases = [
        [0, "<5s"],
        [4999, "<5s"],
        [5000, "5-15s"],
        [14999, "5-15s"],
        [15000, "15-60s"],
        [59999, "15-60s"],
        [60000, "1-5 min"],
        [299999, "1-5 min"],
        [300000, "5-15 min"],
        [899999, "5-15 min"],
        [900000, ">15 min"],
        [86400000, ">15 min"]
      ]

      for (const [elapsedMs, label] of cases) {
        expect(elapsedBucket(elapsedMs)).toBe(label)
      }
    })

    it("says nothing about a duration it cannot have measured", () => {
      // a clock that stepped backwards under us, or a reservation that was
      // already gone. "0s" would read as an instant download
      for (const value of [-1, NaN, Infinity, undefined, null, "20000"]) {
        expect(elapsedBucket(value)).toBeNull()
      }
    })
  })

  describe("speedBucket", () => {
    it("splits around what a working connection looks like", () => {
      const cases = [
        [MIB, 2000, "<1 MBps"],
        [10 * MIB, 10000, "1-3 MBps"],
        [30 * MIB, 10000, "3-10 MBps"],
        [200 * MIB, 10000, "10-30 MBps"],
        [500 * MIB, 10000, ">30 MBps"]
      ]

      for (const [bytes, elapsedMs, label] of cases) {
        expect(speedBucket(bytes, elapsedMs)).toBe(label)
      }
    })

    it("says nothing when either half of the sum is missing", () => {
      // a size of zero is a stat that failed, not an empty file - and a
      // duration of zero divides into it to give an infinite speed
      expect(speedBucket(0, 10000)).toBeNull()
      expect(speedBucket(10 * MIB, 0)).toBeNull()
      expect(speedBucket(10 * MIB, -5)).toBeNull()
      expect(speedBucket(NaN, 10000)).toBeNull()
      expect(speedBucket(10 * MIB, NaN)).toBeNull()
    })
  })

  it("reports both against a real download", async () => {
    const properties = await completeWith({
      elapsedMs: 20000,
      fileSize: 100 * MIB
    })

    expect(properties.elapsed_bucket).toBe("15-60s")
    expect(properties.speed_bucket).toBe("3-10 MBps")
    expect(properties.file_size_mb).toBe(100)
  })

  it("still times a download whose size could not be read", async () => {
    // fileSizeOf() returns 0 for a stat that threw. zero megabytes at zero
    // megabytes a second is a measurement of nothing, so neither is claimed -
    // but the clock still ran, and how long it took is still true
    const properties = await completeWith({ elapsedMs: 20000, fileSize: 0 })

    expect(properties.elapsed_bucket).toBe("15-60s")
    expect(properties).not.toHaveProperty("speed_bucket")
    expect(properties).not.toHaveProperty("file_size_mb")
  })

  it("counts from the moment the user asked, not from the spawn", async () => {
    // the reservation is where the wait starts: the ack, the setImmediate and
    // a repair-on-failure engine update are all time the user spent waiting
    const properties = await completeWith({
      elapsedMs: 400000,
      fileSize: 100 * MIB
    })

    expect(properties.elapsed_bucket).toBe("5-15 min")
  })
})

describe("media_type", () => {
  it("is only ever video or audio", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )
    await runDownload(handlers, AUDIO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp3" })
    )
    await runDownload(handlers, VIDEO, (handle) =>
      handle.reject(engineError(ERROR_CODES.NETWORK_ERROR, "Network interrupted the download."))
    )

    expect(captured).toHaveLength(3)
    for (const { properties } of captured) {
      expect(["video", "audio"]).toContain(properties.media_type)
    }
  })

  it("translates the engine's word for a merged download", async () => {
    // the runner says "combined" - an ffmpeg detail meaning two streams were
    // merged - and never "video". the vocabulary refuses the raw term, so a
    // pass-through would drop the property on every video download there is
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(captured[0].properties.media_type).toBe("video")
  })

  it("leaves the value out for a type it does not know", async () => {
    const { handlers, captured } = createHandlers()

    handlers.trackDownloadEvent("download_completed", {
      type: "playlist",
      platform: "youtube"
    })

    // undefined rather than the word itself: an absent value is skipped in
    // silence, where one outside the vocabulary is dropped with a warning
    expect(captured[0].properties.media_type).toBeUndefined()
  })
})

describe("download_failed", () => {
  it("reports the category the engine read off stderr", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 42.4 }, (handle) =>
      handle.reject(
        engineError(
          ERROR_CODES.BOT_DETECTION,
          "YouTube asked us to confirm you're not a bot."
        )
      )
    )

    const [{ event, properties }] = captured
    expect(event).toBe("download_failed")
    expect(properties.error_category).toBe(ERROR_CATEGORIES.BOT_DETECTION)
    expect(properties.error_stage).toBe(ERROR_STAGES.DOWNLOAD)
    expect(properties.error_message).toBe(
      "YouTube asked us to confirm you're not a bot."
    )
    expect(properties.progress_at_failure).toBe(42)
  })

  it("keeps the detail a wording-only classification would lose", async () => {
    // an antivirus kill and a missing processor both read as UNKNOWN_ERROR
    // from their wording alone. the engine already classified the stderr, so
    // the code is what carries the answer here
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.reject(
        engineError(
          ERROR_CODES.FFMPEG_AV_BLOCKED,
          "Your antivirus stopped the video processor."
        )
      )
    )

    expect(captured[0].properties.error_category).toBe(
      ERROR_CATEGORIES.FFMPEG_AV_BLOCKED
    )
  })

  it("falls back to the patterns when the failure carries no code", async () => {
    // createHandle() throwing, or anything that did not come from the engine,
    // arrives without a code - and then the raw message is all there is
    const { handlers, captured } = createHandlers()

    await handlers.runner.run({
      downloadId: "download_2",
      ...VIDEO,
      createHandle: () => {
        throw new Error("OSError: [Errno 28] No space left on device")
      }
    })

    expect(captured[0].properties.error_category).toBe(
      ERROR_CATEGORIES.DISK_FULL
    )
  })

  it("reports how far it got", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 87.6 }, (handle) =>
      handle.reject(engineError(ERROR_CODES.NETWORK_ERROR, "Network interrupted the download."))
    )

    expect(captured[0].properties.progress_at_failure).toBe(88)
  })
})

describe("download_cancelled", () => {
  it("reports what was being taken and how far it got", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 61.2 }, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    expect(captured).toHaveLength(1)
    const [{ event, properties }] = captured
    expect(event).toBe("download_cancelled")
    expect(properties.platform).toBe("youtube")
    expect(properties.media_type).toBe("video")
    expect(properties.progress_at_cancel).toBe(61)
  })

  it("carries neither quality nor is_trimmed", async () => {
    // the cancel taxonomy lists three properties. sending a fourth would drop
    // it behind a warning production never surfaces, so it is not sent
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, trimmed: true }, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    expect(captured[0].properties).not.toHaveProperty("quality")
    expect(captured[0].properties).not.toHaveProperty("is_trimmed")
  })

  it("fires for a cancel that lands before the engine is spawned", async () => {
    // the reservation window: acknowledged to the renderer, not yet running
    const { handlers, captured } = createHandlers()

    handlers.runner.reserve("download_1", {
      type: "audio",
      platform: "youtube",
      title: "A Video"
    })
    handlers.runner.cancel("download_1")

    await handlers.runner.run({
      downloadId: "download_1",
      ...AUDIO,
      createHandle: () => new FakeHandle()
    })

    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe("download_cancelled")
    expect(captured[0].properties.media_type).toBe("audio")
    expect(captured[0].properties.progress_at_cancel).toBe(0)
  })

  it("does not also report a failure", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    expect(captured.map((entry) => entry.event)).toEqual(["download_cancelled"])
  })
})

/**
 * a playlist is one download of n videos, so it is the same four events with
 * the run's own arithmetic added.
 *
 * two things make it its own block. a playlist that saved most of its videos
 * **exits 1** and is still a completion, so the interesting case is a success
 * carrying a non-zero skip count rather than a failure; and the counts arrive on
 * the engine's result or on the error it rejected with, which is a different
 * source from every other property here.
 *
 * `quality` is the ceiling the user picked for the whole playlist and stays
 * exactly that: yt-dlp applies it per video and a 480p video under a 1080p
 * ceiling comes down at 480p, so a per-video outcome here would be several
 * answers to a question with one.
 */
describe("a playlist's terminal events", () => {
  const PLAYLIST = { ...VIDEO, playlist: true }
  const PLAYLIST_AUDIO = { ...AUDIO, formatId: "m4a", playlist: true }

  /** an engine result or rejection carrying what the run managed */
  const withItems = (counts = {}) => ({
    filePath: "/downloads/list/001 - a.mp4",
    files: ["/downloads/list/001 - a.mp4"],
    itemsSaved: 8,
    itemsReused: 2,
    itemsSkipped: 1,
    itemsTotal: 11,
    ...counts
  })

  /** the same counts hung on a rejection, the way the engine attaches them */
  function failure(code, message, counts = {}) {
    const error = engineError(code, message)
    return Object.assign(error, withItems(counts))
  }

  it("reports a completion as one download of n videos", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, PLAYLIST, (handle) =>
      handle.resolve(withItems({ itemsSaved: 11, itemsReused: 0, itemsSkipped: 0 }))
    )

    expect(captured).toHaveLength(1)
    const [{ event, properties }] = captured

    expect(event).toBe("download_completed")
    expect(properties).toMatchObject({
      platform: "youtube",
      media_type: "video",
      // the ceiling that was asked for, not what any one video came down at
      quality: "1080p",
      is_trimmed: false,
      is_playlist: true,
      items_saved: 11,
      items_reused: 0,
      items_skipped: 0,
      items_total: 11
    })
  })

  it("keeps a partial run a completion, and says what it skipped", async () => {
    // the design's own case: eight of nine saved is a success that exits 1, and
    // reporting it as download_failed would put every partial playlist in the
    // failure funnel
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, PLAYLIST, (handle) =>
      handle.resolve(
        withItems({ itemsSaved: 8, itemsReused: 0, itemsSkipped: 1, itemsTotal: 9 })
      )
    )

    expect(captured.map((entry) => entry.event)).toEqual(["download_completed"])
    expect(captured[0].properties.items_skipped).toBe(1)
    expect(captured[0].properties.items_saved).toBe(8)
  })

  it("counts an archive reuse as itself and never as a save", async () => {
    // "3 saved, 2 already downloaded" is what the user is told, and adding the
    // two together here would claim saves this run did not make
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, PLAYLIST, (handle) =>
      handle.resolve(
        withItems({ itemsSaved: 3, itemsReused: 2, itemsSkipped: 0, itemsTotal: 5 })
      )
    )

    expect(captured[0].properties.items_saved).toBe(3)
    expect(captured[0].properties.items_reused).toBe(2)
  })

  it("reports what a failed run had already saved", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...PLAYLIST, progress: 42.4 }, (handle) =>
      handle.reject(
        failure(ERROR_CODES.NETWORK_ERROR, "Network lost.", {
          itemsSaved: 3,
          itemsTotal: 9
        })
      )
    )

    expect(captured[0].event).toBe("download_failed")
    expect(captured[0].properties).toMatchObject({
      is_playlist: true,
      items_saved: 3,
      items_total: 9,
      progress_at_failure: 42
    })
  })

  /**
   * a failure knows what it saved and what it was asked for, and nothing else.
   *
   * the engine hangs its whole tally on the rejection, so the skip count is
   * right there to be forwarded - and it would be a guess: a run that broke
   * halfway never reached the videos behind the break, and calling those
   * "skipped" is a different claim from "we did not get to them". so the event
   * does not declare it, and the boundary is what makes that stick.
   */
  it("does not report a skip count a failure cannot know", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, PLAYLIST, (handle) =>
      handle.reject(failure(ERROR_CODES.NETWORK_ERROR, "Network lost."))
    )

    expect(captured[0].properties).not.toHaveProperty("items_skipped")
    expect(captured[0].properties).not.toHaveProperty("items_reused")
  })

  it("reports what a cancelled run left on disk", async () => {
    // a cancel is a kill, and the videos it had already finished are still
    // there. reporting nothing saved would be untrue of the files
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...PLAYLIST, progress: 55.5 }, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(
        failure(ERROR_CODES.CANCELLED, "Download cancelled.", {
          itemsSaved: 6,
          itemsTotal: 9
        })
      )
    })

    expect(captured.map((entry) => entry.event)).toEqual(["download_cancelled"])
    expect(captured[0].properties).toMatchObject({
      is_playlist: true,
      items_saved: 6,
      items_total: 9,
      progress_at_cancel: 56
    })
  })

  it("says it was a playlist even when nothing ever counted one", async () => {
    // the reservation is what knows: a run refused before the engine wrote its
    // record rejects with no tally at all, and it is a playlist all the same
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, PLAYLIST, (handle) =>
      handle.reject(engineError(ERROR_CODES.PERMISSION_ERROR, "Cannot write."))
    )

    expect(captured[0].properties.is_playlist).toBe(true)
    expect(captured[0].properties).not.toHaveProperty("items_saved")
    expect(captured[0].properties).not.toHaveProperty("items_total")
  })

  it("leaves a single video's events exactly as they were", async () => {
    // is_playlist is absent rather than false: every existing event keeps the
    // properties it has always had, and a schema change on the single-video
    // funnel is not what this ticket asked for
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )
    await runDownload(handlers, VIDEO, (handle) =>
      handle.reject(engineError(ERROR_CODES.NETWORK_ERROR, "Network lost."))
    )
    await runDownload(handlers, VIDEO, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    for (const { properties } of captured) {
      expect(properties).not.toHaveProperty("is_playlist")
      for (const key of [
        "item_count",
        "items_saved",
        "items_reused",
        "items_skipped",
        "items_total"
      ]) {
        expect(properties).not.toHaveProperty(key)
      }
    }
  })

  it("says nothing about the folder it wrote or the videos in it", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, PLAYLIST, (handle) =>
      handle.resolve({
        filePath: "/Users/someone/Movies/Short talks [PL123]/001 - My Holiday Video.mp4",
        files: [
          "/Users/someone/Movies/Short talks [PL123]/001 - My Holiday Video.mp4"
        ],
        itemsSaved: 1,
        itemsReused: 0,
        itemsSkipped: 0,
        itemsTotal: 1
      })
    )

    const serialised = JSON.stringify(captured[0].properties)
    expect(serialised).not.toContain("My Holiday Video")
    expect(serialised).not.toContain("Short talks")
    expect(serialised).not.toContain("/Users/someone")
    expect(serialised).not.toContain("PL123")
  })

  /**
   * the one existing property a playlist could not honestly keep.
   *
   * `fileSize` is read off the file the result named, and for a playlist that is
   * whichever video landed LAST (the result YtdlpOperation assembles in
   * ytdlp/operation.js). so file_size_mb would report one video out of eleven,
   * and speed_bucket would divide that one file's bytes by the time all
   * eleven took - a speed nothing experienced.
   * both are the properties the single-video funnel is measured by, so sending
   * them would not just be unreadable, it would move the existing averages.
   *
   * elapsed_bucket stays, because how long the run took is the same question
   * whether the run held one video or eleven.
   */
  it("reports no file size or speed for a run of many files", async () => {
    const { handlers, captured } = createHandlers()

    /**
     * the clock is controlled for the same reason the measurement tests above
     * control it: `elapsed_bucket` is the difference between the reservation
     * and the completion, and elapsedBucket() deliberately returns nothing for
     * a negative one. a machine that stepped its clock backwards mid-test would
     * otherwise fail the one assertion here that is about a property being
     * PRESENT, which is the assertion a wall clock cannot support.
     */
    let now = 1_600_000_000_000
    jest.spyOn(Date, "now").mockImplementation(() => now)
    jest.spyOn(fs, "statSync").mockReturnValue({ size: 4 * 1024 * 1024 })

    await runDownload(handlers, PLAYLIST, (handle) => {
      now += 30_000
      handle.resolve(withItems({ itemsSaved: 11, itemsReused: 0, itemsSkipped: 0 }))
    })

    const { properties } = captured[0]

    expect(properties).not.toHaveProperty("file_size_mb")
    expect(properties).not.toHaveProperty("speed_bucket")
    // ...and a real label rather than merely "defined", since the clock now
    // says exactly how long the run took
    expect(properties.elapsed_bucket).toBe("15-60s")
    expect(properties.items_saved).toBe(11)
  })

  // the other half of that decision is already pinned above: "reports both
  // against a real download" drives a single video against a controlled clock
  // and asserts both properties, and nothing here changed that path

  it("carries the audio mode an audio playlist ran with", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, PLAYLIST_AUDIO, (handle) =>
      handle.resolve(withItems({ itemsSaved: 11, itemsReused: 0, itemsSkipped: 0 }))
    )

    expect(captured[0].properties).toMatchObject({
      media_type: "audio",
      quality: "m4a",
      audio_format: "m4a",
      is_playlist: true
    })
  })
})

// the text route was deleted: nothing in the renderer ever called it, and its
// channel was exposed over ipc for no one. These now go through the picker,
// which is the only way a user imports anything
async function pickAndImport(handlers) {
  const { dialog } = require("electron")

  dialog.showOpenDialog.mockResolvedValue({
    canceled: false,
    filePaths: ["/Users/someone/cookies.txt"]
  })

  return handlers.handleImportCookieFile(null)
}

describe("cookies_imported", () => {
  it("reports a text import and whether the jar holds youtube cookies", async () => {
    const { handlers, captured } = createHandlers({ hasValidCookies: true })

    await pickAndImport(handlers)

    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe("cookies_imported")
    expect(captured[0].properties).toEqual({
      success: true,
      has_youtube_cookies: true,
      signed_in: true
    })
  })

  it("reports a jar that imported without any youtube cookies in it", async () => {
    const { handlers, captured } = createHandlers({ hasValidCookies: false })

    await pickAndImport(handlers)

    expect(captured[0].properties).toEqual({
      success: true,
      has_youtube_cookies: false,
      signed_in: false
    })
  })

  // the state the funnel most needs to see, and the one the old payload could
  // not express: the file imported fine and simply was not a login. success and
  // has_youtube_cookies were both the signed-in flag, so this looked identical
  // to a jar that failed to import at all
  it("tells a signed-out youtube jar from a failed import", async () => {
    const { handlers, captured } = createHandlers({
      hasValidCookies: false,
      hasYouTubeCookies: true
    })

    await pickAndImport(handlers)

    expect(captured[0].properties).toEqual({
      success: true,
      has_youtube_cookies: true,
      signed_in: false
    })
  })

  it("reports an import that failed", async () => {
    const { handlers, captured } = createHandlers({
      hasValidCookies: false,
      importCookieFile: jest
        .fn()
        .mockRejectedValue(new Error("not a cookie file"))
    })

    const result = await pickAndImport(handlers)

    expect(result.success).toBe(false)
    expect(captured[0].properties.success).toBe(false)
  })

  it("reports a file import the same way a text import is reported", async () => {
    const { handlers, captured } = createHandlers()
    const { dialog } = require("electron")

    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/Users/someone/cookies.txt"]
    })

    await handlers.handleImportCookieFile(null)

    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe("cookies_imported")
    expect(captured[0].properties.success).toBe(true)
    // the path the user picked is not part of the question being answered
    expect(JSON.stringify(captured[0].properties)).not.toContain("someone")
  })

  it("says nothing when the user cancels the file picker", async () => {
    const { handlers, captured } = createHandlers()
    const { dialog } = require("electron")

    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    await handlers.handleImportCookieFile(null)

    expect(captured).toHaveLength(0)
  })
})

describe("an analytics service that throws", () => {
  /**
   * the exit point guards itself, so a throw out of capture() means the
   * collaborator is not the one we think it is. it must still not reach the
   * caller: trackCookieImport sits *inside* handleImportCookieFile's try, where a
   * throw is caught as the import failing - the user is told a jar that
   * imported did not, and the failure path then reports the opposite of what
   * happened to analytics as well.
   */
  const HOSTILE_THROWS = [
    ["an Error", () => new Error("posthog exploded")],
    ["null", () => null],
    [
      "an object whose message getter throws",
      () => ({
        get message() {
          throw new Error("not even this")
        }
      })
    ]
  ]

  function throwingHandlers(thrown) {
    return new IPCHandlers({
      cookieManager: {
        hasValidCookies: jest.fn(() => true),
        hasYouTubeCookies: jest.fn(() => true),
        importCookieFile: jest.fn().mockResolvedValue(true)
      },
      ytdlpEngine: {},
      ytdlpUpdater: null,
      settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") },
      analytics: {
        capture: () => {
          throw thrown()
        }
      }
    })
  }

  it.each(HOSTILE_THROWS)(
    "still reports the cookie import that really happened (%s)",
    async (_name, thrown) => {
      const handlers = throwingHandlers(thrown)

      const result = await pickAndImport(handlers)

      expect(result.success).toBe(true)
      expect(result.data.hasValidCookies).toBe(true)
    }
  )

  it.each(HOSTILE_THROWS)(
    "still finishes the download it was reporting on (%s)",
    async (_name, thrown) => {
      const handlers = throwingHandlers(thrown)

      const result = await runDownload(handlers, VIDEO, (handle) =>
        handle.resolve({ filePath: "/downloads/a.mp4" })
      )

      expect(result.success).toBe(true)
    }
  )
})

describe("describeError", () => {
  // the one guard the three telemetry call sites share. `error.message` is a
  // property read, and a property read can throw - which is why this is a
  // function rather than the same expression written out three times
  const { describeError } = require("../src/main/utils/analytics-helpers")

  it("describes an ordinary failure by its message", () => {
    expect(describeError(new Error("posthog exploded"))).toBe(
      "posthog exploded"
    )
  })

  it("describes what a throw site produced instead of an error", () => {
    expect(describeError("posthog exploded")).toBe("posthog exploded")
    expect(describeError(null)).toBe("null")
    expect(describeError(undefined)).toBe("undefined")
    expect(describeError(42)).toBe("42")
  })

  it("survives a value that refuses to be read", () => {
    const hostile = {
      get message() {
        throw new Error("not even this")
      },
      toString() {
        throw new Error("no string either")
      }
    }

    expect(describeError(hostile)).toBe("unknown error")
    // a symbol is the other half: String() on one throws
    expect(describeError(Symbol("posthog"))).toEqual(expect.any(String))
  })
})

describe("a missing analytics service", () => {
  it("leaves the download pipeline working", async () => {
    const handlers = new IPCHandlers({
      cookieManager: { hasValidCookies: () => true },
      ytdlpEngine: {},
      ytdlpUpdater: null,
      settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") }
    })

    const result = await runDownload(handlers, VIDEO, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    expect(result.success).toBe(true)
  })
})

/**
 * everything above records into a stub, which accepts any bag at all. these
 * replay the exact bags the pipeline builds through the real Analytics: silence
 * on console.warn is the assertion, because the module warns on every drop and
 * every normalisation.
 */
describe("the download payloads survive the real validator", () => {
  const { Analytics: RealAnalytics } = jest.requireActual(
    "../src/main/services/analytics"
  )

  async function replay(captured) {
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

    for (const { event, properties } of captured) {
      real.capture(event, properties)
    }

    return sent
  }

  it("sends a completion whole", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, trimmed: true }, (handle) =>
      handle.resolve({ filePath: "/downloads/a.mp4" })
    )

    const [message] = await replay(captured)

    expect(message.event).toBe("download_completed")
    expect(message.properties).toMatchObject({
      platform: "youtube",
      media_type: "video",
      quality: "1080p",
      is_trimmed: true
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every audio mode either terminal event can carry", async () => {
    // audio_format is a vocabulary, so a mode the schema does not list is
    // dropped behind a warning nobody sees in production. these are the three
    // the audio flow can produce, on both ways a download can end
    const { handlers, captured } = createHandlers()

    for (const mode of ["mp3", "m4a", "original"]) {
      await runDownload(handlers, { ...AUDIO, formatId: mode }, (handle) =>
        handle.resolve({ filePath: "/downloads/a.m4a" })
      )
      await runDownload(handlers, { ...AUDIO, formatId: mode }, (handle) =>
        handle.reject(engineError(ERROR_CODES.NETWORK_ERROR, "Network lost."))
      )
    }

    const sent = await replay(captured)

    expect(
      sent.map((message) => [message.event, message.properties.audio_format])
    ).toEqual([
      ["download_completed", "mp3"],
      ["download_failed", "mp3"],
      ["download_completed", "m4a"],
      ["download_failed", "m4a"],
      ["download_completed", "original"],
      ["download_failed", "original"]
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every bucket label the two measurements can produce", async () => {
    // the bucket grammar takes a leading digit or comparison, an optional
    // range and a unit of at most four letters. every label written by hand is
    // a chance to break one of those, and a broken one is a silent drop
    const MIB = 1024 * 1024
    const { handlers, captured } = createHandlers()

    let now = 1_600_000_000_000
    jest.spyOn(Date, "now").mockImplementation(() => now)

    // a duration from each elapsed bucket, paired with a size that walks the
    // speed buckets across them
    const runs = [
      { elapsedMs: 1000, fileSize: 20 * MIB },
      { elapsedMs: 10000, fileSize: 5 * MIB },
      { elapsedMs: 30000, fileSize: 60 * MIB },
      { elapsedMs: 120000, fileSize: 5000 * MIB },
      { elapsedMs: 600000, fileSize: 10 * MIB },
      { elapsedMs: 1200000, fileSize: 1 * MIB }
    ]

    for (const [index, run] of runs.entries()) {
      jest.spyOn(fs, "statSync").mockReturnValue({ size: run.fileSize })

      const handle = new FakeHandle()
      const running = handlers.runner.run({
        downloadId: `download_${index}`,
        ...VIDEO,
        createHandle: () => handle
      })
      await settle()

      now += run.elapsedMs
      handle.resolve({ filePath: "/downloads/a.mp4" })
      await running
    }

    const sent = await replay(captured)

    expect(sent.map((message) => message.properties.elapsed_bucket)).toEqual([
      "<5s",
      "5-15s",
      "15-60s",
      "1-5 min",
      "5-15 min",
      ">15 min"
    ])
    expect(sent.map((message) => message.properties.speed_bucket)).toEqual([
      "10-30 MBps",
      "<1 MBps",
      "1-3 MBps",
      ">30 MBps",
      "<1 MBps",
      "<1 MBps"
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends a failure whole", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 42.4 }, (handle) =>
      handle.reject(
        engineError(
          ERROR_CODES.BOT_DETECTION,
          "YouTube asked us to confirm you're not a bot."
        )
      )
    )

    const [message] = await replay(captured)

    expect(message.properties).toMatchObject({
      error_category: ERROR_CATEGORIES.BOT_DETECTION,
      error_stage: ERROR_STAGES.DOWNLOAD,
      progress_at_failure: 42
    })
    expect(message.properties.error_message).toBe(
      "YouTube asked us to confirm you're not a bot."
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends nothing identifying when the failure was not the engine's", async () => {
    // the engine's own wording is fixed and safe, which is exactly why a
    // replay built only from it proves nothing. this is the other half: a
    // throw from outside the engine, whose message nobody wrote for telemetry
    const home = require("os").homedir()
    const { handlers, captured } = createHandlers()

    await handlers.runner.run({
      downloadId: "download_9",
      ...VIDEO,
      createHandle: () => {
        throw new Error(
          `ENOENT: no such file or directory, open '${home}/Movies/My Holiday Video.mp4'`
        )
      }
    })

    const [message] = await replay(captured)
    const text = message.properties.error_message

    expect(text).not.toContain(home)
    expect(text).not.toContain("Holiday")
    expect(text).not.toContain(".mp4")
    // still a usable failure, which is the whole reason free text is sent
    expect(text).toContain("no such file or directory")
    expect(message.properties.error_category).toBe(ERROR_CATEGORIES.PATH_ERROR)
  })

  it("sends a cancel whole", async () => {
    const { handlers, captured } = createHandlers()

    await runDownload(handlers, { ...VIDEO, progress: 61.2 }, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(engineError(ERROR_CODES.CANCELLED, "Download cancelled."))
    })

    const [message] = await replay(captured)

    expect(message.properties).toMatchObject({
      platform: "youtube",
      media_type: "video",
      progress_at_cancel: 61
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends a playlist's four terminal states whole", async () => {
    // the half the allowlist decides. every count here is registered for the
    // event that carries it, so silence on console.warn is the assertion: a
    // property added at the runner and forgotten in ALLOWED_PROPERTIES leaves
    // no data and no error, only this warning nobody in production ever reads
    const { handlers, captured } = createHandlers()
    const PLAYLIST = { ...VIDEO, playlist: true }

    const items = {
      files: ["/downloads/list/001 - a.mp4"],
      itemsSaved: 8,
      itemsReused: 2,
      itemsSkipped: 1,
      itemsTotal: 11
    }

    // completed, including the partial run that exits 1 and is still a success
    await runDownload(handlers, PLAYLIST, (handle) =>
      handle.resolve({ filePath: "/downloads/list/001 - a.mp4", ...items })
    )

    // completed with nothing skipped, which is the ordinary case
    await runDownload(handlers, PLAYLIST, (handle) =>
      handle.resolve({
        filePath: "/downloads/list/001 - a.mp4",
        ...items,
        itemsSaved: 11,
        itemsReused: 0,
        itemsSkipped: 0
      })
    )

    // failed with files already on disk
    await runDownload(handlers, { ...PLAYLIST, progress: 42.4 }, (handle) =>
      handle.reject(
        Object.assign(engineError(ERROR_CODES.NETWORK_ERROR, "Network lost."), items)
      )
    )

    // cancelled, same
    await runDownload(handlers, { ...PLAYLIST, progress: 55.5 }, (handle) => {
      handlers.runner.cancel("download_1")
      handle.reject(
        Object.assign(
          engineError(ERROR_CODES.CANCELLED, "Download cancelled."),
          items
        )
      )
    })

    // and an audio playlist, whose quality is the mode rather than a height
    await runDownload(
      handlers,
      { ...AUDIO, formatId: "original", playlist: true },
      (handle) =>
        handle.resolve({ filePath: "/downloads/list/001 - a.m4a", ...items })
    )

    const sent = await replay(captured)

    expect(sent.map((message) => message.event)).toEqual([
      "download_completed",
      "download_completed",
      "download_failed",
      "download_cancelled",
      "download_completed"
    ])

    for (const message of sent) {
      expect(message.properties.is_playlist).toBe(true)
      expect(message.properties.items_saved).toBeDefined()
      expect(message.properties.items_total).toBe(11)
    }

    // the two the completion declares and the terminal pair does not
    expect(sent[0].properties.items_skipped).toBe(1)
    expect(sent[0].properties.items_reused).toBe(2)
    expect(sent[2].properties).not.toHaveProperty("items_skipped")
    expect(sent[3].properties).not.toHaveProperty("items_skipped")

    expect(warn).not.toHaveBeenCalled()
  })

  it("sends a playlist start whole, the way the renderer builds it", async () => {
    // the one playlist event the renderer owns. it is recorded off the real hook
    // in analyticsCallSites.test.tsx and replayed from the fixture by
    // renderer-analytics.test.js; this is the same bag against this suite's
    // validator, so a start that stops being sendable fails here too
    const { handlers, captured } = createHandlers()

    handlers.capture("download_started", {
      platform: "youtube",
      media_type: "video",
      quality: "1080p",
      is_trimmed: false,
      is_playlist: true,
      item_count: 9
    })

    const [message] = await replay(captured)

    expect(message.properties).toMatchObject({
      is_playlist: true,
      item_count: 9,
      quality: "1080p"
    })
    expect(warn).not.toHaveBeenCalled()
  })

  // the dimension the cookie measurement rests on. an undeclared property is
  // dropped behind a warning nothing surfaces in production, so a schema that
  // had not been told about it would have silently discarded the answer
  it("sends a lookup failure's cookie flag whole", async () => {
    const { handlers, captured } = createHandlers({ hasValidCookies: true })

    await handlers.handleAnalyticsTrack(null, {
      event: "media_info_failed",
      properties: { platform: "youtube", error_category: "BOT_DETECTION" }
    })

    const [message] = await replay(captured)

    expect(message.properties.used_cookies).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends a cookie import whole", async () => {
    const { handlers, captured } = createHandlers({ hasValidCookies: false })

    await pickAndImport(handlers)

    const [message] = await replay(captured)

    expect(message.properties).toMatchObject({
      success: true,
      has_youtube_cookies: false,
      signed_in: false
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it("says nothing about a media type it could not name", async () => {
    const { handlers, captured } = createHandlers()

    handlers.trackDownloadEvent("download_completed", {
      type: "playlist",
      platform: "youtube",
      formatId: "1080p"
    })

    const [message] = await replay(captured)

    expect(message.properties).not.toHaveProperty("media_type")
    expect(message.properties.quality).toBe("1080p")
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every quality the download flows can produce", async () => {
    // the format ids the three flows really pass: a picked height for youtube
    // video, an audio mode for youtube audio, and the platform name itself for
    // the flows that never offer a choice
    const { handlers, captured } = createHandlers()

    const flows = [
      { ...VIDEO, formatId: "2160p" },
      { ...VIDEO, formatId: "144p" },
      { ...AUDIO, formatId: "mp3" },
      { ...AUDIO, formatId: "m4a" },
      { ...AUDIO, formatId: "original" },
      { ...VIDEO, platform: "pinterest", formatId: "pinterest" },
      { ...VIDEO, platform: "tiktok", formatId: "tiktok" },
      // the runner's own default, for a flow that passed no format at all
      { ...VIDEO, formatId: "unknown" }
    ]

    for (const flow of flows) {
      await runDownload(handlers, flow, (handle) =>
        handle.resolve({ filePath: "/downloads/a.mp4" })
      )
    }

    const sent = await replay(captured)

    expect(sent).toHaveLength(flows.length)
    for (const message of sent) {
      expect(message.properties.quality).toBeDefined()
      expect(message.properties.platform).not.toBe("unsupported")
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it("sends every category the engine can hand the runner", async () => {
    const { handlers, captured } = createHandlers()

    for (const code of Object.values(ERROR_CATEGORIES)) {
      if (code === ERROR_CATEGORIES.CANCELLED) continue

      await runDownload(handlers, VIDEO, (handle) =>
        handle.reject(engineError(code, "something went wrong"))
      )
    }

    const sent = await replay(captured)

    expect(sent.length).toBe(Object.values(ERROR_CATEGORIES).length - 1)
    for (const message of sent) {
      expect(message.properties.error_category).toBeDefined()
    }
    expect(warn).not.toHaveBeenCalled()
  })
})

/**
 * whether the cookies actually helped
 *
 * cookies_imported alone cannot answer that. It says who imported, once, and
 * never expires - so a jar youtube rotated out weeks ago still reads as an
 * import. The measurement is the refusal rate on installs that are signed in
 * versus installs that are not, which needs the flag on the *failures*.
 *
 * this is the hole the po token rollout fell into: shipped, and then no way to
 * tell whether it changed anything.
 */
describe("used_cookies", () => {
  const jarState = (signedIn) => ({
    hasValidCookies: jest.fn(() => signedIn),
    hasYouTubeCookies: jest.fn(() => signedIn),
    importCookieFile: jest.fn().mockResolvedValue(true)
  })

  function handlersFor(signedIn) {
    const captured = []

    const handlers = new IPCHandlers({
      cookieManager: jarState(signedIn),
      ytdlpEngine: {},
      ytdlpUpdater: null,
      settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") },
      analytics: {
        capture: (event, properties) => captured.push({ event, properties })
      }
    })

    return { handlers, captured }
  }

  test.each([[true], [false]])(
    "a youtube lookup failure records signed-in as %s",
    async (signedIn) => {
      const { handlers, captured } = handlersFor(signedIn)

      await handlers.handleAnalyticsTrack(null, {
        event: "media_info_failed",
        properties: { platform: "youtube", error_category: "BOT_DETECTION" }
      })

      expect(captured[0].properties.used_cookies).toBe(signedIn)
    }
  )

  // the lookup is where roughly three quarters of bot detection lands, so this
  // is the event the whole measurement rests on
  test("the renderer does not get to claim it", async () => {
    const { handlers, captured } = handlersFor(false)

    await handlers.handleAnalyticsTrack(null, {
      event: "media_info_failed",
      properties: { platform: "youtube", used_cookies: true }
    })

    expect(captured[0].properties.used_cookies).toBe(false)
  })

  // a column that means nothing invites a comparison that is not there
  test.each([["pinterest"], ["tiktok"]])(
    "a %s failure carries no cookie flag at all",
    async (platform) => {
      const { handlers, captured } = handlersFor(true)

      await handlers.handleAnalyticsTrack(null, {
        event: "media_info_failed",
        properties: { platform, error_category: "BOT_DETECTION" }
      })

      expect(captured[0].properties).not.toHaveProperty("used_cookies")
    }
  )

  test("a cookie manager that throws does not take the event down with it", async () => {
    const { handlers, captured } = handlersFor(false)
    handlers.cookieManager.hasValidCookies = jest.fn(() => {
      throw new Error("unreadable jar")
    })

    await handlers.handleAnalyticsTrack(null, {
      event: "media_info_failed",
      properties: { platform: "youtube" }
    })

    expect(captured).toHaveLength(1)
    expect(captured[0].properties).not.toHaveProperty("used_cookies")
  })
})
