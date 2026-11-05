const { pickOption } = require("./smoke-pick-option")
// Real, synthetic extraction checks. All media and crash-ledger files live in
// the caller's task-owned directory; this script never downloads helpers.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { spawn, spawnSync } = require("node:child_process")
const { LocalMediaService } = require("../src/main/services/local-media")
const { startExportProcess } = require("../src/main/services/local-media/export-process")
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function fixtures(directory, ffmpeg) {
  fs.mkdirSync(directory, { recursive: true })
  const make = (name, args) => command(ffmpeg, ["-v", "error", ...args, path.join(directory, name)])
  make("alternate.mkv", ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-f", "lavfi", "-i", "sine=frequency=880", "-t", "5", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "ffv1", "-c:a", "aac", "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English", "-metadata:s:a:1", "language=rus", "-metadata:s:a:1", "title=Alternate Russian"])
  for (const [name, codec] of [["aac.m4a", "aac"], ["aac.aac", "aac"], ["mp3.mp3", "libmp3lame"], ["mp3.mkv", "libmp3lame"], ["pcm.wav", "pcm_s16le"], ["pcm.mov", "pcm_s16le"], ["pcm.mkv", "pcm_s16le"]]) {
    make(name, ["-f", "lavfi", "-i", "sine=frequency=660", "-t", "5", "-c:a", codec, "-ac", ["aac.m4a", "mp3.mp3", "pcm.wav"].includes(name) ? "2" : "1"])
  }
  fs.writeFileSync(path.join(directory, "chapters.txt"), ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=Opening\n")
  make("chapters.mp3", ["-i", path.join(directory, "mp3.mp3"), "-f", "ffmetadata", "-i", path.join(directory, "chapters.txt"), "-map", "0:a", "-map_chapters", "1", "-c", "copy"])
}

async function runNative({ directory, ffmpeg, ffprobe }) {
  fixtures(directory, ffmpeg)
  let selected, output, capturedPid
  const commands = [], inventory = []
  const service = new LocalMediaService({ selectFile: async () => selected, resolveProbe: async () => ffprobe,
    exportOptions: { storagePath: path.join(directory, "state"), resolveFfmpeg: async () => ffmpeg,
      selectDestination: async () => output,
      runProcess: (exe, args, options) => {
        commands.push(args)
        return startExportProcess(exe, args, { ...options, spawnProcess: (...spawnArgs) => {
          const child = spawn(...spawnArgs); child.on("message", message => { capturedPid = message.helperPid }); return child
        } })
      }
    } })
  for (const name of ["alternate.mkv", "aac.m4a", "aac.aac", "mp3.mp3", "chapters.mp3", "mp3.mkv", "pcm.wav", "pcm.mov", "pcm.mkv"]) {
    selected = path.join(directory, name); const before = hash(selected)
    const { source } = await service.open()
    const index = name === "alternate.mkv" ? 2 : 0
    const profile = source.extractionProfiles.find(p => p.streamIndex === index)
    assert(profile, `${name} has an enabled profile`)
    output = path.join(directory, `extracted-${name}.${profile.extension}`)
    const prepared = await service.exports.prepare({ operation: "extractAudio", sourceId: source.sourceId, streamIndex: index })
    if (name === "alternate.mkv") { assert.equal(prepared.plan.language, "rus"); assert.equal(prepared.plan.title, "Alternate Russian") }
    service.exports.start(prepared.plan.planId); await service.exports.active.done
    assert.equal(service.exports.job.state, "completed", JSON.stringify(service.exports.job))
    assert.equal(hash(selected), before, "source hash unchanged")
    assert.equal(service.source.dto.sourceId, source.sourceId, "original stays open")
    command(ffmpeg, ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"])
    const metadata = JSON.parse(command(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]))
    assert.equal(metadata.streams.length, 1)
    if (name === "chapters.mp3") {
      const chapters = JSON.parse(command(ffprobe, ["-v", "error", "-show_chapters", "-of", "json", output])).chapters
      assert.equal(chapters.length, 1)
      assert.equal(chapters[0].tags.title, "Opening")
    }
    const packetHash = file => command(ffmpeg, ["-v", "error", "-i", file, "-map", file === selected ? `0:${index}` : "0:0", "-c", "copy", ...(profile.extension === "aac" ? ["-bsf:a", "aac_adtstoasc"] : []), "-f", "hash", "-hash", "sha256", "-"])
    assert.equal(packetHash(selected), packetHash(output), "only the selected encoded audio packets are copied")
    inventory.push({ source: name, sourceSha256: before, selectedIndex: index, codec: metadata.streams[0].codec_name,
      duration: Number(metadata.format.duration), bytes: fs.statSync(output).size, decoded: true, packetHashMatched: true })
    // Repeat to a fresh name; the first output must survive unchanged.
    if (name === "alternate.mkv") {
      const completedHash = hash(output); const first = output
      output = path.join(directory, "repeat.aac")
      const repeat = await service.exports.prepare({ operation: "extractAudio", sourceId: source.sourceId, streamIndex: index })
      service.exports.start(repeat.plan.planId); await service.exports.active.done
      assert.equal(service.exports.job.state, "completed"); assert.equal(hash(first), completedHash)
    }
  }
  // Deliberately slow a real copy in the test harness, then cancel while writing.
  selected = path.join(directory, "pcm.wav"); output = path.join(directory, "cancelled.wav")
  const { source } = await service.open()
  const normal = service.exports.runProcess
  service.exports.runProcess = (exe, args, options) => normal(exe, ["-readrate", "1", ...args], options)
  const plan = await service.exports.prepare({ operation: "extractAudio", sourceId: source.sourceId, streamIndex: 0 })
  service.exports.start(plan.plan.planId)
  for (let i = 0; i < 100 && service.exports.job.state !== "running"; i++) await delay(20)
  await delay(250)
  service.exports.cancel(service.exports.job.jobId); await service.exports.active.done
  assert.equal(service.exports.job.state, "cancelled"); assert.equal(fs.existsSync(output), false)
  assert.throws(() => process.kill(capturedPid, 0), error => error.code === "ESRCH")
  await service.shutdown()
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".cliply-export-")), false)
  const crash = await crashCheck({ directory, ffmpeg, ffprobe })
  const evidence = { inventory, commands, cancelledNativeWriterExited: true, repeatedExportPreserved: true, crash }
  fs.writeFileSync(path.join(directory, "extraction-evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
  return evidence
}

async function crashCheck({ directory, ffmpeg, ffprobe }) {
  const config = { directory, ffmpeg, ffprobe, root: path.resolve(__dirname, "..") }
  const code = `
    const fs = require('fs'), path = require('path'), {spawn} = require('child_process');
    const c = ${JSON.stringify(config)};
    const {LocalMediaService} = require(path.join(c.root,'src/main/services/local-media'));
    const {startExportProcess} = require(path.join(c.root,'src/main/services/local-media/export-process'));
    (async()=>{
      const service = new LocalMediaService({selectFile:async()=>path.join(c.directory,'pcm.wav'),resolveProbe:async()=>c.ffprobe,
        exportOptions:{storagePath:path.join(c.directory,'crash-state'),resolveFfmpeg:async()=>c.ffmpeg,
          selectDestination:async()=>path.join(c.directory,'crash.wav'),
          runProcess:(exe,args,options)=>startExportProcess(exe,['-readrate','0.1',...args],{...options,spawnProcess:(...args)=>{
            const worker=spawn(...args);worker.on('message',m=>{if(m.helperPid)fs.writeFileSync(path.join(c.directory,'crash-pids.json'),JSON.stringify({worker:worker.pid,helper:m.helperPid}))});return worker;
          }})}});
      const {source}=await service.open();const {plan}=await service.exports.prepare({sourceId:source.sourceId,operation:'extractAudio',streamIndex:0});service.exports.start(plan.planId);
    })().catch(e=>{console.error(e);process.exit(1)});
  `
  const owner = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "ignore", "pipe"] })
  let diagnostics = ""; owner.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000) })
  const pidFile = path.join(directory, "crash-pids.json")
  try {
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await delay(20)
    assert(fs.existsSync(pidFile), diagnostics)
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"))
    const closed = new Promise(resolve => owner.once("close", resolve)); owner.kill("SIGKILL"); await closed
    const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === "ESRCH") return false; throw error } }
    for (let i = 0; i < 200 && (alive(pids.worker) || alive(pids.helper)); i++) await delay(20)
    assert.equal(alive(pids.worker), false, "orphan supervisor exited")
    assert.equal(alive(pids.helper), false, "orphan FFmpeg exited")
    const { LocalExport } = require("../src/main/services/local-media/export")
    const recovery = new LocalExport({ storagePath: path.join(directory, "crash-state") }); await recovery.ready
    assert.equal(recovery.job.state, "interrupted")
    assert.equal(fs.existsSync(path.join(directory, "crash.wav")), false)
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".cliply-export-")), false)
    return { ownerKilled: true, supervisorExited: true, ffmpegExited: true, interruptedPartialCleaned: true, noFinalOutput: true }
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM") }
}

