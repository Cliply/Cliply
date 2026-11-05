const { pickOption } = require("./smoke-pick-option")
// Synthetic trim acceptance; encoding occurs only while making test fixtures.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
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
async function runNative(options) {
  return require("./smoke-losslesscut-parity").runNative({ ...options, single: true })
}

module.exports = { fixtures, runNative }

async function runUI({ window, service, userData }) {
  const wc = window.webContents, js = code => wc.executeJavaScript(code), delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await js(expression)) return; await delay(100) } throw new Error(`Editor UI condition timed out: ${expression}`) }
  const click = label => js(`Array.from(document.querySelectorAll('button,a')).find(e=>(e.getAttribute('aria-label') || e.textContent.trim())===${JSON.stringify(label)})?.click()`)
  const set = (id, value) => js(`(() => { const e=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  service.selectFile = async () => path.join(userData, "gop.mp4")
  service.exports.selectDestination = async () => path.join(userData, "ui-edited.mp4")
  await click("Open local file"); await wait("!!document.getElementById('trim-start')")
  const sourceId = service.source.dto.sourceId
  await wait("document.querySelector('video').readyState >= 2")
  await js("document.querySelector('video').muted=true; document.querySelector('video').play()")
  await wait("document.querySelector('video').currentTime>0.1")
  await js("document.querySelector('video').pause()")
  await require("./smoke-editor-workspace").run({ window })
  await set("trim-start", "4"); await set("trim-end", "8")
  await pickOption(js, "edit-intent", "remove")
  await wait("document.getElementById('trim-panel').textContent.includes('2 parts')")
  await click("Preview retained video")
  await wait("!document.querySelector('video').paused")
  await js("document.querySelector('video').currentTime=3.99")
  await wait("document.querySelector('video').currentTime>=8")
  await click("Stop edit preview")
  await click("Review export")
  await wait("document.querySelector('[data-testid=cut-inspector]')?.textContent.includes('Requested section:')")
  assert.equal(service.trimPlan.cuts.length, 2)
  await click("Choose destination"); await wait("document.body.textContent.includes('Save as: ui-edited.mp4')")
  await click("Export edited video"); await wait("document.body.textContent.includes('Clip saved')")
  assert.equal(service.source.dto.sourceId, sourceId)
  assert.equal(service.exports.job.state, "completed")
  if (process.env.CLIPLY_SMOKE_EVIDENCE) {
    const directory = process.env.CLIPLY_SMOKE_EVIDENCE; fs.mkdirSync(directory, { recursive: true })
    await js("document.getElementById('trim-panel').scrollIntoView()"); await delay(150)
    fs.writeFileSync(path.join(directory, "editor-en-light.png"), (await wc.capturePage()).toPNG())
    await require("./smoke-editor-workspace").setPreferences({ window, locale: "ru", dark: true }); await delay(150)
    fs.writeFileSync(path.join(directory, "editor-ru-dark.png"), (await wc.capturePage()).toPNG()); await require("./smoke-editor-workspace").setPreferences({ window, locale: "en" })
  }
  await click("Back to downloads"); await click("Return to local file")
  await wait("document.getElementById('trim-start')?.value==='4'")
  assert.equal(await js("document.getElementById('trim-end').value"), "8")
  // A fresh grant does not invalidate an original-source edit plan.
  await click("Review export"); await wait("document.querySelector('[data-testid=cut-inspector]')?.textContent.includes('Requested section:')")
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

if (require.main === module) {
  const [directory, ffmpeg, ffprobe] = process.argv.slice(2)
  runNative({ directory, ffmpeg, ffprobe }).then(result => {
    fs.writeFileSync(path.join(directory, "trim-evidence.json"), JSON.stringify(result, null, 2))
    console.log(`LosslessCut parity: ${result.cases.length} single cuts matched packets and timestamps`)
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
