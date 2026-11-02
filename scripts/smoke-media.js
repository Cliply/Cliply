// Exercise the real release helpers against generated media served only on
// localhost. Everything written by this check belongs to its temporary folder.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")
const { parseArgs } = require("node:util")
const { YtdlpEngine } = require("../src/main/services/ytdlp-engine")

const { values } = parseArgs({ options: { resources: { type: "string" } } })
const resources = values.resources ? path.resolve(values.resources) : path.resolve(__dirname, "..")
const platform = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform]
const ffmpeg = path.join(resources, "binaries", ...(values.resources ? [] : [platform]),
  `ffmpeg${process.platform === "win32" ? ".exe" : ""}`)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-media-"))
const video = path.join(root, "source.mp4")
const audio = path.join(root, "source.m4a")
const engine = new YtdlpEngine({
  userDataPath: root, resourcesPath: resources, ffmpegPath: ffmpeg,
  // A developer's yt-dlp config must not inject cookies, output paths or a
  // cache outside this fixture. Keep the engine's normal process lifecycle.
  spawnFn: (binary, args, options) => spawn(binary,
    ["--ignore-config", "--no-cache-dir", "--proxy", "", ...args], options)
})
let cancellationRequested

function ffmpegRun(args, logLevel = "error") {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", logLevel, ...args], {
    encoding: "utf8", timeout: 30000, windowsHide: true
  })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  return result
}

const server = http.createServer((request, response) => {
  const isAudio = request.url === "/source.m4a"
  if (!["/source.mp4", "/source.m4a", "/cancel.mp4"].includes(request.url)) {
    response.writeHead(404).end()
    return
  }
  const file = isAudio ? audio : video
  const size = fs.statSync(file).size
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "")
  const start = range ? Number(range[1]) : 0
  const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start >= size || start > end) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` }).end()
    return
  }
  response.writeHead(range ? 206 : 200, {
    "Content-Type": isAudio ? "audio/mp4" : "video/mp4",
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
  })
  if (request.method === "HEAD") {
    response.end()
  } else if (request.url === "/cancel.mp4") {
    // Hold an actual request open so cancellation happens during I/O rather
    // than racing a fixed delay against process startup on different hosts.
    response.flushHeaders()
    cancellationRequested?.()
  } else {
    const stream = fs.createReadStream(file, { start, end })
    stream.on("error", (error) => response.destroy(error))
    response.once("close", () => stream.destroy())
    stream.pipe(response)
  }
})

function inspectOutput(file, { extension, seconds, tolerance = 0.35, audioOnly = false, codec }) {
  assert.ok(file && fs.existsSync(file), "engine must report an existing output file")
  assert.equal(path.dirname(path.resolve(file)), root, "output must stay in the test folder")
  assert.equal(path.extname(file), extension)
  assert.ok(fs.statSync(file).size > 0)
  const { stderr } = ffmpegRun(["-xerror", "-i", file, "-map", "0", "-f", "null", "-"], "info")
  const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)
  assert.ok(duration, `output must have a readable duration: ${file}`)
  const actual = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
  assert.ok(Math.abs(actual - seconds) < tolerance, `expected ${seconds}s, got ${actual}s: ${file}`)
  assert.match(stderr, /Audio:/, "output must contain audio")
  if (audioOnly) assert.doesNotMatch(stderr, /Video:/, "audio export must not contain video")
  else assert.match(stderr, /Video:/, "video export must contain video")
  if (codec) assert.match(stderr, new RegExp(`Audio: ${codec}`))
  if (extension === ".mkv") assert.match(stderr, /Input #0, matroska,webm,/)
  if ([".mp4", ".m4a"].includes(extension)) assert.match(stderr, /Input #0, mov,mp4,m4a,/)
  return actual
}

async function downloadCase(name, type, params, expected) {
  const handle = engine[type === "audio" ? "downloadAudio" : "downloadCombined"]({
    url: `http://127.0.0.1:${server.address().port}/${type === "audio" && params.audioMode === "original" ? "source.m4a" : "source.mp4"}`,
    outputDir: root,
    outputTemplate: `${name}.%(ext)s`,
    ...params
  }, { watchdogMs: 20000 })
  const result = await handle.promise
  const seconds = inspectOutput(result.filePath, expected)
  assert.equal(engine.operations.size, 0)
  assert.equal(engine.gate.isBusy(), false)
  console.log(JSON.stringify({ name, file: path.basename(result.filePath), seconds, verified: true }))
}

async function checkCancellation() {
  const requested = new Promise((resolve) => { cancellationRequested = resolve })
  const handle = engine.downloadCombined({
    url: `http://127.0.0.1:${server.address().port}/cancel.mp4`,
    height: 144, container: "mp4", outputDir: root, outputTemplate: "cancel.%(ext)s"
  }, { watchdogMs: 20000 })
  let timeout
  try {
    await Promise.race([
      requested,
      handle.promise.then(() => { throw new Error("download finished before cancellation") }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("cancellation test received no request")), 20000)
      })
    ])
    assert.equal(handle.cancel(), true)
    await assert.rejects(handle.promise, (error) => error.code === "CANCELLED")
    assert.equal(engine.operations.size, 0)
    assert.equal(engine.gate.isBusy(), false)
    console.log(JSON.stringify({ name: "cancel-during-http", verified: true }))
  } finally {
    clearTimeout(timeout)
    cancellationRequested = null
  }
}

async function main() {
  ffmpegRun(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=44100", "-t", "4", "-c:v", "libx264", "-g", "10",
    "-keyint_min", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", video])
  ffmpegRun(["-i", video, "-vn", "-c:a", "copy", "-movflags", "+faststart", audio])
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  console.log(`yt-dlp ${await engine.getVersion()}`)
  const failures = []
  async function check(run) {
    try {
      await run()
    } catch (error) {
      failures.push(error)
      console.error(error)
    }
  }
  for (const container of ["mp4", "mkv"]) {
    await check(() => downloadCase(`full-${container}`, "combined", { height: 144, container },
      { extension: `.${container}`, seconds: 4 }))
    for (const preciseCut of [false, true]) {
      await check(() => downloadCase(`${preciseCut ? "precise" : "fast"}-${container}`, "combined",
        { height: 144, container, preciseCut, timeRange: { start: 1, end: 3 } },
        // Fast stream copies may retain a boundary keyframe; the fixture's
        // GOP is one second. Precise cuts must stay much closer to the range.
        { extension: `.${container}`, seconds: 2, tolerance: preciseCut ? 0.35 : 1.1 }))
    }
  }
  for (const audioMode of ["mp3", "m4a", "original"]) {
    await check(() => downloadCase(`audio-${audioMode}`, "audio", { audioMode }, {
      extension: audioMode === "mp3" ? ".mp3" : ".m4a", seconds: 4,
      audioOnly: true, codec: audioMode === "mp3" ? "mp3" : "aac"
    }))
  }
  await check(() => downloadCase("precise-audio-m4a", "audio",
    { audioMode: "m4a", preciseCut: true, timeRange: { start: 1, end: 3 } },
    { extension: ".m4a", seconds: 2, audioOnly: true, codec: "aac" }))
  await check(checkCancellation)
  if (failures.length) throw new AggregateError(failures, "media smoke checks failed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  try {
    await engine.awaitShutdown()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
