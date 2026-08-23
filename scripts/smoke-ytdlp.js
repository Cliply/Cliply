// manual smoke test for the yt-dlp engine and updater
// hits the network on purpose, so it is not part of the jest suite
//
//   npm run fetch:ytdlp        # once, to get binaries/<platform>/ytdlp/
//   node scripts/smoke-ytdlp.js
//
// ffmpeg and deno are taken from binaries/ when present; override with
// CLIPLY_FFMPEG / CLIPLY_DENO (e.g. pointing at an installed Cliply.app)

const { execSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { YtdlpEngine } = require("../src/main/services/ytdlp-engine")
const { YtdlpUpdater, releaseAssetFor } = require("../src/main/services/ytdlp-updater")
const { extractAudioTracks } = require("../src/main/utils/ytdlp-mappers")

const REPO = path.join(__dirname, "..")
const URL = process.env.CLIPLY_SMOKE_URL || "https://www.youtube.com/watch?v=aqz-KE-bpKQ"

// a dubbed upload, for the audio track checks - the default URL above has one
// audio language, which is the case that must show no picker at all
const DUBBED_URL =
  process.env.CLIPLY_SMOKE_DUBBED_URL || "https://www.youtube.com/watch?v=Af6i6ChAVTw"

const PLATFORM_DIRS = { darwin: "macos", win32: "windows", linux: "linux" }
const PLATFORM_DIR = PLATFORM_DIRS[process.platform] || process.platform
const EXE = process.platform === "win32" ? ".exe" : ""

// find a bundled binary the same way the engine does, with an env override
function resolveBinary(envVar, candidates) {
  if (process.env[envVar]) {
    return process.env[envVar]
  }

  for (const candidate of candidates) {
    const full = path.join(REPO, "binaries", ...candidate)
    if (fs.existsSync(full)) {
      return full
    }
  }

  return null
}

const ffmpegPath = resolveBinary("CLIPLY_FFMPEG", [
  [`ffmpeg${EXE}`],
  [PLATFORM_DIR, `ffmpeg${EXE}`]
])

const denoPath = resolveBinary("CLIPLY_DENO", [
  ["deno", `deno${EXE}`],
  ["deno", PLATFORM_DIR, `deno${EXE}`]
])

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-smoke-"))
const downloadDir = path.join(userDataPath, "downloads")
fs.mkdirSync(downloadDir, { recursive: true })

const engine = new YtdlpEngine({
  userDataPath,
  resourcesPath: REPO,
  ffmpegPath,
  denoPath
})

const updater = new YtdlpUpdater({ engine })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failures = []

function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` - ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

// count ffmpeg processes so cancellation can be checked for orphans
// anchored: yt-dlp itself carries the ffmpeg path in --ffmpeg-location, and
// matching that too would make the counts impossible to read
function countFfmpeg() {
  if (process.platform === "win32" || !ffmpegPath) return null

  try {
    const out = execSync(`pgrep -f "^${ffmpegPath}" || true`, { encoding: "utf8" })
    return out.trim() ? out.trim().split("\n").length : 0
  } catch {
    return 0
  }
}

async function main() {
  console.log("workdir:   ", userDataPath)
  console.log("ffmpeg:    ", ffmpegPath || "(not found - merging will fail)")
  console.log("deno:      ", denoPath || "(not found - youtube may fail)")

  console.log("\n=== seed ===")
  const seedStarted = Date.now()
  const seeded = await updater.seed()
  console.log(`seed: ${JSON.stringify(seeded)} (${Date.now() - seedStarted}ms)`)
  check("engine seeded into userData/engine", fs.existsSync(engine.getInstalledBinaryPath()))
  check(
    "engine is an unpacked directory",
    fs.statSync(engine.getInstalledEngineDir()).isDirectory() &&
      fs.existsSync(path.join(engine.getInstalledEngineDir(), "_internal"))
  )
  const version = await updater.getInstalledVersion()
  check("binary reports a version", Boolean(version), version)
  check("second seed is a no-op", (await updater.seed()).seeded === false)

  // the whole point of the onedir switch: the single-file build cost 43-108 s
  // *per invocation* on this machine (upstream yt-dlp#10425)
  console.log("\n=== startup cost (3 consecutive --version) ===")
  const timings = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = Date.now()
    const probed = await engine.probeVersion()
    const elapsed = Date.now() - startedAt
    timings.push(elapsed)
    console.log(`  run ${attempt + 1}: ${elapsed}ms (${probed})`)
  }
  check(
    "every --version stays under two seconds",
    timings.every((elapsed) => elapsed < 2000),
    `${timings.join("ms, ")}ms`
  )

  console.log("\n=== info ===")
  const info = await engine.getInfo(URL)
  check("title parsed", Boolean(info.title), info.title)
  check("formats parsed", info.formats.length > 0, `${info.formats.length} formats`)

  console.log("\n=== trimmed download (0:05-0:12, precise cut) ===")
  const trimmed = engine.downloadCombined({
    url: URL,
    height: 360,
    container: "mp4",
    outputDir: downloadDir,
    outputTemplate: "smoke_trim.%(ext)s",
    timeRange: { start: 5, end: 12 },
    preciseCut: true
  })
  const trimmedResult = await trimmed.promise
  check("trim produced a file", fs.existsSync(trimmedResult.filePath), trimmedResult.filePath)
  check("trim file is not empty", fs.statSync(trimmedResult.filePath).size > 0)

  console.log("\n=== untrimmed video+audio download ===")
  const merged = engine.downloadCombined({
    url: URL,
    height: 144,
    container: "mp4",
    outputDir: downloadDir,
    outputTemplate: "smoke_merged.%(ext)s"
  })
  const progress = []
  merged.on("progress", (update) => progress.push(update))
  const mergedResult = await merged.promise

  check("progress events arrived", progress.length > 2, `${progress.length} events`)
  check(
    "progress never goes backwards",
    progress.every((event, index) => index === 0 || event.progress >= progress[index - 1].progress)
  )
  check("merged file exists", fs.existsSync(mergedResult.filePath))

  console.log("\n=== audio download ===")
  const audio = engine.downloadAudio({
    url: URL,
    audioMode: "mp3",
    outputDir: downloadDir,
    outputTemplate: "smoke_audio.%(ext)s",
    timeRange: { start: 5, end: 10 },
    preciseCut: true
  })
  const audioResult = await audio.promise
  check("mp3 produced", fs.existsSync(audioResult.filePath), audioResult.filePath)

  console.log("\n=== dubbed audio tracks ===")
  // the single-language case first, because it is nearly every video and the
  // one this feature is not allowed to change
  check(
    "a single-language video offers no track choice",
    extractAudioTracks(info).length === 0,
    `${info.formats.filter((format) => format.vcodec === "none").length} audio formats, no languages`
  )

  const dubbedInfo = await engine.getInfo(DUBBED_URL)
  const tracks = extractAudioTracks(dubbedInfo)
  check("a dubbed video reports its languages", tracks.length > 1, `${tracks.length} tracks`)
  check(
    "the original is identified",
    tracks.filter((track) => track.is_original).length === 1,
    tracks.find((track) => track.is_original)?.code
  )

  const dub = tracks.find((track) => !track.is_original)
  if (dub) {
    const dubbed = engine.downloadAudio({
      url: DUBBED_URL,
      audioMode: "mp3",
      audioLanguage: dub.code,
      outputDir: downloadDir,
      outputTemplate: `smoke_dub_${dub.code}.%(ext)s`,
      timeRange: { start: 10, end: 16 },
      preciseCut: true
    })
    const dubbedResult = await dubbed.promise
    check(
      `a ${dub.code} audio download produced a file`,
      fs.existsSync(dubbedResult.filePath),
      path.basename(dubbedResult.filePath)
    )
  }

  console.log("\n=== error mapping ===")
  try {
    await engine.getInfo("https://www.youtube.com/watch?v=aaaaaaaaaaa")
    check("unavailable video rejected", false)
  } catch (error) {
    check("unavailable video mapped", error.code === "VIDEO_UNAVAILABLE", error.code)
    check("stderr captured for the report", error.stderrTail.length > 0)
  }

  console.log("\n=== hostile url ===")
  try {
    engine.downloadCombined({
      url: "--exec=touch /tmp/cliply-pwned",
      outputDir: downloadDir,
      outputTemplate: "nope.%(ext)s"
    })
    check("hostile url rejected", false)
  } catch (error) {
    check("hostile url rejected before spawn", error.code === "INVALID_URL")
  }
  check("hostile url did not execute", !fs.existsSync("/tmp/cliply-pwned"))

  console.log("\n=== cancel during the ffmpeg phase ===")
  const before = countFfmpeg()
  const cancelling = engine.downloadCombined({
    url: URL,
    height: 720,
    container: "mp4",
    outputDir: downloadDir,
    outputTemplate: "smoke_cancel.%(ext)s",
    timeRange: { start: 0, end: 120 },
    preciseCut: true
  })

  let during = 0
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(1000)
    during = countFfmpeg() || 0
    if (during > (before || 0)) break
  }
  check("ffmpeg was running before the cancel", during > (before || 0), `${during} processes`)

  cancelling.cancel()
  try {
    await cancelling.promise
    check("cancel rejected the promise", false)
  } catch (error) {
    check("cancel reported as cancelled", error.code === "CANCELLED")
  }

  await wait(3000)
  const after = countFfmpeg()
  check("no orphaned ffmpeg after cancel", after === before, `${after} processes`)
  check("active operations released", engine.getActiveCount() === 0)

  console.log("\n=== watchdog ===")
  const stalling = engine.run("info", { url: URL }, { watchdogMs: 1 })
  try {
    await stalling.promise
    check("watchdog fired", false)
  } catch (error) {
    check("watchdog reported as stalled", error.code === "STALLED")
  }

  console.log("\n=== update gate ===")
  const busy = engine.downloadCombined({
    url: URL,
    height: 360,
    container: "mp4",
    outputDir: downloadDir,
    outputTemplate: "smoke_busy.%(ext)s"
  })
  const refused = await updater.checkForUpdate()
  check("update refused while downloading", refused.started === false, refused.reason)

  busy.cancel()
  await busy.promise.catch(() => {})

  const updated = await updater.updateNow()
  // "up-to-date" is the usual answer: the build fetched the latest stable, so
  // there is normally nothing newer on github to swap in
  check(
    "updateNow finished cleanly",
    ["completed", "up-to-date"].includes(updated.reason),
    `${updated.reason}: ${updated.from} -> ${updated.to} (latest ${updated.tag})`
  )
  check("the engine still runs after the update check", Boolean(await updater.getInstalledVersion()))
  check("gate released after the update", engine.gate.isBusy() === false)

  console.log("\n=== update safety ===")
  // a tampered archive must never reach the engine
  const tampered = new YtdlpUpdater({
    engine,
    http: {
      getRedirectLocation: async () =>
        "https://github.com/yt-dlp/yt-dlp/releases/tag/2099.01.01",
      getText: async () => `${"0".repeat(64)}  ${releaseAssetFor()}\n`,
      download: async (_url, destPath) => {
        fs.writeFileSync(destPath, "definitely not a yt-dlp release")
        return "1".repeat(64)
      }
    }
  })

  const rejected = await tampered.updateNow()
  check("checksum mismatch refused", rejected.reason === "checksum-mismatch", rejected.reason)
  check(
    "nothing was left staged",
    fs
      .readdirSync(engine.getEngineDir())
      .filter((name) => name.startsWith(".staging") || name.startsWith(".download"))
      .length === 0
  )
  check("engine survived the bad update", Boolean(await updater.getInstalledVersion()))

  console.log("\nfiles produced:", fs.readdirSync(downloadDir))
}

main()
  .then(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })

    if (failures.length) {
      console.log(`\n${failures.length} check(s) failed:`, failures.join(", "))
      process.exit(1)
    }

    console.log("\nall smoke checks passed")
    process.exit(0)
  })
  .catch((error) => {
    console.error("\nsmoke test crashed:", error)
    process.exit(1)
  })
