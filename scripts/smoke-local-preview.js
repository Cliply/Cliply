// Optional real-host extension of smoke-electron. Uses only synthetic fixtures
// and the explicitly supplied verified helpers; all media lives in smoke userData.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")

function fixtures(directory) {
  assert(process.env.CLIPLY_SMOKE_FFPROBE, "supply the verified development FFprobe")
  assert(process.env.CLIPLY_SMOKE_FFMPEG, "supply the existing project FFmpeg explicitly")
  const { spawnSync } = require("node:child_process")
  for (const [name, args] of [
    ["preview.mp4", ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]],
    ["preview.wav", ["-f", "lavfi", "-i", "sine=frequency=330", "-t", "5", "-c:a", "pcm_s16le"]],
    ["unsupported.mkv", ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5", "-t", "1", "-c:v", "ffv1"]]
  ]) {
    const result = spawnSync(process.env.CLIPLY_SMOKE_FFMPEG, ["-hide_banner", "-loglevel", "error", ...args, path.join(directory, name)], { encoding: "utf8", timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
  }
}

async function run({ window, service, userData, cliplyApp }) {
  const wc = window.webContents
  const js = (code) => wc.executeJavaScript(code, true)
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await js(expression)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Preview smoke condition timed out: ${expression}`)
  }
  const click = (label) => js(`Array.from(document.querySelectorAll('button,a')).find(e => (e.getAttribute('aria-label') || e.textContent.trim()) === ${JSON.stringify(label)})?.click()`)
  const facts = { platform: process.platform, arch: process.arch, electron: process.versions.electron, playback: [] }
  assert.equal(wc.getLastWebPreferences().webSecurity, true)
  assert.equal(wc.getLastWebPreferences().sandbox, true)
  for (const [filename, element] of [["preview.mp4", "video"], ["preview.wav", "audio"], ["preview.mp4", "video"]]) {
    service.selectFile = async () => path.join(userData, filename)
    await click(facts.playback.length ? "Change file" : "Open local file")
    await wait(`document.querySelector('main')?.textContent.includes(${JSON.stringify(filename)}) && !!document.querySelector('${element}[src]') && !Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim() === 'Cancel')`)
    await wait(`document.querySelector('${element}')?.readyState >= 2`)
    const played = await js(`(async () => {
      const media = document.querySelector('${element}'); media.muted = true;
      await media.play(); await new Promise(r => setTimeout(r, 800));
      const progressed = media.currentTime > 0; media.pause();
      await new Promise((resolve, reject) => {
        media.addEventListener('seeked', resolve, {once:true});
        media.addEventListener('error', reject, {once:true}); media.currentTime = 2;
      });
      return {filename:${JSON.stringify(filename)}, progressed, seek:media.currentTime, duration:media.duration, readyState:media.readyState};
    })()`)
    console.log("Playback:", JSON.stringify(played))
    assert(played.progressed)
    assert.equal(played.seek, 2)
    facts.playback.push(played)
  }
  const url = service.preview.grant.url
  facts.requests = await js(`(async () => {
    const url = ${JSON.stringify(url)};
    const head = await fetch(url, {method:'HEAD'});
    const range = await fetch(url, {headers:{Range:'bytes=0-15'}});
    const invalid = await fetch(url, {headers:{Range:'bytes=2-1'}});
    return {head:head.status, bytes:head.headers.get('content-length'), range:range.status, length:(await range.arrayBuffer()).byteLength, invalid:invalid.status};
  })()`)
  assert.equal(facts.requests.head, 200)
  assert.equal(facts.requests.range, 206)
  assert.equal(facts.requests.length, 16)
  assert.equal(facts.requests.invalid, 416)
  // A leaked token is insufficient in another BrowserWindow, even in the same session.
  const { BrowserWindow } = require("electron")
  for (const partition of [undefined, "cliply-preview-foreign"]) {
    const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition } })
    try {
      await foreign.loadURL("data:text/html,foreign")
      assert.equal(await foreign.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(r=>r.ok).catch(()=>false)`), false)
    } finally { foreign.destroy() }
  }
  facts.foreignWindowsDenied = true
  // An iframe in the owning WebContents must also be denied, even with its URL.
  await js("const foreignFrame = document.createElement('iframe'); foreignFrame.src = 'https://www.youtube.com/embed/blocked-smoke'; document.body.append(foreignFrame)")
  await wait("!!document.querySelector('iframe')")
  for (let i = 0; i < 30 && !wc.mainFrame.frames.length; i++) await new Promise(r => setTimeout(r, 100))
  assert(wc.mainFrame.frames.length, "foreign frame exists")
  assert.equal(await wc.mainFrame.frames[0].executeJavaScript(`fetch(${JSON.stringify(url)}).then(r=>r.ok).catch(()=>false)`), false)
  await js("document.querySelector('iframe').remove()")
  facts.foreignFrameDenied = true
  for (const bad of [url + "?path=/etc/passwd", "cliply-media://source/%2e%2e%2fetc/passwd", url.replace(/.$/, "z")]) {
    assert.equal(await js(`fetch(${JSON.stringify(bad)}).then(r=>r.ok).catch(()=>false)`), false)
  }
  facts.malformedTokensDenied = true
  const clock = service.preview.now
  service.preview.now = () => service.preview.grant.expiresAt
  assert.equal(await js(`fetch(${JSON.stringify(url)}).then(r=>r.ok).catch(()=>false)`), false)
  service.preview.now = clock
  facts.expiredTokenDeniedWithAdvancedClock = true
  await click("Back to downloads")
  await wait("!document.querySelector('video') && !document.querySelector('audio')")
  assert.equal(service.preview.grant, null)
  await click("Return to local file")
  await wait("document.querySelector('video')?.readyState >= 2")
  assert.notEqual(service.preview.grant.url, url)
  assert(Math.abs(await js("document.querySelector('video').currentTime") - 2) < 0.2, "route return restores position")
  facts.routeReturn = true
  // Exercise actual renderer expiry and media.load() events, not just server
  // clock rejection. Reload must retain the position saved before unloading.
  const ttl = service.preview.ttlMs
  service.preview.ttlMs = 1200
  await click("Back to downloads")
  await wait("!document.querySelector('video')")
  await click("Return to local file")
  await wait("document.querySelector('video')?.readyState >= 2")
  await wait("Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('Preview access expired'))")
  service.preview.ttlMs = ttl
  await click("Reload preview")
  await wait("document.querySelector('video')?.readyState >= 2")
  assert(Math.abs(await js("document.querySelector('video').currentTime") - 2) < 0.2, "expiry reload restores position")
  facts.expiryReloadPosition = true
  wc.send("downloads:list", { seq: 2, lifetimeCompleted: 123, rows: [{
    download_id: "preview-smoke", status: "downloading", kind: "video", platform: "youtube",
    title: "Synthetic background download", label: "720p mp4", started_at: 1000,
    request: { url: "https://youtu.be/synthetic", height: 720, container: "mp4" }
  }] })
  await js("document.querySelector('[data-downloads-toggle]').click()")
  await wait("document.querySelector('[data-downloads-toggle]')?.getAttribute('aria-expanded') === 'true'")
  await wait("document.body.textContent.includes('Synthetic background download')")
  await js("document.querySelector('[data-downloads-toggle]').click()")
  facts.downloadPanel = true
  // Readable decoder failure must retain the probed source and track metadata.
  service.selectFile = async () => path.join(userData, "unsupported.mkv")
  await click("Change file")
  await wait("Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('Preview unavailable'))")
  assert(service.source)
  facts.unsupportedProbeRetained = true
  service.selectFile = async () => path.join(userData, "preview.mp4")
  await click("Change file")
  await wait("document.querySelector('video')?.readyState >= 2")
  if (process.env.CLIPLY_SMOKE_EVIDENCE) {
    const dir = process.env.CLIPLY_SMOKE_EVIDENCE
    fs.mkdirSync(dir, { recursive: true })
    await js("(async()=>{const v=document.querySelector('video'); v.muted=true; await v.play(); await new Promise(r=>setTimeout(r,500)); v.pause()})()")
    await wait("!document.documentElement.classList.contains('dark')")
    await new Promise(r => setTimeout(r, 300))
    fs.writeFileSync(path.join(dir, "workspace-en-light.png"), (await wc.capturePage()).toPNG())
    // Exercise the actual locale control (EN/RU toggle), then capture dark mode.
    await require("./smoke-editor-workspace").setPreferences({ window, locale: "ru", dark: true })
    await wait("document.documentElement.lang === 'ru'")
    await wait("document.documentElement.classList.contains('dark')")
    await new Promise(r => setTimeout(r, 300))
    fs.writeFileSync(path.join(dir, "workspace-ru-dark.png"), (await wc.capturePage()).toPNG())
    await js("window.scrollTo(0, document.body.scrollHeight)")
    await new Promise(r => setTimeout(r, 200))
    fs.writeFileSync(path.join(dir, "workspace-ru-tracks.png"), (await wc.capturePage()).toPNG())
    fs.writeFileSync(path.join(dir, "native-preview.json"), JSON.stringify(facts, null, 2) + "\n")
  }
  fs.appendFileSync(path.join(userData, "preview.mp4"), "changed")
  await wait("!document.querySelector('video') && !!document.querySelector('[role=alert]')")
  assert.equal(service.preview.grant, null)
  facts.sourceChangeRevoked = true
  // Exercise Electron's real close event, not just the before-quit method.
  // Simulate a refused drain without leaving an actual stuck native process.
  const { dialog } = require("electron")
  const shutdown = service.shutdown
  const showErrorBox = dialog.showErrorBox
  let drainRefused = false
  try {
    service.shutdown = async () => { throw new Error("synthetic stuck probe") }
    dialog.showErrorBox = () => { drainRefused = true }
    window.close()
    for (let i = 0; i < 30 && !drainRefused; i++) await new Promise(r => setTimeout(r, 50))
    assert(drainRefused, "close button reached the refusal")
    assert.equal(window.isDestroyed(), false, "refused quit keeps the window")
    assert.equal(cliplyApp.isQuitting, false, "refused quit keeps scheduling usable")
    facts.refusedClosePreservesWindow = true
  } finally {
    service.shutdown = shutdown
    dialog.showErrorBox = showErrorBox
  }
  if (process.env.CLIPLY_SMOKE_EVIDENCE) fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, "native-preview.json"), JSON.stringify(facts, null, 2) + "\n")
  console.log("Native preview smoke passed:", JSON.stringify(facts))
}

module.exports = { fixtures, run }
