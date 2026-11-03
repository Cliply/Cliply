// Synthetic trim acceptance; encoding occurs only while making test fixtures.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { createHash, randomBytes } = require("node:crypto")
const { spawnSync, spawn } = require("node:child_process")
const { LocalMediaService } = require("../src/main/services/local-media")
const { startExportProcess } = require("../src/main/services/local-media/export-process")
const { startPacketProbe, startFrameProbe } = require("../src/main/services/local-media/trim-plan")
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
function command(exe, args, binary = false) {
  const result = spawnSync(exe, args, { encoding: binary ? null : "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(result.status, 0, String(result.stderr)); return result.stdout
}
function fixtures(directory, ffmpeg) {
  fs.mkdirSync(directory, { recursive: true })
  const make = (name, args) => command(ffmpeg, ["-v", "error", ...args, path.join(directory, name)])
  const noise = ["-f", "lavfi", "-i", "anoisesrc=d=12:r=48000:seed=42:a=0.3"]
  const video = ["-f", "lavfi", "-i", "testsrc2=s=160x90:r=24:d=12", ...noise]
  const codecs = ["-c:v", "libx264", "-g", "96", "-keyint_min", "96", "-sc_threshold", "0", "-bf", "3", "-pix_fmt", "yuv420p", "-c:a", "aac", "-aac_pns", "0", "-metadata:s:a:0", "language=eng", "-metadata", "title=Boundary fixture"]
  make("gop.mp4", [...video, ...codecs])
  if (process.platform === "darwin") make("he-aac.mp4", ["-i", path.join(directory, "gop.mp4"), "-map", "0", "-c:v", "copy", "-c:a", "aac_at", "-profile:a", "4", "-ar", "44100", "-ac", "2", "-b:a", "48k"])
  make("vfr.mp4", [...video, "-vf", "select='lt(t,6)+gte(t,6)*not(mod(n,2))'", "-fps_mode", "vfr", ...codecs])
  for (const name of ["same.mov", "compatible.mkv"]) make(name, ["-i", path.join(directory, "gop.mp4"), "-map", "0", "-c", "copy"])
  make("rotated.mov", ["-i", path.join(directory, "same.mov"), "-map", "0", "-c", "copy", "-metadata:s:v:0", "rotate=90"])
  make("brand.mp4", ["-i", path.join(directory, "gop.mp4"), "-map", "0", "-c", "copy", "-brand", "mp42"])
  make("silent.mp4", ["-i", path.join(directory, "gop.mp4"), "-map", "0:v", "-c", "copy"])
  for (const extension of ["mp4", "mov"]) make(`audio.${extension}`, ["-i", path.join(directory, "gop.mp4"), "-map", "0:a", "-c", "copy"])
  make("offset.mp4", ["-i", path.join(directory, "gop.mp4"), "-map", "0", "-c", "copy", "-output_ts_offset", "2"])
  fs.writeFileSync(path.join(directory, "chapters.txt"), ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=12000\ntitle=Whole source\n")
  make("chapters.mp4", ["-i", path.join(directory, "gop.mp4"), "-f", "ffmetadata", "-i", path.join(directory, "chapters.txt"), "-map", "0", "-c", "copy", "-map_chapters", "1"])
  make("audio.wav", [...noise, "-c:a", "pcm_s16le"])
  make("audio.mp3", [...noise, "-c:a", "libmp3lame"])
  make("audio.m4a", [...noise, "-c:a", "aac", "-aac_pns", "0"])
  for (const rate of [44100, 48000]) {
    make(`stereo-${rate}.wav`, [...noise, "-ar", String(rate), "-ac", "2", "-c:a", "pcm_s16le"])
    make(`stereo-${rate}.m4a`, [...noise, "-ar", String(rate), "-ac", "2", "-c:a", "aac", "-aac_pns", "0"])
  }
  make("raw.aac", [...noise, "-c:a", "aac", "-aac_pns", "0"])
}
async function runNative({ directory, ffmpeg, ffprobe }) {
  fixtures(directory, ffmpeg)
  const inventories = [], commands = [], scans = [], probeCommands = [], refusals = []
  const spawnProbe = (exe, args, options) => {
    probeCommands.push(args.map(arg => path.isAbsolute(arg) ? path.basename(arg) : arg))
    return spawn(exe, args, options)
  }
  const runFrames = (exe, file, stream, start) => startFrameProbe(exe, file, stream, start, { spawnProcess: spawnProbe })
  let selected, destination
  const service = new LocalMediaService({ selectFile: async () => selected, resolveProbe: async () => ffprobe,
    runPackets: (exe, file, stream, from, to) => { scans.push({ input: path.basename(file), stream, from, to }); return startPacketProbe(exe, file, stream, from, to, { spawnProcess: spawnProbe }) },
    runFrames,
    exportOptions: { runFrames, storagePath: path.join(directory, "state"), resolveFfmpeg: async () => ffmpeg, selectDestination: async () => destination,
      runProcess: (exe, args, options) => {
        assert.deepEqual(args.filter((_arg, i) => args[i - 1] === "-c"), ["copy"])
        assert(!args.some(arg => /^-(c:|codec|vf|af)/.test(arg)))
        commands.push({ input: path.basename(selected), output: path.basename(destination), args })
        return startExportProcess(exe, args, options)
      } } })
  const inspect = file => { const raw = JSON.parse(command(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file])); raw.format.filename = path.basename(file); return raw }
  // This backend harness supplies a grant-bound playback acknowledgment. The
  // separate Electron harness below proves real onPlaying/IPC/native playback.
  async function open(name) {
    selected = path.join(directory, name); const source = (await service.open()).source
    const previewId = randomBytes(32).toString("hex")
    service.preview.grant = { previewId, url: `cliply-media://source/${previewId}`, sourceId: source.sourceId, expiresAt: Date.now() + 600000 }
    service.preview.confirmPlayback({ previewId, played: true }); return source
  }
  const request = (start, end, mode = "before") => ({ sourceId: service.source.dto.sourceId, previewId: service.preview.grant.previewId, start, end, mode })
  const videoCache = new Map(), audioCache = new Map()
  function frames(file) {
    if (videoCache.has(file)) return videoCache.get(file)
    const hashes = command(ffmpeg, ["-v", "error", "-noautorotate", "-i", file, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "framemd5", "-"]).split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim())
    const raw = JSON.parse(command(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time,duration_time", "-of", "json", file])).frames
    assert.equal(hashes.length, raw.length)
    const data = hashes.map((digest, i) => ({ digest, time: Number(raw[i].best_effort_timestamp_time), duration: Number(raw[i].duration_time) }))
    videoCache.set(file, data); return data
  }
  function pcm(file) {
    if (!audioCache.has(file)) audioCache.set(file, command(ffmpeg, ["-v", "error", "-i", file, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", "-"], true))
    return audioCache.get(file)
  }
  function compare(timing, source) {
    const facts = {}
    if (timing.hasVideo) {
      const before = frames(selected), after = frames(destination)
      let previous = -1
      const indexes = after.map(frame => { const index = before.findIndex((candidate, i) => i > previous && candidate.digest === frame.digest); assert(index >= 0, "decoded output frame belongs to ordered source"); previous = index; return index })
      const first = before[indexes[0]].time, last = before[indexes.at(-1)].time + before[indexes.at(-1)].duration
      assert(Math.abs(first - timing.plannedStart) <= 0.001)
      assert(Math.abs(last - timing.plannedEnd) <= 0.1)
      facts.video = { decodedFrames: after.length, sourceFirstFrame: indexes[0], sourceLastFrame: indexes.at(-1), actualStart: first, actualEnd: last, plannedStartError: first - timing.plannedStart, plannedEndError: last - timing.plannedEnd, orderedSourceFrames: true }
    }
    const audio = source.streams.find(stream => stream.type === "audio")
    if (audio) {
      const before = pcm(selected), after = pcm(destination), stride = audio.channels * 2
      // AAC overlap-add / MP3 reservoir startup differs at the first frame.
      // Compare an interior anchor, then all interior PCM after the warmup.
      const anchor = Math.min(4096 * stride, Math.floor(after.length / 4 / stride) * stride)
      const length = Math.min(2048 * stride, after.length - anchor)
      const match = before.indexOf(after.subarray(anchor, anchor + length)); assert(match >= 0, `audio anchor ${path.basename(destination)}`)
      const offset = match - anchor, lo = Math.max(anchor, -offset), hi = Math.min(after.length, before.length - offset)
      assert.equal(hash(after.subarray(lo, hi)), hash(before.subarray(lo + offset, hi + offset)))
      const actualStart = offset / stride / audio.sampleRate, actualEnd = actualStart + after.length / stride / audio.sampleRate
      let leadingQuiet = 0
      while (leadingQuiet + 1 < after.length && Math.abs(after.readInt16LE(leadingQuiet)) < 100) leadingQuiet += 2
      const onset = actualStart + leadingQuiet / stride / audio.sampleRate
      assert(Math.abs(actualStart - timing.plannedStart) <= (timing.pcm ? 0.00003 : 0.05), `${path.basename(destination)} audio start ${actualStart}/${timing.plannedStart}`)
      assert(Math.abs(actualEnd - (timing.hasVideo ? timing.requestedEnd : timing.plannedEnd)) <= (timing.pcm ? 0.001 : 0.06))
      facts.audio = { sampleRate: audio.sampleRate, decodedSampleFrames: after.length / stride, actualStart, actualEnd, leadingQuietSampleFrames: leadingQuiet / stride, audibleOnset: onset, plannedStartError: actualStart - timing.plannedStart, interiorPcmExact: true }
    }
    return facts
  }
  async function save(name, start, end, mode) {
    const source = service.source.dto, sourceHash = hash(fs.readFileSync(selected)); destination = path.join(directory, name)
    const timing = await service.inspectTrim(request(start, end, mode))
    const { plan } = await service.exports.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })
    service.exports.start(plan.planId); await service.exports.active.done
    assert.equal(service.exports.job.state, "completed", JSON.stringify(service.exports.job))
    command(ffmpeg, ["-v", "error", "-xerror", "-i", destination, "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"])
    const content = compare(timing, source)
    assert.equal(hash(fs.readFileSync(selected)), sourceHash); assert.equal(service.source.dto.sourceId, source.sourceId)
    inventories.push({ input: path.basename(selected), output: name, sourceId: source.sourceId, sourceSha256: sourceHash, outputSha256: hash(fs.readFileSync(destination)), timing, content, before: inspect(selected), after: inspect(destination), sourceUnchanged: true, sourceStillOpen: true })
  }
  await open("gop.mp4")
  for (const [name, start, end, mode] of [["zero.mp4", 0, 12], ["end-only.mp4", 0, 2], ["start-only.mp4", 8, 12], ["middle.mp4", 4.2, 6], ["short.mp4", 4, 4.15], ["minimum.mp4", 4, 4.1], ["adjusted.mp4", 4.9, 10, "after"]]) await save(name, start, end, mode)
  assert.equal(new Set(inventories.map(row => row.sourceId)).size, 1)
  for (const input of ["same.mov", "rotated.mov", "vfr.mp4", "brand.mp4", "silent.mp4", "audio.mp4", "audio.mov"]) { await open(input); await save(`cut-${input}`, 4.2, 10) }
  for (const extension of ["wav", "m4a"]) {
    await open(`audio.${extension}`)
    for (const [name, start, end] of [["zero", 0, 12], ["middle", 1.123, 3.456], ["eof", 8.123, 12], ["short", 1.123, 1.273]]) await save(`${name}.${extension}`, start, end)
  }
  for (const rate of [44100, 48000]) for (const extension of ["wav", "m4a"]) {
    await open(`stereo-${rate}.${extension}`); await save(`cut-stereo-${rate}.${extension}`, 1.123, 3.456)
  }
  for (const [input, code] of [["audio.mp3", "TRIM_CONTAINER"], ["offset.mp4", "TRIM_TIMING"], ["chapters.mp4", "TRIM_CHAPTERS"], ["raw.aac", "TRIM_CONTAINER"]]) {
    const source = await open(input); assert.equal(source.trimProfile, null); assert.equal(source.capabilities.trim.reason, code); refusals.push({ input, code })
  }
  // Candidate rejected on actual decoded-onset evidence: MP3 reservoir/skip
  // metadata makes this EOF cut start ~99 ms after the requested position.
  const mp3Candidate = path.join(directory, "candidate.mp3"), mp3Source = path.join(directory, "audio.mp3")
  command(ffmpeg, ["-v", "error", "-i", mp3Source, "-ss", "8.123", "-copyinkf", "-c", "copy", mp3Candidate])
  const mp3Pcm = pcm(mp3Candidate), mp3Offset = pcm(mp3Source).indexOf(mp3Pcm.subarray(8192, 12288)) - 8192
  assert(mp3Offset >= 0)
  refusals[0].measurement = { requestedStart: 8.123, decodedStart: mp3Offset / 96000, allowedTolerance: 0.05, candidateCommand: ["-i", "audio.mp3", "-ss", "8.123", "-copyinkf", "-c", "copy", "candidate.mp3"] }
  assert(mp3Offset / 96000 - 8.123 > 0.05)
  await open("gop.mp4")
  await assert.rejects(async () => service.inspectTrim(request(4.2, 6, "after")), { code: "TRIM_RANGE" }); refusals.push({ input: "gop.mp4", start: 4.2, end: 6, mode: "after", code: "TRIM_RANGE" })
  const timing = await service.inspectTrim(request(4.2, 6)), source = service.source.dto
  destination = path.join(directory, "middle.mp4"); const original = hash(fs.readFileSync(destination))
  await assert.rejects(service.exports.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId }), { code: "OUTPUT_EXISTS" })
  assert.equal(hash(fs.readFileSync(destination)), original)
  destination = path.join(directory, "cancelled.mp4")
  const run = service.exports.runProcess
  service.exports.runProcess = (exe, args, options) => run(exe, ["-readrate", "0.1", ...args], options)
  const { plan } = await service.exports.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })
  service.exports.start(plan.planId)
  for (let i = 0; i < 100 && service.exports.job.state !== "running"; i++) await delay(20)
  await delay(250); service.exports.cancel(service.exports.job.jobId); await service.exports.active.done
  assert.equal(service.exports.job.state, "cancelled"); assert.equal(fs.existsSync(destination), false)
  // Cancel the actual bounded FFprobe before it produces a timing result.
  const originalProbe = service.runPackets
  service.runPackets = (...args) => { const child = originalProbe(...args); child.cancel(); return child }
  await assert.rejects(service.inspectTrim(request(0, 12)), { code: "CANCELLED" })
  assert.equal(service.pending, null); assert.equal(service.source.dto.sourceId, source.sourceId)
  await service.shutdown(); assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".cliply-export-")), false)
  const evidence = { inventories, commands, scans, probeCommands, refusals, cancellationDrained: true, packetCancellationDrained: true, collisionPreserved: true, sequentialSameSource: true, partialsRemoved: true }
  fs.writeFileSync(path.join(directory, "trim-evidence.json"), JSON.stringify(evidence, null, 2) + "\n"); return evidence
}
if (require.main === module) {
  const [directory, ffmpeg, ffprobe] = process.argv.slice(2)
  if (![directory, ffmpeg, ffprobe].every(value => value && path.isAbsolute(value))) throw new Error("Usage: node scripts/smoke-local-trim.js <new-task-dir> <project-ffmpeg> <verified-ffprobe>")
  runNative({ directory, ffmpeg, ffprobe }).then(result => console.log(JSON.stringify({ passedOutputs: result.inventories.length, evidence: path.join(directory, "trim-evidence.json") }))).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { fixtures, runNative }

async function runUI({ window, service, userData }) {
  const wc = window.webContents, js = code => wc.executeJavaScript(code), delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(100) } throw new Error(`Editor UI condition timed out: ${expression}`) }
  const click = label => js(`Array.from(document.querySelectorAll('button,a')).find(e=>e.textContent.trim()===${JSON.stringify(label)})?.click()`)
  const set = (id, value) => js(`(() => { const e=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  service.selectFile = async () => path.join(userData, "gop.mp4")
  service.exports.selectDestination = async () => path.join(userData, "ui-edited.mp4")
  await click("Open local file"); await wait("!!document.getElementById('trim-start')")
  const sourceId = service.source.dto.sourceId
  await wait("document.querySelector('video').readyState >= 2")
  await js("document.querySelector('video').muted=true; document.querySelector('video').play()")
  await wait("document.querySelector('video').currentTime>0.1")
  await js("document.querySelector('video').pause()")
  await set("trim-start", "4"); await set("trim-end", "8")
  await js("const mode=document.querySelector('select[aria-label=\"What to export\"]'); mode.value='remove';mode.dispatchEvent(new Event('change',{bubbles:true}))")
  await wait("document.getElementById('trim-panel').textContent.includes('2 parts')")
  await click("Preview retained video")
  await wait("!document.querySelector('video').paused")
  await js("document.querySelector('video').currentTime=3.99")
  await wait("document.querySelector('video').currentTime>=8")
  await click("Stop edit preview")
  await click("Review cut boundaries")
  await wait("document.getElementById('trim-panel').textContent.includes('Planned content:')")
  assert.equal(service.trimPlan.cuts.length, 2)
  await click("Choose destination"); await wait("document.body.textContent.includes('Save as: ui-edited.mp4')")
  await click("Export edited video"); await wait("document.body.textContent.includes('Clip saved')")
  assert.equal(service.source.dto.sourceId, sourceId)
  assert.equal(service.exports.job.state, "completed")
  if (process.env.CLIPLY_SMOKE_EVIDENCE) {
    const directory = process.env.CLIPLY_SMOKE_EVIDENCE; fs.mkdirSync(directory, { recursive: true })
    await js("document.getElementById('trim-panel').scrollIntoView()"); await delay(150)
    fs.writeFileSync(path.join(directory, "editor-en-light.png"), (await wc.capturePage()).toPNG())
    await click("ru"); await click("переключить тему"); await delay(150)
    fs.writeFileSync(path.join(directory, "editor-ru-dark.png"), (await wc.capturePage()).toPNG()); await click("en")
  }
  await click("Back to downloads"); await click("Return to local file")
  await wait("document.getElementById('trim-start')?.value==='4'")
  assert.equal(await js("document.getElementById('trim-end').value"), "8")
  // A fresh grant does not invalidate an original-source edit plan.
  await click("Review cut boundaries"); await wait("document.getElementById('trim-panel').textContent.includes('Planned content:')")
  service.exports.selectDestination = async () => path.join(userData, "ui-cancel.mp4")
  const run = service.exports.runProcess
  service.exports.runProcess = (exe, args, options) => run(exe, ["-readrate", "0.1", ...args], options)
  await click("Choose destination"); await wait("document.body.textContent.includes('Save as: ui-cancel.mp4')")
  await click("Export edited video"); await wait("document.body.textContent.includes('Saving clip')")
  await click("Cancel clip"); await wait("document.body.textContent.includes('Clip cancelled')")
  assert.equal(service.exports.active, null)
  assert.equal(fs.existsSync(path.join(userData, "ui-cancel.mp4")), false)
  assert.equal(fs.readdirSync(userData).some(name => name.startsWith('.cliply-export-')), false)
  service.exports.runProcess = run
  service.selectFile = async () => path.join(userData, "ui-edited.mp4")
  await click("Change file"); await wait("document.getElementById('trim-start')?.value==='0'")
  await wait("document.querySelector('video').readyState>=2")
  await js("document.querySelector('video').muted=true;document.querySelector('video').play()")
  await wait("document.querySelector('video').currentTime>0.1")
  await js("document.querySelector('video').pause()")
  assert.equal(await js("document.querySelector('button[aria-label=Undo]').disabled"), true)
  const compatibility = []
  for (const filename of ["compatible.mkv", ...(process.platform === "darwin" ? ["he-aac.mp4"] : [])]) {
    service.selectFile = async () => path.join(userData, filename)
    await click("Change file"); await wait(`document.querySelector('main')?.textContent.includes(${JSON.stringify(filename)})`)
    await wait("document.querySelector('video').readyState>=2 || !!document.querySelector('video').error")
    const ready = await js("document.querySelector('video').readyState>=2")
    if (ready) {
      await js("document.querySelector('video').muted=true; document.querySelector('video').play()")
      await wait("document.querySelector('video').currentTime>0.1")
      await js("document.querySelector('video').pause()")
    }
    compatibility.push({ filename, nativePlayback: ready })
    assert(ready, `native playback for ${filename}`)
  }
  if (process.env.CLIPLY_SMOKE_EVIDENCE) fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, "editor-playback.json"), JSON.stringify(compatibility, null, 2))
  console.log("Native visual editor: middle removal, retained preview, joined export, route return, cancellation and output playback passed")
}

module.exports.runUI = runUI
