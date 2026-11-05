jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn(), removeAllListeners: jest.fn() },
  dialog: {}, app: { getVersion: () => "1.2.3" }, shell: {}
}))

const { EventEmitter } = require("events")
const { PassThrough } = require("stream")
const IPCHandlers = require("../src/main/ipc-handlers")
const { normalizeInstagramUrl } = require("../src/main/utils/instagram-url")
const { getSimplePlatformOptions, isSimplePlatform } = require("../src/main/utils/ytdlp-formats")
const { YtdlpEngine, buildArgs, mapError, ERROR_CODES } = require("../src/main/services/ytdlp-engine")
const { extractQuality } = require("../src/main/utils/analytics-helpers")

const URL = "https://www.instagram.com/reel/Example_123/"
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("Instagram URL boundary", () => {
  test.each([
    "instagram.com/reel/Example_123/",
    "https://www.instagram.com/reels/Example-123/?igsh=share&utm_source=copy",
    "https://instagram.com/p/Example123",
    "https://instagram.com/tv/Example123/",
    "https://instagram.com/example.name/reel/Example123/"
  ])("accepts %s", (url) => expect(normalizeInstagramUrl(url)).toMatch(/^https:\/\//))

  test.each([
    "https://instagram.com.evil.test/reel/Example/", "https://evilinstagram.com/p/Example/",
    "https://instagram.com@evil.test/reel/Example/", "https://evil@instagram.com/p/Example/",
    "https://instagram.com:444/p/Example/", "ftp://instagram.com/p/Example/",
    "https://instagram.com/stories/example/123/", "https://instagram.com/example/",
    "https://instagram.com/share/reel/Example/", "https://instagram.com/reels/audio/123/",
    "https://instagr.am/p/Example/", "https://instagram.com/p/Example/extra",
    "https://instagram.com/p/Example%2Fother/", "--exec=command", null
  ])("refuses %s", (url) => expect(normalizeInstagramUrl(url)).toBeNull())
})

describe("Instagram upstream delegation", () => {
  test("download keeps upstream format defaults and rejects collections", () => {
    const preset = getSimplePlatformOptions("instagram")
    const args = buildArgs("simple", { ...preset, platform: "instagram", url: URL, outputDir: "/tmp" })
    expect(isSimplePlatform("instagram")).toBe(true)
    expect(extractQuality("instagram")).toBe("best_available")
    for (const flag of ["-f", "-S", "-t", "--extractor-args", "--merge-output-format", "--cookies"]) {
      expect(args).not.toContain(flag)
    }
    expect(args).toContain("--ignore-config")
    expect(args.slice(args.indexOf("--break-match-filters"), args.indexOf("--break-match-filters") + 2))
      .toEqual(["--break-match-filters", "!playlist"])
  })

  test("metadata retains the collection envelope and allows empty photo formats", () => {
    const args = buildArgs("info", { url: URL, platform: "instagram" })
    expect(args).toEqual(expect.arrayContaining(["--dump-single-json", "--flat-playlist", "--ignore-no-formats-error"]))
    expect(args).not.toContain("--dump-json")
  })

  test("engine scopes authentication, parses collections and propagates filter refusal", async () => {
    const children = []
    const calls = []
    const engine = new YtdlpEngine({
      userDataPath: "/tmp/cliply-instagram-unit",
      resourcesPath: "/tmp/cliply-instagram-unit",
      ffmpegPath: "/fake/ffmpeg", denoPath: "/fake/deno", potEnabled: true,
      spawnFn: (_binary, args) => {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = jest.fn()
        calls.push(args)
        children.push(child)
        return child
      }
    })
    const info = engine.getInfo(URL, { platform: "instagram", cookieFile: "/private/youtube.txt" })
    await settle()
    children[0].stdout.write(JSON.stringify({ _type: "playlist", entries: [{ id: "one" }, { id: "two" }] }))
    children[0].emit("close", 0)
    await expect(info).resolves.toMatchObject({ _type: "playlist", entries: [{ id: "one" }, { id: "two" }] })
    const handle = engine.downloadSimple({ platform: "instagram", url: URL })
    await settle()
    children[1].emit("close", 101)
    await expect(handle.promise).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_COLLECTION, updateMayFix: false })
    const empty = engine.downloadSimple({ platform: "instagram", url: URL })
    await settle()
    children[2].emit("close", 0)
    await expect(empty.promise).rejects.toMatchObject({ code: ERROR_CODES.DOWNLOAD_FAILED })
    for (const args of calls) {
      expect(args).not.toContain("--cookies")
      expect(args).not.toContain("--plugin-dirs")
      expect(args).not.toContain("--extractor-args")
    }
    expect(engine.getActiveCount()).toBe(0)
    expect(engine.gate.isBusy()).toBe(false)
  })

  test.each([
    ["You need to log in to access this content. Use --cookies", "LOGIN_REQUIRED"],
    ["The webpage request was redirected to the login page", "LOGIN_REQUIRED"],
    ["No video formats found!", "NOT_A_VIDEO"],
    ["HTTP Error 429: Too Many Requests", "RATE_LIMITED"],
    ["Unable to extract video URL", "EXTRACTION_FAILED"]
  ])("maps %s without YouTube guidance", (line, code) => {
    const error = mapError({ platform: "instagram", exitCode: 1, stderrLines: [line] })
    expect(error.code).toBe(code)
    expect(error.message + error.suggestion).not.toMatch(/YouTube/)
    expect(error.needsCookies).toBe(false)
    if (code !== "EXTRACTION_FAILED") expect(error.updateMayFix).toBe(false)
  })
})

