// Stage 7: one source session, all four actions, actual native playback.
// Fixtures and outputs belong to the caller's disposable profile.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixtures(directory, ffmpeg, { longMedia = false } = {}) {
  fs.mkdirSync(directory, { recursive: true })
  const make = (name, args) => {
    const result = spawnSync(ffmpeg, ["-v", "error", ...args, path.join(directory, name)], { encoding: "utf8", timeout: longMedia ? 180000 : 30000 })
    assert.equal(result.status, 0, result.stderr)
  }
  make("inspection.wav", ["-f", "lavfi", "-i", "sine=r=8000:d=1", "-c:a", "pcm_s16le"])
  make("session.mp4", ["-f", "lavfi", "-i", longMedia ? "testsrc2=s=1280x720:r=24:d=300" : "testsrc2=s=160x90:r=24:d=12", "-f", "lavfi", "-i", longMedia ? "sine=r=48000:d=300" : "sine=r=48000:d=12", "-c:v", "libx264", ...(longMedia ? ["-threads", "2", "-preset", "ultrafast", "-b:v", "4M", "-maxrate", "4M", "-bufsize", "8M"] : []), "-g", "96", "-keyint_min", "96", "-sc_threshold", "0", "-bf", "3", "-pix_fmt", "yuv420p", "-c:a", "aac", "-metadata:s:a:0", "language=eng"])
  fs.writeFileSync(path.join(directory, "invalid.mp4"), "synthetic invalid file")
  // A valid sparse 512 MiB PCM file exercises size/seek without a huge download.
  const dataBytes = 512 * 1024 * 1024, wav = Buffer.alloc(44)
  wav.write("RIFF"); wav.writeUInt32LE(dataBytes + 36, 4); wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34)
  wav.write("data", 36); wav.writeUInt32LE(dataBytes, 40)
  const sparse = path.join(directory, "large.wav"); fs.writeFileSync(sparse, wav); fs.truncateSync(sparse, 44 + dataBytes)
}
async function runUI({ window, service, userData, app }) {
  const wc = window.webContents, js = code => wc.executeJavaScript(code, true)
  const wait = async expression => { for (let i = 0; i < 150; i++) { if (await js(expression)) return; await delay(100) } throw new Error(`Integration condition timed out: ${expression}`) }
  const click = label => js(`(()=>{const e=Array.from(document.querySelectorAll('button,a')).find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing control: '+${JSON.stringify(label)});e.click()})()`)
  const set = (id, value) => js(`(()=>{const e=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  const sourcePath = path.join(userData, "session.mp4"), sourceHash = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex")
  const facts = { operations: [], commands: [], metrics: [], outputBytes: {}, helpers: {}, packaged: app.isPackaged }
  const measure = label => facts.metrics.push({ label, at: performance.now(), processes: app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpu, memory })) })
  const runProcess = service.exports.runProcess
  service.exports.runProcess = (exe, args, options) => {
    assert.equal(args[args.indexOf("-c") + 1], "copy")
    facts.commands.push(args)
    facts.helpers.ffmpeg = exe
    return runProcess(exe, args, options)
  }
  facts.helpers.ffprobe = await service.resolveProbe()
  await delay(1000); measure("idle-before-open")
  service.selectFile = async () => sourcePath
  let start = performance.now(); await click("Open local file"); await wait("!!document.getElementById('trim-panel')"); await click("Extract audio"); await wait("!!document.getElementById('local-audio-track')")
  facts.openMs = performance.now() - start; const sourceId = service.source.dto.sourceId
  facts.fixture = { bytes: service.source.dto.bytes, duration: service.source.dto.duration, width: service.source.dto.streams[0].width, height: service.source.dto.streams[0].height }
  await wait("document.activeElement?.tagName==='H1'")
  await wait("document.querySelector('video')?.readyState >= 2")
  facts.openToVideoReadyMs = performance.now() - start
  facts.seekMs = await js("(async()=>{const v=document.querySelector('video'),t=performance.now();await new Promise(resolve=>{v.addEventListener('seeked',resolve,{once:true});v.currentTime=2});return performance.now()-t})()")
  const save = async (filename, action, label) => {
    service.exports.selectDestination = async () => path.join(userData, filename)
    await click("Choose destination"); await wait(`document.body.textContent.includes('Save as: ${filename}')`)
    const began = performance.now()
    if (action === "extractAudio") await js("Array.from(document.querySelectorAll('#audio-extraction button')).find(e=>e.textContent.trim()==='Extract audio').click()")
    else await click(action === "trim" ? "Export edited video" : "Save copy")
    await wait(`document.body.textContent.includes(${JSON.stringify(label)}) && document.body.textContent.includes(${JSON.stringify(filename)})`)
    assert.equal(service.exports.job.state, "completed"); assert.equal(service.source.dto.sourceId, sourceId)
    facts.operations.push({ action, milliseconds: performance.now() - began, sourceStillOpen: true })
    facts.outputBytes[filename] = fs.statSync(path.join(userData, filename)).size
  }
  await set("local-audio-track", "1"); await save("session.aac", "extractAudio", "Audio saved")
  await click("Remove tracks"); await wait("!!document.getElementById('keep-track-1')")
  await click("Remove all audio"); await save("silent.mp4", "removeTracks", "Copy saved")
  await click("Change format"); await wait("!!document.getElementById('target-container')")
  await set("target-container", "mkv"); await save("session.mkv", "remux", "Copy saved")
  await click("Trim"); await wait("!!document.getElementById('trim-start')")
  await wait("document.querySelector('video')?.readyState >= 2")
  start = performance.now()
  await js("(async()=>{const v=document.querySelector('video');v.muted=true;await v.play();await new Promise(r=>setTimeout(r,300));v.pause()})()")
  await wait("!Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Review cut boundaries').disabled")
  facts.playMs = performance.now() - start; measure("played")
  await set("trim-start", "4.2"); await set("trim-end", "6")
  start = performance.now(); await click("Review cut boundaries"); await wait("document.body.textContent.includes('Planned content: approximately 4.000')")
  facts.planMs = performance.now() - start
  await save("clip.mp4", "trim", "Clip saved")
  await click("Back to downloads"); await wait("document.querySelector('aside')?.textContent.includes('Clip saved')")
  await click("Return to local file"); await wait("document.getElementById('trim-start')?.value==='4.2'")
  const normalProcess = service.exports.runProcess
  service.exports.runProcess = (exe, args, options) => normalProcess(exe, ["-readrate", "0.1", ...args], options)
  service.exports.selectDestination = async () => path.join(userData, "cancelled.mp4")
  await wait("document.querySelector('video')?.readyState >= 2")
  await js("(async()=>{const v=document.querySelector('video');v.muted=true;await v.play();await new Promise(r=>setTimeout(r,100));v.pause()})()")
  await wait("!Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Review cut boundaries').disabled")
  await click("Review cut boundaries"); await wait("document.body.textContent.includes('Planned content: approximately 4.000')")
  await click("Choose destination"); await wait("document.body.textContent.includes('Save as: cancelled.mp4')")
  await click("Export edited video")
  for (let i = 0; i < 100 && service.exports.job.state !== "running"; i++) await delay(20)
  assert.equal(service.exports.job.state, "running"); await delay(250)
  await click("Back to downloads"); await wait("document.querySelector('aside')?.textContent.includes('Cancel clip')")
  start = performance.now(); await click("Cancel clip")
  await wait("document.querySelector('aside')?.textContent.includes('Clip cancelled')")
  facts.cancellationMs = performance.now() - start
  assert.equal(service.exports.job.state, "cancelled"); assert.equal(service.exports.active, null)
  assert(!fs.existsSync(path.join(userData, "cancelled.mp4")))
  service.exports.runProcess = normalProcess
  await click("Return to local file"); await wait("document.getElementById('trim-start')?.value==='4.2'")
  facts.cancelledWhileAway = true
  service.selectFile = async () => path.join(userData, "invalid.mp4")
  await click("Change file"); await wait("document.querySelector('main')?.textContent.includes('could not be inspected') && !Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Change file').disabled")
  assert.equal(service.source.dto.sourceId, sourceId)
  service.selectFile = async () => path.join(userData, "large.wav")
  start = performance.now(); await click("Change file"); await wait("document.querySelector('main')?.textContent.includes('large.wav') && !!document.getElementById('trim-panel')")
  facts.largeOpenMs = performance.now() - start; facts.largeBytes = service.source.dto.bytes
  assert(facts.largeBytes > 512 * 1024 * 1024)
  await click("ru"); assert(await js("document.documentElement.lang==='ru' || document.body.textContent.includes('Локальный')"))
  const wasDark = await js("document.documentElement.classList.contains('dark')")
  await click("переключить тему")
  await wait(`document.documentElement.classList.contains('dark')===${!wasDark}`)
  await click("en"); await wait("document.querySelector('h1')?.textContent==='Local media'")
  facts.languagesAndThemeChanged = true
  await click("Close file"); await wait("!document.querySelector('video,audio')")
  await delay(500); measure("idle-after-close")
  assert.equal(service.source, null); assert.equal(service.pending, null); assert.equal(service.exports.active, null)
  assert.equal(createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"), sourceHash)
  assert(!fs.readdirSync(userData).some(name => name.startsWith(".cliply-export-")))
  Object.assign(facts, { originalUnchanged: true, allActionsOneSource: true, invalidOpenPreservedSource: true, routesRetainedRange: true, largeSparseFileOpened: true, noPartials: true })
  if (process.env.CLIPLY_SMOKE_EVIDENCE) { fs.mkdirSync(process.env.CLIPLY_SMOKE_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, "integration.json"), JSON.stringify(facts, null, 2) + "\n") }
  console.log("Local integration passed:", JSON.stringify(facts))
}
module.exports = { fixtures, runUI }
