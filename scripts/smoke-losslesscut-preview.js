// Actual Electron native-clock/MediaSource-slave parity acceptance.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")

function fixtures(directory, ffmpeg) {
  fs.mkdirSync(directory, { recursive: true })
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=24:d=12", "-f", "lavfi", "-i", "sine=d=12:r=48000",
    "-c:v", "prores_ks", "-profile:v", "0", "-c:a", "pcm_s16le", path.join(directory, "compatibility.mov")])
}
async function runUI({ window, service, userData }) {
  const js = code => window.webContents.executeJavaScript(code)
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
    throw new Error(`Compatibility playback condition timed out: ${expression}; ${await js("document.body.textContent.slice(-2500)")}`)
  }
  const click = label => js(`Array.from(document.querySelectorAll('button,a')).find(e => e.textContent.trim() === ${JSON.stringify(label)})?.click()`)
  service.selectFile = async () => path.join(userData, "compatibility.mov")
  await click("Open local file")
  await wait("!!document.querySelector('video')")
  // ProRes is not natively decoded by this Chromium player; decoder failure
  // automatically switches to upstream's silent clock + FFmpeg/MSE path.
  await wait("document.querySelectorAll('video').length === 2")
  await wait("document.querySelectorAll('video')[1].readyState >= 2")
  const sourceId = service.source.dto.sourceId
  await js("document.querySelector('video').play()")
  await wait("document.querySelectorAll('video')[1].currentTime > 0.2 && !document.querySelectorAll('video')[1].paused")
  assert.equal(await js("document.querySelectorAll('video')[1].muted"), false)
  await js("document.querySelector('video').muted = true; document.querySelector('video').volume = 0.35")
  await wait("document.querySelectorAll('video')[1].muted && document.querySelectorAll('video')[1].volume === 0.35")
  await js("document.querySelector('video').muted = false")
  await wait("!document.querySelectorAll('video')[1].muted")
  await js("document.querySelector('video').currentTime = 9")
  await wait("document.querySelectorAll('video')[1].currentTime >= 8.8")
  await js("document.querySelector('video').pause(); document.querySelector('video').currentTime = 1")
  await wait("Math.abs(document.querySelectorAll('video')[1].currentTime - 1) < 0.15 && document.querySelectorAll('video')[1].readyState >= 2")
  // Desktop screenshots can contain stale compositor frames on hosted Windows.
  // Verify the decoded synthetic picture itself, not only playback timestamps.
  await wait(`(() => {
    const video = document.querySelectorAll('video')[1]
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 16, 16)
    const pixels = context.getImageData(0, 0, 16, 16).data
    let colored = 0
    for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i], pixels[i+1], pixels[i+2]) - Math.min(pixels[i], pixels[i+1], pixels[i+2]) > 40) colored++
    return video.videoWidth > 0 && colored > 32
  })()`)
  if (process.env.CLIPLY_SMOKE_EVIDENCE) {
    window.show(); window.focus()
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    await new Promise(resolve => setTimeout(resolve, 250))
    fs.mkdirSync(process.env.CLIPLY_SMOKE_EVIDENCE, { recursive: true })
    fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, "compatibility-player.png"), (await window.webContents.capturePage()).toPNG())
  }
  assert.equal(service.source.dto.sourceId, sourceId)
  await click("Back to downloads")
  for (let i = 0; i < 40 && service.compatibility.jobs.size; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(service.compatibility.jobs.size, 0, "route exit drains FFmpeg")
  await click("Return to local file")
  await wait("document.querySelectorAll('video').length === 2 && document.querySelectorAll('video')[1].readyState >= 2")
  await click("Close file")
  for (let i = 0; i < 40 && service.compatibility.jobs.size; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(service.compatibility.jobs.size, 0)
  assert.equal(service.source, null)
  console.log("LosslessCut compatibility playback: ProRes native failure, automatic fallback, decoded picture pixels, play, mute/volume, forward/back seek, route restoration and cleanup passed")
}
module.exports = { fixtures, runUI }