async function runUI({ window, service, userData }) {
  const wc = window.webContents
  const js = code => wc.executeJavaScript(code, true)
  const wait = async condition => {
    for (let i = 0; i < 100; i++) { if (await js(condition)) return; await delay(100) }
    throw new Error(`Export UI condition timed out: ${condition}`)
  }
  const click = label => js(`Array.from(document.querySelectorAll('button,a')).find(e=>(e.getAttribute('aria-label') || e.textContent.trim())===${JSON.stringify(label)})?.click()`)
  service.selectFile = async () => path.join(userData, "alternate.mkv")
  // Force preview unavailability independently of Chromium codec/platform support.
  service.preview.create = async () => { throw new (require("../src/main/services/local-media/errors").MediaError)("PREVIEW_UNAVAILABLE") }
  await click("Open local file")
  await wait("!!document.getElementById('trim-panel')"); await click("Extract audio")
  await wait("!!document.getElementById('local-audio-track')")
  await wait("Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('Preview unavailable'))")
  await pickOption(js, "local-audio-track", "2")
  await click("Choose destination")
  await wait("document.body.textContent.includes('Save as: extracted.aac')")
  await js("Array.from(document.querySelectorAll('#audio-extraction button')).find(e=>e.textContent.trim()==='Extract audio').click()")
  await wait("document.body.textContent.includes('Audio saved')")
  assert.equal(service.exports.job.state, "completed")
  assert.equal(service.source.dto.filename, "alternate.mkv")
  await click("Back to downloads")
  await wait("!!document.querySelector('aside') && document.querySelector('aside').textContent.includes('Audio saved')")
  await click("Return to local file")
  await wait("document.getElementById('local-audio-track')?.value === '2'")
  // Keep a real writer active while leaving the route, then cancel from the
  // global status. readrate is test-only; production always copies at full speed.
  service.exports.selectDestination = async () => path.join(userData, "cancelled-ui.aac")
  service.exports.runProcess = (exe, args, options) => startExportProcess(exe, ["-readrate", "0.1", ...args], options)
  await click("Choose destination")
  await wait("document.body.textContent.includes('Save as: cancelled-ui.aac')")
  await js("Array.from(document.querySelectorAll('#audio-extraction button')).find(e=>e.textContent.trim()==='Extract audio').click()")
  await wait("document.body.textContent.includes('Extracting audio')")
  await click("Back to downloads")
  await wait("!!document.querySelector('aside') && document.querySelector('aside').textContent.includes('Extracting audio')")
  await click("Cancel extraction")
  await wait("document.querySelector('aside')?.textContent.includes('Extraction cancelled')")
  assert.equal(service.exports.active, null)
  assert.equal(service.source.dto.filename, "alternate.mkv")
  assert.equal(fs.existsSync(path.join(userData, "cancelled-ui.aac")), false)
  assert.equal(fs.readdirSync(userData).some(name => name.startsWith(".cliply-export-")), false)
  await click("Return to local file")
  await wait("document.getElementById('local-audio-track')?.value === '2'")
  if (process.env.CLIPLY_SMOKE_EVIDENCE) {
    const dir = process.env.CLIPLY_SMOKE_EVIDENCE; fs.mkdirSync(dir, { recursive: true })
    await js("document.getElementById('audio-extraction').scrollIntoView()")
    await delay(300); fs.writeFileSync(path.join(dir, "extraction-en-light.png"), (await wc.capturePage()).toPNG())
    await require("./smoke-editor-workspace").setPreferences({ window, locale: "ru", dark: true }); await delay(300)
    fs.writeFileSync(path.join(dir, "extraction-ru-dark.png"), (await wc.capturePage()).toPNG())
    fs.writeFileSync(path.join(dir, "extraction-ui.json"), JSON.stringify({ selectedStream: 2, nativePreviewUnavailable: true, previewDeniedForTest: true, extracted: "completed", sourceStillOpen: true, routeStatusAndSelectionRetained: true, cancelledWhileAway: service.exports.job.state, partialRemoved: true }, null, 2) + "\n")
  }
}

if (require.main === module) {
  const [directory, ffmpeg, ffprobe] = process.argv.slice(2)
  if (![directory, ffmpeg, ffprobe].every(value => value && path.isAbsolute(value))) throw new Error("Usage: node scripts/smoke-local-export.js <new-task-dir> <project-ffmpeg> <verified-ffprobe>")
  runNative({ directory, ffmpeg, ffprobe }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { fixtures, runNative, runUI }
