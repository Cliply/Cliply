// Synthetic Stage 4 acceptance. Explicit verified helpers; no downloads, user
// files, new runner or external requests. Caller owns and removes the directory.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { spawnSync } = require("node:child_process")
const { LocalMediaService } = require("../src/main/services/local-media")
const { startExportProcess } = require("../src/main/services/local-media/export-process")
const { planTracks } = require("../src/main/services/local-media/export-plan")
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function fixtures(directory, ffmpeg) {
  fs.mkdirSync(directory, { recursive: true })
  const subtitle = path.join(directory, "captions.srt")
  fs.writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:02,000\nSynthetic caption\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond caption\n")
  const make = (name, args) => command(ffmpeg, ["-v", "error", ...args, path.join(directory, name)])
  for (const extension of ["mp4", "mov", "mkv"]) {
    make(`tracks.${extension}`, ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-f", "lavfi", "-i", "sine=frequency=880", "-i", subtitle,
      "-t", "4", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", extension === "mkv" ? "srt" : "mov_text",
      "-metadata", "title=Track fixture", "-metadata", "artist=Cliply", "-metadata", "comment=Synthetic media",
      "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=Primary", "-metadata:s:a:0", "handler_name=Primary",
      "-metadata:s:a:1", "language=rus", "-metadata:s:a:1", "title=Alternate", "-metadata:s:a:1", "handler_name=Alternate",
      "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=Captions", "-disposition:a:0", "default", "-disposition:a:1", "0", "-disposition:s:0", "forced"])
    if (extension !== "mkv") make(`rotated.${extension}`, ["-display_rotation:v:0", "90", "-i", path.join(directory, `tracks.${extension}`), "-map", "0", "-c", "copy"])
  }
  const chapters = path.join(directory, "chapters.txt"), attachment = path.join(directory, "attachment.txt")
  fs.writeFileSync(chapters, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=First\n")
  fs.writeFileSync(attachment, "Synthetic attachment; must be explicitly removed.\n")
  make("special.mkv", ["-i", path.join(directory, "tracks.mkv"), "-f", "ffmetadata", "-i", chapters, "-map", "0", "-c", "copy", "-map_metadata", "0", "-map_chapters", "1", "-attach", attachment, "-metadata:s:t", "mimetype=text/plain"])
  make("cover.png", ["-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", "-c:v", "png"])
  make("cover.mp4", ["-i", path.join(directory, "tracks.mp4"), "-i", path.join(directory, "cover.png"), "-map", "0", "-map", "1:v", "-c", "copy", "-disposition:v:1", "attached_pic"])
}
async function runNative({ directory, ffmpeg, ffprobe }) {
  fixtures(directory, ffmpeg)
  const inventories = [], commands = []
  let selected, destination
  const service = new LocalMediaService({ selectFile: async () => selected, resolveProbe: async () => ffprobe,
    exportOptions: { storagePath: path.join(directory, "state"), resolveFfmpeg: async () => ffmpeg, selectDestination: async () => destination,
      runProcess: (exe, args, options) => { commands.push({ source: path.basename(selected), output: path.basename(destination), args }); return startExportProcess(exe, args, options) } } })
  const inspect = file => {
    const data = JSON.parse(command(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file]))
    data.format.filename = path.basename(file)
    return data
  }
  const extractHash = (file, index) => command(ffmpeg, ["-v", "error", "-i", file, "-map", `0:${index}`, "-c", "copy", "-f", "hash", "-hash", "sha256", "-"])
  async function save(name, source, streamIndexes, removeChapters = false) {
    const before = hash(selected)
    destination = path.join(directory, name)
    const { plan } = await service.exports.prepare({ operation: "removeTracks", sourceId: source.sourceId, streamIndexes, removeChapters })
    service.exports.start(plan.planId); await service.exports.active.done
    assert.equal(service.exports.job.state, "completed", JSON.stringify(service.exports.job))
    const metadata = inspect(destination)
    assert.equal(metadata.streams.length, streamIndexes.length)
    command(ffmpeg, ["-v", "error", "-xerror", "-i", destination, "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"])
    const packets = plan.streamIndexes.map((index, outIndex) => {
      const inputHash = extractHash(selected, index), outputHash = extractHash(destination, outIndex)
      assert.equal(outputHash, inputHash, `${name}: selected ${index} encoded content matches output ${outIndex}`)
      return { sourceIndex: index, outputIndex: outIndex, hash: outputHash }
    })
    assert.equal(hash(selected), before)
    assert.equal(service.source.dto.sourceId, source.sourceId)
    inventories.push({ source: path.basename(selected), output: name, sourceSha256: before, outputSha256: hash(destination), bytes: fs.statSync(destination).size,
      retained: plan.streamIndexes, removed: plan.removedStreamIndexes, sourceUnchanged: true, decoded: true, packets,
      before: inspect(selected), after: metadata })
    return destination
  }
  for (const extension of ["mp4", "mov", "mkv"]) {
    selected = path.join(directory, `tracks.${extension}`)
    const { source } = await service.open()
    assert.equal(source.streams[2].language, "rus")
    for (const [name, indexes] of [["mute", [0]], ["primary", [0, 1, 3]], ["no-subtitle", [0, 1, 2]], ["retained-subtitle", [0, 1, 2, 3]], ["audio-only", [1]]]) {
      await save(`${name}.${extension}`, source, indexes)
    }
    if (extension === "mkv") await save("alternate.mkv", source, [0, 2, 3])
    else assert.throws(() => planTracks(source, { operation: "removeTracks", sourceId: source.sourceId, streamIndexes: [0, 2, 3], removeChapters: false }), { code: "TRACK_DEFAULT" })
  }
  for (const extension of ["mp4", "mov"]) {
    selected = path.join(directory, `rotated.${extension}`)
    const { source } = await service.open()
    assert.equal(source.streams[0].rotation, 90)
    await save(`rotation-kept.${extension}`, source, [0, 1])
  }
  selected = path.join(directory, "special.mkv")
  let { source } = await service.open()
  assert.equal(source.chapterCount, 1)
  assert(source.streams.some(stream => stream.type === "attachment"))
  assert.throws(() => planTracks(source, { operation: "removeTracks", sourceId: source.sourceId, streamIndexes: source.streams.map(stream => stream.index), removeChapters: true }), { code: "TRACK_UNSUPPORTED" })
  assert.throws(() => planTracks(source, { operation: "removeTracks", sourceId: source.sourceId, streamIndexes: [0, 1, 3], removeChapters: false }), { code: "TRACK_CHAPTERS" })
  await save("special-removed.mkv", source, [0, 1, 3], true)
  selected = path.join(directory, "cover.mp4"); ({ source } = await service.open())
  assert(source.streams.some(stream => stream.disposition.attached_pic))
  assert.throws(() => planTracks(source, { operation: "removeTracks", sourceId: source.sourceId, streamIndexes: source.streams.map(stream => stream.index), removeChapters: false }), { code: "TRACK_UNSUPPORTED" })
  const first = await save("cover-removed.mp4", source, [0, 1])
  const firstHash = hash(first)
  await assert.rejects(service.exports.prepare({ operation: "removeTracks", sourceId: source.sourceId, streamIndexes: [0, 1], removeChapters: false }), { code: "OUTPUT_EXISTS" })
  await save("repeat.mp4", source, [0, 1]); assert.equal(hash(first), firstHash)
  const run = service.exports.runProcess
  service.exports.runProcess = (exe, args, options) => run(exe, ["-readrate", "0.1", ...args], options)
  destination = path.join(directory, "cancelled.mp4")
  const { plan } = await service.exports.prepare({ operation: "removeTracks", sourceId: source.sourceId, streamIndexes: [0], removeChapters: false })
  service.exports.start(plan.planId)
  for (let i = 0; i < 100 && service.exports.job.state !== "running"; i++) await delay(20)
  await delay(250); service.exports.cancel(service.exports.job.jobId); await service.exports.active.done
  assert.equal(service.exports.job.state, "cancelled"); assert.equal(fs.existsSync(destination), false)
  await service.shutdown()
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".cliply-export-")), false)
  const evidence = { inventories, commands, repeatedOutputPreserved: true, existingOutputRefused: true, cancellationDrained: true, partialsRemoved: true }
  fs.writeFileSync(path.join(directory, "tracks-evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
  return evidence
}

async function runUI({ window, service, userData }) {
  const wc = window.webContents
  const js = code => wc.executeJavaScript(code, true)
  const wait = async condition => {
    for (let i = 0; i < 100; i++) { if (await js(condition)) return; await delay(100) }
    throw new Error(`Track UI condition timed out: ${condition}`)
  }
  const click = label => js(`Array.from(document.querySelectorAll('button,a')).find(e=>e.textContent.trim()===${JSON.stringify(label)})?.click()`)
  const original = path.join(userData, "tracks.mkv"), originalHash = hash(original)
  service.selectFile = async () => original
  service.exports.selectDestination = async () => path.join(userData, "muted.mkv")
  service.preview.create = async () => { throw new (require("../src/main/services/local-media/errors").MediaError)("PREVIEW_UNAVAILABLE") }
  await click("Open local file")
  await wait("!!document.getElementById('local-audio-track')")
  await wait("Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('Preview unavailable'))")
  await click("Remove tracks")
  await wait("!!document.getElementById('keep-track-0')")
  assert(await js("Array.from(document.querySelectorAll('#track-removal input[type=checkbox]')).every(e=>e.checked)"))
  await click("Remove all audio")
  assert.deepEqual(await js("Array.from(document.querySelectorAll('#track-removal input:checked')).map(e=>Number(e.id.split('-').pop()))"), [0, 3])
  await click("Choose destination")
  await wait("document.body.textContent.includes('Save as: muted.mkv')")
  await click("Save copy")
  await wait("document.body.textContent.includes('Copy saved')")
  assert.equal(service.exports.job.state, "completed")
  assert.equal(service.source.dto.filename, "tracks.mkv")
  const probe = await service.resolveProbe()
  const result = JSON.parse(command(probe, ["-v", "error", "-show_streams", "-of", "json", path.join(userData, "muted.mkv")]))
  assert.deepEqual(result.streams.map(stream => stream.codec_type), ["video", "subtitle"])
  await click("Back to downloads")
  await wait("document.querySelector('aside')?.textContent.includes('Copy saved')")
  await click("Return to local file")
  await wait("!!document.getElementById('keep-track-0') && !document.getElementById('keep-track-1')?.checked")
  const facts = { previewDeniedForTest: true, retainedIndexes: [0, 3], muted: true, subtitleRetained: true, sourceStillOpen: true, routeSelectionRetained: true }
  if (process.env.CLIPLY_SMOKE_EVIDENCE) {
    const dir = process.env.CLIPLY_SMOKE_EVIDENCE; fs.mkdirSync(dir, { recursive: true })
    await js("document.getElementById('track-removal').scrollIntoView()")
    await delay(250); fs.writeFileSync(path.join(dir, "tracks-en-light.png"), (await wc.capturePage()).toPNG())
    await click("ru"); await click("переключить тему"); await delay(250)
    fs.writeFileSync(path.join(dir, "tracks-ru-dark.png"), (await wc.capturePage()).toPNG())
    await click("en")
  }
  await js("document.getElementById('keep-track-2').click()")
  service.exports.selectDestination = async () => path.join(userData, "cancel-copy.mkv")
  service.exports.runProcess = (exe, args, options) => startExportProcess(exe, ["-readrate", "0.1", ...args], options)
  await click("Choose destination")
  await wait("document.body.textContent.includes('Save as: cancel-copy.mkv')")
  await click("Save copy")
  await wait("document.body.textContent.includes('Saving selected tracks')")
  await click("Back to downloads")
  await wait("document.querySelector('aside')?.textContent.includes('Saving selected tracks')")
  await click("Cancel copy")
  await wait("document.querySelector('aside')?.textContent.includes('Copy cancelled')")
  assert.equal(service.exports.active, null)
  assert.equal(fs.existsSync(path.join(userData, "cancel-copy.mkv")), false)
  assert.equal(fs.readdirSync(userData).some(name => name.startsWith(".cliply-export-")), false)
  assert.equal(hash(original), originalHash)
  Object.assign(facts, { cancelledWhileAway: true, noPartialOrCancelledFinal: true, sourceSha256: originalHash, sourceUnchanged: true })
  if (process.env.CLIPLY_SMOKE_EVIDENCE) fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, "tracks-ui.json"), JSON.stringify(facts, null, 2) + "\n")
  console.log("Native track-removal UI passed:", JSON.stringify(facts))
}

if (require.main === module) {
  const [directory, ffmpeg, ffprobe] = process.argv.slice(2)
  if (![directory, ffmpeg, ffprobe].every(value => value && path.isAbsolute(value))) throw new Error("Usage: node scripts/smoke-local-tracks.js <new-task-dir> <project-ffmpeg> <verified-ffprobe>")
  runNative({ directory, ffmpeg, ffprobe }).then(result => console.log(JSON.stringify({ passedOutputs: result.inventories.length, cancellationDrained: result.cancellationDrained, evidence: path.join(directory, "tracks-evidence.json") }))).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { fixtures, runNative, runUI }
