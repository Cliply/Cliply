// Exercises the real Electron startup/window/preload/IPC boundary without
// download services, telemetry, external requests or existing user data.
// Build the renderer first, then: npm run smoke:electron
const fs = require("fs")
const os = require("os")
const path = require("path")
const assert = require("assert/strict")

if (!process.versions.electron) {
  const { spawnSync } = require("child_process")
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-runtime-"))
  const env = { ...process.env, NODE_ENV: "production" }
  delete env.ELECTRON_RUN_AS_NODE
  let result
  try {
    if (process.env.CLIPLY_SMOKE_FFPROBE) {
      fs.writeFileSync(path.join(userData, "inspection.wav"), require("./smoke-local-media").wavFixture())
    }
    if (process.env.CLIPLY_SMOKE_PREVIEW === "1") {
      require("./smoke-local-preview").fixtures(userData)
    }
    if (process.env.CLIPLY_SMOKE_EXPORT === "1") {
      require("./smoke-local-export").fixtures(userData, process.env.CLIPLY_SMOKE_FFMPEG)
    }
    if (process.env.CLIPLY_SMOKE_TRACKS === "1") {
      require("./smoke-local-tracks").fixtures(userData, process.env.CLIPLY_SMOKE_FFMPEG)
    }
    if (process.env.CLIPLY_SMOKE_REMUX === "1") {
      require("./smoke-local-remux").fixtures(userData, process.env.CLIPLY_SMOKE_FFMPEG)
    }
    if (process.env.CLIPLY_SMOKE_TRIM === "1") {
      require("./smoke-local-trim").fixtures(userData, process.env.CLIPLY_SMOKE_FFMPEG)
    }
    if (process.env.CLIPLY_SMOKE_INTEGRATION === "1") {
      require("./smoke-local-integration").fixtures(userData, process.env.CLIPLY_SMOKE_FFMPEG)
    }
    if (process.env.CLIPLY_SMOKE_COMPAT === "1") require("./smoke-losslesscut-preview").fixtures(userData, process.env.CLIPLY_SMOKE_FFMPEG)
    const args = [__filename, userData]
    // Source-tree Electron has no installed AppArmor profile on CI. Packaged
    // Linux checks exercise the real launchers without this test-only flag.
    if (process.platform === "linux" && process.env.CLIPLY_SMOKE_NO_SANDBOX === "1") args.push("--no-sandbox")
    result = spawnSync(require("electron"), args, {
      env, stdio: "inherit", timeout: 60000
    })
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
} else {
  const { app, ipcMain, dialog, session } = require("electron")
  const userData = process.env.CLIPLY_SMOKE_USER_DATA || process.argv[2]
  const appRoot = process.env.CLIPLY_SMOKE_APP_ROOT === "bundled"
    ? path.join(process.resourcesPath, "cliply-under-test.asar")
    : path.resolve(__dirname, "..")
  require(path.join(appRoot, "src/main/services/local-media/preview")).registerMediaScheme(require("electron").protocol)
  app.setPath("userData", userData)
  app.setPath("sessionData", userData)
  const watchdog = setTimeout(() => {
    console.error("Electron smoke timed out")
    app.exit(1)
  }, 45000)

  const fail = (error) => {
    console.error(error?.stack || error?.message || error)
    clearTimeout(watchdog)
    app.exit(1)
  }
  process.on("uncaughtException", fail)
  process.on("unhandledRejection", fail)
  // Startup failures should fail CI, rather than leave a modal dialog waiting.
  dialog.showErrorBox = (title, message) => { throw new Error(title + ": " + message) }

  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_details, callback) => callback({ cancel: true })
    )
    const CliplyApp = require(path.join(appRoot, "src/main/index"))
    if (process.platform === "linux" && process.env.CLIPLY_SMOKE_APP_ROOT === "bundled" && process.env.CLIPLY_SMOKE_LOCAL_PACKAGE !== "1") {
      const bundledRequire = require("node:module").createRequire(path.join(appRoot, "package.json"))
      const updater = bundledRequire("electron-updater").autoUpdater
      const marker = path.join(process.resourcesPath, "package-type")
      const packageType = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null
      const expected = process.env.APPIMAGE ? "AppImageUpdater" : "DebUpdater"
      assert.equal(updater.constructor.name, expected, "updater matches the installed package format")
      assert.equal(packageType, process.env.APPIMAGE ? null : "deb")
      console.log("packaged Linux updater selected:", expected)
    }
    const cliplyApp = new CliplyApp()
    let localMedia
    cliplyApp.initializeServices = async () => {
      const { LocalMediaService } = require(path.join(appRoot, "src/main/services/local-media"))
      const { resolveFfprobe } = require(path.join(appRoot, "src/main/services/local-media/paths"))
      const { registerLocalMedia } = require(path.join(appRoot, "src/main/ipc/local-media"))
      const fixture = path.join(userData, "inspection.wav")
      const packagedLocal = process.env.CLIPLY_SMOKE_LOCAL_PACKAGE === "1"
      const { YtdlpEngine } = require(path.join(appRoot, "src/main/services/ytdlp-engine"))
      const packageEngine = packagedLocal ? new YtdlpEngine({ userDataPath: userData, resourcesPath: process.resourcesPath }) : null
      if (packagedLocal) {
        assert(app.isPackaged)
        assert.equal(process.env.CLIPLY_DEV_FFPROBE, undefined)
        assert.equal(process.env.CLIPLY_SMOKE_FFPROBE, undefined)
        assert.equal(process.env.CLIPLY_SMOKE_FFMPEG, undefined)
      }
      localMedia = new LocalMediaService({
        exportOptions: {
          storagePath: path.join(userData, "local-media"),
          resolveFfmpeg: async () => packageEngine ? packageEngine.getFfmpegPath() : process.env.CLIPLY_SMOKE_FFMPEG,
          selectDestination: async () => path.join(userData, "extracted.aac"),
          onUpdate: snapshot => cliplyApp.mainWindow?.webContents.send("media:export-updated", snapshot)
        },
        selectFile: async () => fixture,
        resolveProbe: () => resolveFfprobe({
          isPackaged: packagedLocal, resourcesPath: process.resourcesPath, developmentPath: process.env.CLIPLY_SMOKE_FFPROBE,
          projectRoot: userData // absent by default: proves graceful missing support
        })
      })
      const unregisterLocalMedia = registerLocalMedia({ ipcMain, service: localMedia, getWindow: () => cliplyApp.mainWindow })
      cliplyApp.ipcHandlers = { localMedia, cleanup: unregisterLocalMedia, setMainWindow: (window) => localMedia.preview.attach(window) }
      ipcMain.handle("settings:get-download-count", () => ({ success: true, data: { count: 123 } }))
      ipcMain.handle("settings:get-download-path", () => ({
        success: true, data: { path: userData, exists: true, writable: true }
      }))
      ipcMain.handle("download:get-list", () => ({
        success: true, data: { seq: 1, rows: [], lifetimeCompleted: 123 }
      }))
      ipcMain.handle("cookies:status", () => ({ success: true, data: { signed_in: false } }))
      ipcMain.handle("video:get-info", (_event, request) => {
        assert.equal(request.platform, "instagram")
        assert.equal(request.url, "https://www.instagram.com/reel/Example123/")
        return { success: true, data: { title: "Instagram smoke", duration: 0, duration_string: "00:00", thumbnail: null, uploader: "Example" } }
      })
      ipcMain.handle("video:download-combined", (_event, request) => {
        assert.equal(request.platform, "instagram")
        assert.equal(request.download_id, "instagram_smoke")
        return { success: true, data: { download_id: request.download_id, status: "started", type: "combined" } }
      })
    }
    cliplyApp.createMenu = () => {}
    cliplyApp.reportLaunch = () => {}
    cliplyApp.setupAutoUpdater = () => {}
    const createWindow = cliplyApp.createWindow.bind(cliplyApp)
    const loaded = new Promise((resolve, reject) => {
      cliplyApp.createWindow = () => {
        createWindow()
        const window = cliplyApp.mainWindow
        window.show = () => {}
        window.webContents.once("did-finish-load", resolve)
        window.webContents.once("preload-error", (_event, _preload, error) => reject(error))
        window.webContents.once("render-process-gone", (_event, details) => reject(new Error(details.reason)))
      }
    })
    await cliplyApp.initialize()
    await loaded
    if (process.env.CLIPLY_SMOKE_IDLE === "1") {
      const wc = cliplyApp.mainWindow.webContents
      for (let i = 0; i < 100 && !await wc.executeJavaScript("document.getElementById('root')?.childElementCount > 0"); i++) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert(await wc.executeJavaScript("document.getElementById('root')?.childElementCount > 0"))
      const readyMs = process.uptime() * 1000
      app.getAppMetrics()
      await new Promise(resolve => setTimeout(resolve, 3000))
      assert.equal(localMedia.pending, null); assert.equal(localMedia.exports.active, null)
      const facts = { packaged: app.isPackaged, readyMs, idleWindowMs: 3000,
        processes: app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpu, memory })),
        localFileUnopened: localMedia.source === null }
      console.log("Packaged idle measurement:", JSON.stringify(facts))
      await localMedia.shutdown(); clearTimeout(watchdog); cliplyApp.mainWindow.destroy(); app.exit(0)
      return
    }
    const state = await cliplyApp.mainWindow.webContents.executeJavaScript(
      `(async () => {
        const response = await window.electronAPI.settings.getDownloadCount()
        const media = await window.electronAPI.media.open()
        const closed = await window.electronAPI.media.close()
        const mediaState = await window.electronAPI.media.getState()
        const instagram = await window.electronAPI.instagram.getInfo("https://www.instagram.com/reel/Example123/")
        const download = await window.electronAPI.instagram.download({
          url: "https://www.instagram.com/reel/Example123/",
          download_id: "instagram_smoke", platform: "youtube"
        })
        return {
          count: response.data.count,
          media, mediaClosed: closed.data?.closed, mediaSourceAfterClose: mediaState.data?.source,
          instagramTitle: instagram.data.title,
          instagramDownloadStatus: download.data.status,
          platform: window.electronAPI.platform.platform,
          electron: window.electronAPI.platform.versions.electron,
          rendered: document.getElementById("root")?.childElementCount > 0,
          nodeIsolated: typeof require === "undefined"
        }
      })()`
    )
    if (process.env.CLIPLY_SMOKE_FFPROBE || process.env.CLIPLY_SMOKE_LOCAL_PACKAGE === "1") {
      if (!state.media.success) {
        const { trustedFrame } = require(path.join(appRoot, "src/main/services/local-media/preview"))
        const window = cliplyApp.mainWindow
        // Synthetic fixture only; keep failure evidence without printing paths or
        // weakening the same frame/origin gate exercised by production IPC.
        console.error("Local inspection failure:", JSON.stringify({
          code: state.media.error?.code, message: state.media.error?.message,
          trustedMainFrame: trustedFrame(window, window.webContents.mainFrame, false),
          fixtureExists: fs.existsSync(path.join(userData, "inspection.wav")),
          packaged: app.isPackaged
        }))
      }
      assert.equal(state.media.success, true)
      assert.equal(state.media.data.source.duration, 1)
      assert.equal(state.media.data.source.streams[0].codec, "pcm_s16le")
    } else {
      assert.equal(state.media.success, false)
      assert.equal(state.media.error.code, "PROBE_MISSING")
    }
    assert.equal(state.mediaClosed, true)
    assert.equal(state.mediaSourceAfterClose, null)
    if (process.env.CLIPLY_SMOKE_PREVIEW === "1") {
      await require("./smoke-local-preview").run({ window: cliplyApp.mainWindow, service: localMedia, userData, cliplyApp })
    }
    if (process.env.CLIPLY_SMOKE_EXPORT === "1") {
      await require("./smoke-local-export").runUI({ window: cliplyApp.mainWindow, service: localMedia, userData })
    }
    if (process.env.CLIPLY_SMOKE_TRACKS === "1") {
      await require("./smoke-local-tracks").runUI({ window: cliplyApp.mainWindow, service: localMedia, userData })
    }
    if (process.env.CLIPLY_SMOKE_REMUX === "1") {
      await require("./smoke-local-remux").runUI({ window: cliplyApp.mainWindow, service: localMedia, userData })
    }
    if (process.env.CLIPLY_SMOKE_TRIM === "1") {
      await require("./smoke-local-trim").runUI({ window: cliplyApp.mainWindow, service: localMedia, userData })
    }
    if (process.env.CLIPLY_SMOKE_INTEGRATION === "1") {
      await require("./smoke-local-integration").runUI({ window: cliplyApp.mainWindow, service: localMedia, userData, app })
    }
    if (process.env.CLIPLY_SMOKE_COMPAT === "1") await require("./smoke-losslesscut-preview").runUI({ window: cliplyApp.mainWindow, service: localMedia, userData })
    await localMedia.shutdown()
    assert.equal(state.count, 123, "preload IPC round trip")
    assert.equal(state.instagramTitle, "Instagram smoke", "Instagram metadata bridge")
    assert.equal(state.instagramDownloadStatus, "started", "Instagram download bridge fixes the platform")
    assert.equal(state.rendered, true, "React mounted from the built file")
    assert.equal(state.nodeIsolated, true, "renderer has no Node require")
    assert.equal(state.electron, process.versions.electron)
    console.log("Electron runtime smoke passed:", JSON.stringify(state))
    clearTimeout(watchdog)
    cliplyApp.mainWindow.destroy()
    app.exit(0)
  }).catch(fail)
}
