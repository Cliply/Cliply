// Stage 5 synthetic acceptance through the existing LocalExport supervisor.
// Fixtures may encode; every production copy must contain only -c copy.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { spawnSync } = require("node:child_process")
const { LocalMediaService } = require("../src/main/services/local-media")
const { startExportProcess } = require("../src/main/services/local-media/export-process")
const { planRemux } = require("../src/main/services/local-media/export-plan")
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
function command(exe, args, binary = false) {
  const result = spawnSync(exe, args, { encoding: binary ? null : "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(result.status, 0, String(result.stderr))
  return result.stdout
}
function fixtures(directory, ffmpeg) {
  require("./smoke-local-tracks").fixtures(directory, ffmpeg)
  const make = (name, args) => command(ffmpeg, ["-v", "error", ...args, path.join(directory, name)])
  make("default.mkv", ["-i", path.join(directory, "tracks.mkv"), "-map", "0", "-c", "copy", "-disposition:v:0", "default"])
  make("chapters.mp4", ["-i", path.join(directory, "tracks.mp4"), "-f", "ffmetadata", "-i", path.join(directory, "chapters.txt"), "-map", "0", "-c", "copy", "-map_metadata", "0", "-map_chapters", "1"])
  make("opus.mkv", ["-i", path.join(directory, "default.mkv"), "-map", "0:v", "-map", "0:a:0", "-c:v", "copy", "-c:a", "libopus"])
  make("chapters.mov", ["-i", path.join(directory, "tracks.mov"), "-f", "ffmetadata", "-i", path.join(directory, "chapters.txt"), "-map", "0", "-c", "copy", "-map_metadata", "0", "-map_chapters", "1"])
  for (const rate of [44100, 48000]) make(`stereo-${rate}.mp4`, ["-i", path.join(directory, "tracks.mp4"), "-map", "0:v", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", "-ar", String(rate), "-ac", "2"])
  fs.copyFileSync(path.join(directory, "tracks.mp4"), path.join(directory, "wrong.mov"))
}
async function runNative({ directory, ffmpeg, ffprobe }) {
  fixtures(directory, ffmpeg)
  const inventories = [], commands = [], refusals = []
  let selected, destination
  const service = new LocalMediaService({ selectFile: async () => selected, resolveProbe: async () => ffprobe,
    exportOptions: { storagePath: path.join(directory, "state"), resolveFfmpeg: async () => ffmpeg, selectDestination: async () => destination,
      runProcess: (exe, args, options) => {
        assert.deepEqual(args.filter((_arg, i) => args[i - 1] === "-c"), ["copy"])
        assert(!args.some(arg => /^-(c:|codec|vf|af|ss$|t$)/.test(arg)))
        commands.push({ input: path.basename(selected), output: path.basename(destination), args })
        return startExportProcess(exe, args, options)
      } } })
  const inspect = file => { const data = JSON.parse(command(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file])); data.format.filename = path.basename(file); return data }
  const request = (source, targetContainer, streamIndexes, removeChapters = false) => ({ operation: "remux", sourceId: source.sourceId, targetContainer, streamIndexes, removeChapters })
  const open = async name => { selected = path.join(directory, name); return (await service.open()).source }
  function compare(source, beforeIndex, output, afterIndex, type, channels) {
    const args = (file, index) => ["-v", "error", "-noautorotate", "-i", file, "-map", `0:${index}`, ...(type === "video" ? ["-fps_mode", "passthrough", "-pix_fmt", "yuv420p", "-f", "rawvideo"] : ["-c:a", "pcm_s16le", "-f", "s16le"]), "-"]
    const before = command(ffmpeg, args(source, beforeIndex), true), after = command(ffmpeg, args(output, afterIndex), true)
    if (type === "video") { assert.equal(hash(after), hash(before)); return { type, sourceIndex: beforeIndex, outputIndex: afterIndex, decodedSha256: hash(after), exact: true } }
    // Container priming/edit-list rounding can expose one AAC frame at an edge.
    // Require the entire aligned decoded overlap to be bit-identical, with only
    // <= 2048 sample frames of edge difference and >98% retained samples.
    const anchor = 16000 * channels, offset = after.indexOf(before.subarray(anchor, anchor + 8000 * channels))
    assert(offset >= 0, "decoded audio anchor exists")
    const shift = offset - anchor, lo = Math.max(0, -shift), hi = Math.min(before.length, after.length - shift)
    assert(Math.abs(shift) <= 2048 * channels * 2)
    assert(Math.abs(before.length - after.length) <= 2048 * channels * 2)
    assert((hi - lo) / Math.max(before.length, after.length) > 0.98)
    assert.equal(hash(before.subarray(lo, hi)), hash(after.subarray(lo + shift, hi + shift)))
    return { type, sourceIndex: beforeIndex, outputIndex: afterIndex, beforeSampleFrames: before.length / (2 * channels), afterSampleFrames: after.length / (2 * channels), shiftSampleFrames: shift / (2 * channels), overlapSha256: hash(before.subarray(lo, hi)), overlapExact: true }
  }
  async function save(input, name, target, indexes, removeChapters = false) {
    const source = await open(input), sourceHash = hash(fs.readFileSync(selected)); destination = path.join(directory, name)
    const { plan } = await service.exports.prepare(request(source, target, indexes, removeChapters))
    service.exports.start(plan.planId); await service.exports.active.done
    assert.equal(service.exports.job.state, "completed", JSON.stringify(service.exports.job))
    const content = plan.streamIndexes.flatMap((index, i) => { const stream = source.streams.find(s => s.index === index); return ["video", "audio"].includes(stream.type) ? [compare(selected, index, destination, i, stream.type, stream.channels)] : [] })
    command(ffmpeg, ["-v", "error", "-xerror", "-i", destination, "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"])
    assert.equal(hash(fs.readFileSync(selected)), sourceHash); assert.equal(service.source.dto.sourceId, source.sourceId)
    inventories.push({ input, output: name, sourceContainer: source.contentContainer, sourceSha256: sourceHash, outputSha256: hash(fs.readFileSync(destination)), retained: plan.streamIndexes, removed: plan.removedStreamIndexes, content, before: inspect(selected), after: inspect(destination), sourceUnchanged: true, sourceStillOpen: true })
  }
  for (const [input, name, target, indexes, remove] of [
    ["tracks.mp4", "mp4-to.mkv", "mkv", [0, 1, 2]], ["default.mkv", "mkv-to.mp4", "mp4", [0, 1, 2]],
    ["default.mkv", "mkv-to.mov", "mov", [0, 1, 2]], ["tracks.mov", "mov-to.mp4", "mp4", [0, 1, 2, 3]],
    ["tracks.mp4", "mp4-to.mov", "mov", [0, 1, 2]], ["tracks.mov", "mov-to.mkv", "mkv", [0, 1, 2]],
    ["wrong.mov", "wrong-to.mkv", "mkv", [0, 1, 2]], ["chapters.mp4", "chapters-kept.mkv", "mkv", [0, 1, 2]],
    ["chapters.mov", "mov-chapters-kept.mkv", "mkv", [0, 1, 2]],
    ["stereo-44100.mp4", "stereo44.mkv", "mkv", [0, 1]], ["stereo-48000.mp4", "stereo48.mkv", "mkv", [0, 1]],
    ["stereo48.mkv", "stereo48.mp4", "mp4", [0, 1]], ["stereo44.mkv", "stereo44.mov", "mov", [0, 1]],
    ["chapters.mp4", "chapters-removed.mov", "mov", [0, 1, 2], true], ["rotated.mov", "portrait.mp4", "mp4", [0, 1]],
    ["rotated.mp4", "portrait.mov", "mov", [0, 1]]
  ]) await save(input, name, target, indexes, remove)
  for (const [input, target, indexes, code] of [
    ["tracks.mp4", "mov", [0, 1, 2, 3], "TRACK_UNSUPPORTED"], ["tracks.mp4", "mkv", [0, 1, 2, 3], "TRACK_UNSUPPORTED"], ["default.mkv", "mp4", [0, 1, 2, 3], "TRACK_UNSUPPORTED"],
    ["opus.mkv", "mp4", [0, 1], "TRACK_UNSUPPORTED"], ["tracks.mkv", "mp4", [0, 1], "TRACK_DEFAULT"],
    ["chapters.mp4", "mov", [0, 1], "REMUX_CHAPTERS"], ["rotated.mp4", "mkv", [0, 1], "TRACK_UNSUPPORTED"]
  ]) { const source = await open(input); assert.throws(() => planRemux(source, request(source, target, indexes)), { code }); refusals.push({ input, target, indexes, code }) }
  let source = await open("opus.mkv")
  await save("opus.mkv", "opus-removed.mp4", "mp4", [0])
  source = service.source.dto; destination = path.join(directory, "opus-removed.mp4")
  const original = hash(fs.readFileSync(destination))
  await assert.rejects(service.exports.prepare(request(source, "mp4", [0])), { code: "OUTPUT_EXISTS" })
  assert.equal(hash(fs.readFileSync(destination)), original)
  destination = path.join(directory, "cancelled.mp4")
  const run = service.exports.runProcess
  service.exports.runProcess = (exe, args, options) => run(exe, ["-readrate", "0.1", ...args], options)
  const { plan } = await service.exports.prepare(request(source, "mp4", [0]))
  service.exports.start(plan.planId)
  for (let i = 0; i < 100 && service.exports.job.state !== "running"; i++) await delay(20)
  await delay(250); service.exports.cancel(service.exports.job.jobId); await service.exports.active.done
  assert.equal(service.exports.job.state, "cancelled"); assert.equal(fs.existsSync(destination), false)
  await service.shutdown(); assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".cliply-export-")), false)
  const evidence = { inventories, commands, refusals, cancellationDrained: true, collisionPreserved: true, partialsRemoved: true }
  fs.writeFileSync(path.join(directory, "remux-evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
  return evidence
}
async function runUI({ window, service, userData }) {
  const wc = window.webContents, js = code => wc.executeJavaScript(code, true)
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(100) }
    throw new Error(`Remux UI condition timed out: ${expression}`)
  }
  const click = label => js(`Array.from(document.querySelectorAll('button,a')).find(e=>e.textContent.trim()===${JSON.stringify(label)})?.click()`)
  const select = value => js(`(() => { const el=document.getElementById('target-container'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  const original = path.join(userData, "tracks.mp4"), originalHash = hash(fs.readFileSync(original))
  service.selectFile = async () => original
  service.exports.selectDestination = async () => path.join(userData, "ui-copy.mkv")
  const previewCreate = service.preview.create
  service.preview.create = async () => { throw new (require("../src/main/services/local-media/errors").MediaError)("PREVIEW_UNAVAILABLE") }
  await click("Open local file"); await wait("!!document.getElementById('trim-panel')")
  await click("Change format"); await wait("!!document.getElementById('target-container')")
  assert(await js("Array.from(document.querySelectorAll('#container-change input[type=checkbox]')).every(e=>e.checked)"))
  await select("mkv")
  await wait("document.getElementById('container-change').textContent.includes('Explicitly remove')")
  assert(await js("document.getElementById('keep-track-3').checked"))
  await js("document.getElementById('keep-track-3').click()")
  await click("Choose destination"); await wait("document.body.textContent.includes('Save as: ui-copy.mkv')")
  await click("Save copy"); await wait("document.body.textContent.includes('Copy saved')")
  assert.equal(service.source.dto.filename, "tracks.mp4")
  await click("Back to downloads"); await wait("document.querySelector('aside')?.textContent.includes('Copy saved')")
  await click("Return to local file"); await wait("document.getElementById('target-container')?.value === 'mkv'")
  assert.equal(await js("document.getElementById('keep-track-3').checked"), false)
  const facts = { previewDeniedForFirstCopy: true, allStreamsInitiallyKept: true, incompatibleSubtitleExplicitlyRemoved: true, routeOptionsRetained: true, sourceStillOpen: true, playback: [] }
  if (process.env.CLIPLY_SMOKE_EVIDENCE) {
    const dir = process.env.CLIPLY_SMOKE_EVIDENCE; fs.mkdirSync(dir, { recursive: true })
    await js("document.getElementById('container-change').scrollIntoView()")
    await delay(250); fs.writeFileSync(path.join(dir, "remux-en-light.png"), (await wc.capturePage()).toPNG())
    await click("ru"); await click("переключить тему"); await delay(250)
    fs.writeFileSync(path.join(dir, "remux-ru-dark.png"), (await wc.capturePage()).toPNG())
    await click("en")
  }
  // Exercise cancel while away using this operation's shared local job.
  service.exports.selectDestination = async () => path.join(userData, "cancel-remux.mkv")
  const run = service.exports.runProcess
  service.exports.runProcess = (exe, args, options) => run(exe, ["-readrate", "0.1", ...args], options)
  await click("Choose destination"); await wait("document.body.textContent.includes('Save as: cancel-remux.mkv')")
  await click("Save copy"); await wait("document.body.textContent.includes('Saving selected tracks')")
  await click("Back to downloads"); await wait("document.querySelector('aside')?.textContent.includes('Saving selected tracks')")
  await click("Cancel copy"); await wait("document.querySelector('aside')?.textContent.includes('Copy cancelled')")
  assert.equal(service.exports.active, null); assert.equal(fs.existsSync(path.join(userData, "cancel-remux.mkv")), false)
  service.exports.runProcess = run; service.preview.create = previewCreate
  await click("Return to local file"); await wait("!!document.getElementById('target-container')")
  // These explicit test opens emulate the user opening a completed output.
  // Production export never replaces the source automatically.
  service.selectFile = async () => path.join(userData, "default.mkv")
  await click("Change file"); await wait("document.querySelector('main')?.textContent.includes('default.mkv') && !!document.getElementById('trim-panel')")
  const source = service.source.dto
  for (const targetContainer of ["mp4", "mov"]) {
    service.exports.selectDestination = async () => path.join(userData, `ui-copy.${targetContainer}`)
    const { plan } = await service.exports.prepare({ operation: "remux", sourceId: source.sourceId, targetContainer, streamIndexes: [0, 1, 2], removeChapters: false })
    service.exports.start(plan.planId); await service.exports.active.done; assert.equal(service.exports.job.state, "completed")
  }
  for (const extension of ["mkv", "mp4", "mov"]) {
    service.selectFile = async () => path.join(userData, `ui-copy.${extension}`)
    await click("Change file")
    for (let i = 0; i < 100 && service.source?.dto.filename !== `ui-copy.${extension}`; i++) await delay(100)
    assert.equal(service.source?.dto.filename, `ui-copy.${extension}`)
    for (let i = 0; i < 100 && service.preview.grant?.sourceId !== service.source.dto.sourceId; i++) await delay(100)
    assert.equal(service.preview.grant?.sourceId, service.source.dto.sourceId)
    await wait(`document.querySelector('video')?.getAttribute('src') === ${JSON.stringify(service.preview.grant.url)} && (document.querySelector('video')?.readyState >= 2 || Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('Preview unavailable')))`)
    const playback = await js(`(async()=>{ const v=document.querySelector('video'); if (!v || v.readyState<2) return {extension:${JSON.stringify(extension)}, available:false}; v.muted=true; await v.play(); await new Promise(r=>setTimeout(r,800)); const progressed=v.currentTime>0;v.pause();await Promise.race([new Promise((resolve,reject)=>{v.addEventListener('seeked',resolve,{once:true});v.addEventListener('error',reject,{once:true});v.currentTime=2}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('output seek timed out')),5000))]);return {extension:${JSON.stringify(extension)},available:true,progressed,seek:v.currentTime,duration:v.duration}; })()`)
    console.log("Remux playback:", JSON.stringify(playback))
    if (playback.available) { assert(playback.progressed); assert.equal(playback.seek, 2) }
    facts.playback.push(playback)
  }
  assert(facts.playback.some(item => item.extension === "mp4" && item.available))
  assert.equal(hash(fs.readFileSync(original)), originalHash)
  assert.equal(fs.readdirSync(userData).some(name => name.startsWith(".cliply-export-")), false)
  Object.assign(facts, { cancelledWhileAway: true, sourceUnchanged: true, noPartials: true })
  if (process.env.CLIPLY_SMOKE_EVIDENCE) fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, "remux-ui.json"), JSON.stringify(facts, null, 2) + "\n")
  console.log("Native remux UI passed:", JSON.stringify(facts))
}

if (require.main === module) {
  const [directory, ffmpeg, ffprobe] = process.argv.slice(2)
  if (![directory, ffmpeg, ffprobe].every(value => value && path.isAbsolute(value))) throw new Error("Usage: node scripts/smoke-local-remux.js <new-task-dir> <project-ffmpeg> <verified-ffprobe>")
  runNative({ directory, ffmpeg, ffprobe }).then(result => console.log(JSON.stringify({ passedOutputs: result.inventories.length, evidence: path.join(directory, "remux-evidence.json") }))).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { fixtures, runNative, runUI }
