// Offline integration check using the release helpers, a generated video and
// controlled HTTP failures. No YouTube access, cookies or user data required.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { YtdlpEngine } = require("../src/main/services/ytdlp-engine")
const { DownloadRunner } = require("../src/main/services/download-runner")

const repo = path.resolve(__dirname, "..")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-recovery-"))
const platform = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform]
const ffmpeg = path.join(repo, "binaries", platform, `ffmpeg${process.platform === "win32" ? ".exe" : ""}`)
const video = path.join(root, "source.mp4")
const engine = new YtdlpEngine({ userDataPath: root, resourcesPath: repo, ffmpegPath: ffmpeg })
let attempts = 0
let fault = "none"
let rejectedRequests = 0
let closedPort
const errors = []

function ffmpegRun(args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", ...args], {
    encoding: "utf8", timeout: 30000, windowsHide: true
  })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  return result
}

const server = http.createServer((request, response) => {
  // yt-dlp sniffs the file with a regular GET. FFmpeg requests byte ranges.
  const range = request.headers.range
  if (range && fault === "connection" && attempts === 1) {
    rejectedRequests += 1
    response.writeHead(302, { Location: `http://127.0.0.1:${closedPort}/source.mp4` })
    response.end()
    return
  }
  if (range && (fault === "permanent" || (fault === "transient" && attempts === 1))) {
    rejectedRequests += 1
    response.writeHead(503)
    response.end("temporary test failure")
    return
  }
  if (fault === "forbidden") {
    rejectedRequests += 1
    response.writeHead(403)
    response.end("test access refusal")
    return
  }
  const size = fs.statSync(video).size
  const match = /^bytes=(\d+)-(\d*)$/.exec(range || "")
  const start = match ? Number(match[1]) : 0
  const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  response.writeHead(match ? 206 : 200, {
    "Content-Type": "video/mp4", "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
  })
  if (request.method === "HEAD") response.end()
  else fs.createReadStream(video, { start, end }).pipe(response)
})

async function runCase(mode, success, expectedAttempts, expectedCode) {
  attempts = 0
  rejectedRequests = 0
  fault = mode
  const events = []
  const runner = new DownloadRunner({
    engine,
    sendEvent: (_id, payload) => events.push(payload)
  })
  const result = await runner.run({
    downloadId: mode, type: "combined", trimmed: true,
    createHandle: () => {
      attempts += 1
      const handle = engine.downloadCombined({
        url: `http://127.0.0.1:${server.address().port}/source.mp4`,
        height: 144, container: "mp4", outputDir: root,
        outputTemplate: `${mode}.%(ext)s`, timeRange: { start: 1, end: 3 }, preciseCut: true
      }, { watchdogMs: 15000 })
      handle.promise.catch((error) => errors.push({ mode, code: error.code, tail: error.stderrTail }))
      return handle
    }
  })
  assert.equal(result.success, success, JSON.stringify({ result, errors }))
  assert.equal(attempts, expectedAttempts)
  assert.equal(events.filter((event) => ["completed", "failed", "cancelled"].includes(event.status)).length, 1)
  assert.equal(runner.size, 0)
  assert.equal(engine.gate.isBusy(), false)
  if (mode !== "none") assert.ok(rejectedRequests > 0, "test must exercise the intended fault")
  if (expectedCode) assert.equal(result.error.code, expectedCode)
  if (success) {
    assert.ok(fs.statSync(result.file_path).size > 0)
    const decoded = ffmpegRun(["-loglevel", "info", "-i", result.file_path, "-f", "null", "-"])
    const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(decoded.stderr)
    assert.ok(duration, "output must report a duration")
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    assert.ok(Math.abs(seconds - 2) < 0.3, `expected a two-second clip, got ${seconds}`)
  }
  console.log(JSON.stringify({ mode, success: result.success, attempts, rejectedRequests }))
}

async function main() {
  ffmpegRun(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=44100", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", video])
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const unused = http.createServer()
  await new Promise((resolve) => unused.listen(0, "127.0.0.1", resolve))
  closedPort = unused.address().port
  await new Promise((resolve) => unused.close(resolve))
  console.log(`yt-dlp ${await engine.getVersion()}`)
  await runCase("none", true, 1)
  await runCase("transient", true, 2)
  await runCase("connection", true, 2)
  await runCase("permanent", false, 2, "NETWORK_ERROR")
  await runCase("forbidden", false, 1, "HTTP_FORBIDDEN")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await engine.awaitShutdown()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
})