function createHandlers(info = { title: "Example", formats: [{ vcodec: "avc1" }] }) {
  const handle = new EventEmitter()
  handle.promise = new Promise((resolve, reject) => { handle.resolve = resolve; handle.reject = reject })
  handle.promise.catch(() => {})
  handle.cancel = jest.fn(() => true)
  const engine = {
    getInfo: jest.fn().mockResolvedValue(info),
    downloadSimple: jest.fn(() => handle),
    setPotEnabled: jest.fn()
  }
  const settingsStore = {
    ensureDownloadPath: jest.fn().mockResolvedValue("/tmp"),
    setPotEnabled: jest.fn()
  }
  const captured = []
  const handlers = new IPCHandlers({
    ytdlpEngine: engine, settingsStore,
    cookieManager: { hasValidCookies: () => true },
    analytics: { capture: (event, properties) => captured.push({ event, properties }) }
  })
  return { handlers, engine, handle, settingsStore, captured }
}

describe("Instagram IPC integration", () => {
  test("normalizes public metadata requests using the existing response shape", async () => {
    const { handlers, engine } = createHandlers()
    const response = await handlers.handleGetVideoInfo(null, { platform: "instagram", url: "instagram.com/reel/Example_123/" })
    expect(response.success).toBe(true)
    expect(response.data).toMatchObject({ title: "Example", duration: 0, thumbnail: null })
    expect(engine.getInfo).toHaveBeenCalledWith("https://instagram.com/reel/Example_123/", { platform: "instagram" })
  })

  test.each([
    [{ _type: "playlist", entries: [{ formats: [{ vcodec: "avc1" }] }] }, "UNSUPPORTED_COLLECTION"],
    [{ _type: "multi_video", entries: [] }, "UNSUPPORTED_COLLECTION"],
    [{ formats: [] }, "NOT_A_VIDEO"],
    [{ formats: [{ vcodec: "none", acodec: "aac" }] }, "NOT_A_VIDEO"]
  ])("refuses unsupported metadata %j", async (info, code) => {
    const { handlers } = createHandlers(info)
    const result = await handlers.handleGetVideoInfo(null, { url: URL, platform: "instagram" })
    expect(result).toMatchObject({ success: false, error: { code, category: code } })
  })

  test("unknown codec metadata does not replace yt-dlp's stream decision", async () => {
    const { handlers } = createHandlers({ formats: [{ url: "https://media.example/video", vcodec: null }] })
    expect((await handlers.handleGetVideoInfo(null, { url: URL, platform: "instagram" })).success).toBe(true)
  })

  test("rejects out-of-scope links before metadata or queue admission", async () => {
    const { handlers, engine } = createHandlers()
    const data = { url: "https://instagram.com/stories/example/123/", platform: "instagram", download_id: "instagram_bad" }
    expect((await handlers.handleGetVideoInfo(null, data)).error.code).toBe("INVALID_URL")
    expect((await handlers.handleDownloadCombined(null, data)).error.code).toBe("INVALID_URL")
    expect(engine.getInfo).not.toHaveBeenCalled()
    expect(engine.downloadSimple).not.toHaveBeenCalled()
    expect(handlers.runner.size).toBe(0)
  })

  test("uses the shared runner and analytics without accepting format overrides or enabling YouTube recovery", async () => {
    const { handlers, engine, handle, captured, settingsStore } = createHandlers()
    const response = await handlers.handleDownloadCombined(null, {
      url: URL, platform: "instagram", title: "Private caption", download_id: "instagram_1", format_id: "1080p"
    })
    expect(response).toMatchObject({ success: true, data: { status: "started" } })
    await settle()
    expect(engine.downloadSimple).toHaveBeenCalledWith(expect.objectContaining({ platform: "instagram", formatSelector: null, extraArgs: [] }))
    expect(handlers.runner.list()[0]).toMatchObject({ platform: "instagram", request: { platform: "instagram", url: URL } })
    expect(handlers.listSnapshot().rows[0]).toMatchObject({ platform: "instagram", kind: "simple" })
    const error = Object.assign(new Error("Instagram requires sign-in"), { code: "LOGIN_REQUIRED" })
    handle.reject(error)
    await settle()
    await settle()
    expect(engine.setPotEnabled).not.toHaveBeenCalled()
    expect(settingsStore.setPotEnabled).not.toHaveBeenCalled()
    const failed = captured.find((entry) => entry.event === "download_failed")
    expect(failed.properties).toMatchObject({ platform: "instagram", quality: "best_available", error_category: "LOGIN_REQUIRED" })
    expect(JSON.stringify(captured)).not.toContain(URL)
    expect(JSON.stringify(captured)).not.toContain("Private caption")
    expect(handlers.runner.size).toBe(0)
  })

  test("even legacy bot errors from Instagram never enable the YouTube provider", async () => {
    const { handlers, engine, settingsStore } = createHandlers()
    engine.getInfo.mockRejectedValue(Object.assign(new Error("Use --cookies"), { code: "BOT_DETECTION" }))
    await handlers.handleGetVideoInfo(null, { platform: "instagram", url: URL })
    expect(engine.setPotEnabled).not.toHaveBeenCalled()
    expect(settingsStore.setPotEnabled).not.toHaveBeenCalled()
  })
})
