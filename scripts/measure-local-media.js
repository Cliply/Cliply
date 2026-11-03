// Bounded macOS/Linux host measurements; synthetic data in a NEW owned directory.
// Backend timing uses a test playback grant. Real playback is separately checked
// by the packaged UI harness; do not call these measurements UI latency.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict")
const { spawn, spawnSync, execFile } = require("node:child_process")
const { createHash, randomBytes } = require("node:crypto")
const { LocalMediaService } = require("../src/main/services/local-media")
const { startProbe } = require("../src/main/services/local-media/probe")
const { startExportProcess } = require("../src/main/services/local-media/export-process")
const { ownedPartialBytes } = require("./local-smoke-sampling")
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
async function measure({ directory, ffmpeg, ffprobe, diskVolume }) {
  assert(process.platform !== "win32", "ps-based measurement requires a POSIX host")
  fs.mkdirSync(directory)
  if (diskVolume) {
    assert(path.isAbsolute(diskVolume) && fs.statSync(diskVolume).isDirectory())
    const volume = fs.statfsSync(diskVolume)
    assert(fs.statSync(diskVolume).dev !== fs.statSync(directory).dev, "disk-full check requires a separate disposable volume")
    assert(volume.blocks * volume.bsize > 0 && volume.blocks * volume.bsize <= 128 * 1024 * 1024, "disk-full test volume must be at most 128 MiB; never use the host disk")
  }
  const sourcePath = path.join(directory, "long.mp4"), commands = [], samples = [], active = new Map(), operations = []
  const generate = ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24:d=300", "-f", "lavfi", "-i", "sine=r=48000:d=300", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-b:v", "4M", "-maxrate", "4M", "-bufsize", "8M", "-g", "96", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath]
  assert.equal(spawnSync(ffmpeg, generate, { encoding: "utf8", timeout: 180000 }).status, 0, "fixture generation")
  const sourceHash = digest(sourcePath)
  let stage = "open", destination, peakTemporaryBytes = 0, pendingSample, sampleError
  const sampleDisk = () => { peakTemporaryBytes = Math.max(peakTemporaryBytes, ownedPartialBytes(destination ? path.dirname(destination) : directory)) }
  const track = role => (...args) => {
    const child = spawn(...args); active.set(child.pid, role)
    let helper
    child.on("message", message => { if (message.helperPid) { helper = message.helperPid; active.set(helper, "ffmpeg") } })
    child.once("close", () => { active.delete(child.pid); active.delete(helper) })
    return child
  }
  const sample = () => {
    try { sampleDisk() } catch (error) { sampleError = error }
    if (pendingSample || !active.size || samples.length >= 2000) return
    const roles = new Map(active), at = performance.now(), label = stage
    pendingSample = new Promise(resolve => execFile("ps", ["-p", [...roles.keys()].join(","), "-o", "pid=,pcpu=,rss="], { timeout: 2000 }, (error, stdout) => {
      if (error && error.code !== 1) sampleError = error
      for (const row of stdout.trim().split("\n").filter(Boolean)) {
        const [pid, cpuPercent, rssKiB] = row.trim().split(/\s+/).map(Number)
        samples.push({ at, stage: label, role: roles.get(pid), cpuPercent, rssKiB })
      }
      resolve()
    })).finally(() => { pendingSample = null })
  }
  const runProbe = (exe, file) => startProbe(exe, file, { spawnProcess: track("probe") })
  const service = new LocalMediaService({ selectFile: async () => sourcePath, resolveProbe: async () => ffprobe, runProbe,
    exportOptions: { storagePath: path.join(directory, "state"), selectDestination: async () => destination, resolveFfmpeg: async () => ffmpeg, runProbe,
      onUpdate: sampleDisk, runProcess: (exe, args, options) => { commands.push(args); return startExportProcess(exe, args, { ...options, spawnProcess: track("supervisor") }) } } })
  const timer = setInterval(sample, 50)
  try {
    const began = performance.now(), { source } = await service.open(), openMs = performance.now() - began
    const previewId = randomBytes(32).toString("hex")
    service.preview.grant = { previewId, url: `cliply-media://source/${previewId}`, sourceId: source.sourceId, expiresAt: Date.now() + 600000 }
    service.preview.confirmPlayback({ previewId, played: true })
    for (const [start, end] of [[4.2, 14], [62.2, 90], [182.2, 200.5], [4.2, 294]]) {
      stage = `plan-${start}-${end}`; let at = performance.now()
      const timing = await service.inspectTrim({ sourceId: source.sourceId, previewId, start, end, mode: "before" }), planMs = performance.now() - at
      destination = path.join(directory, `clip-${start}-${end}.mp4`)
      const { plan } = await service.exports.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })
      stage = `export-${start}-${end}`; peakTemporaryBytes = 0; at = performance.now()
      service.exports.start(plan.planId); await service.exports.active.done
      assert.equal(service.exports.job.state, "completed", JSON.stringify(service.exports.job)); sampleDisk()
      const milliseconds = performance.now() - at, outputBytes = fs.statSync(destination).size
      operations.push({ start, end, timing, planMs, milliseconds, outputBytes, peakTemporaryBytes, bytesPerSecond: outputBytes / milliseconds * 1000 })
      assert.equal(service.source.dto.sourceId, source.sourceId)
    }
    const errors = [], denied = path.join(directory, "denied"); fs.mkdirSync(denied); fs.chmodSync(denied, 0o500)
    // Approximate FFprobe seeks can overrun the bounded scan window for these
    // long-GOP offsets. Keep the production refusal; do not relax it to benchmark.
    for (const start of [60.3, 180.2]) {
      await assert.rejects(service.inspectTrim({ sourceId: source.sourceId, previewId, start, end: start + 20, mode: "before" }), { code: "TRIM_TIMING" })
      errors.push({ case: "bounded-long-GOP-scan", start, code: "TRIM_TIMING" })
    }
    try {
      destination = path.join(denied, "audio.aac")
      let refusal, plan
      try { ({ plan } = await service.exports.prepare({ operation: "extractAudio", sourceId: source.sourceId, streamIndex: 1 })) }
      catch (error) { refusal = error.code }
      if (plan) {
        service.exports.start(plan.planId); await service.exports.active.done
        assert.equal(service.exports.job.state, "failed"); refusal = service.exports.job.error
      }
      assert(refusal, "actual unwritable directory must be refused"); errors.push({ case: "directory-mode-0500", code: refusal })
    } finally { fs.chmodSync(denied, 0o700) }
    if (diskVolume) {
      assert(fs.statSync(diskVolume).isDirectory())
      destination = path.join(diskVolume, "full.mp4"); stage = "disk-full"
      const { plan } = await service.exports.prepare({ operation: "removeTracks", sourceId: source.sourceId, streamIndexes: [0], removeChapters: false })
      service.exports.start(plan.planId); await service.exports.active.done
      assert.equal(service.exports.job.state, "failed"); assert.equal(service.exports.job.error, "OUTPUT_SPACE")
      assert(!fs.existsSync(destination)); assert.equal(ownedPartialBytes(diskVolume), 0)
      errors.push({ case: "bounded-disk-image-full", code: service.exports.job.error, partialCleaned: true })
    }
    assert.equal(digest(sourcePath), sourceHash); assert.equal(ownedPartialBytes(directory), 0)
    clearInterval(timer); if (pendingSample) await pendingSample; if (sampleError) throw sampleError
    const facts = { fixture: { duration: 300, width: 1280, height: 720, fps: 24, codec: "h264", audio: "aac/48000", bytes: fs.statSync(sourcePath).size, sha256: sourceHash, sparse: false }, generate, openMs, operations, samples, commands, errors,
      sampleIntervalMs: 50, cpuMeaning: "ps process-lifetime average, not instantaneous", originalUnchanged: true, sequentialSameSource: true, noPartials: true }
    fs.writeFileSync(path.join(directory, "measurements.json"), JSON.stringify(facts, null, 2) + "\n")
    return facts
  } finally { clearInterval(timer); if (pendingSample) await pendingSample; await service.shutdown() }
}
if (require.main === module) {
  const [directory, ffmpeg, ffprobe, diskVolume] = process.argv.slice(2)
  assert([directory, ffmpeg, ffprobe].every(value => value && path.isAbsolute(value)))
  measure({ directory, ffmpeg, ffprobe, diskVolume }).then(facts => console.log(JSON.stringify({ operations: facts.operations.length, samples: facts.samples.length, errors: facts.errors }))).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { measure }
