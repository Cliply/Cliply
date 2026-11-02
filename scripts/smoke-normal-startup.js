// Packaged entry for real service startup with all writable paths isolated.
// No service implementations are replaced. External update timers are disabled.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os")
const assert = require("node:assert/strict")
const { app, dialog, session } = require("electron")
const profile = process.env.CLIPLY_SMOKE_USER_DATA
assert(profile && path.isAbsolute(profile))
const home = path.join(profile, "home"), downloads = path.join(home, "Downloads", "Cliply")
fs.mkdirSync(downloads, { recursive: true })
// Settings/cookies predate Electron and derive paths from os.homedir(). Redirect
// this accessor before requiring application modules; never change the real HOME.
os.homedir = () => home
app.setPath("home", home); app.setPath("userData", profile); app.setPath("sessionData", profile); app.setPath("downloads", downloads)
const root = path.join(process.resourcesPath, "cliply-under-test.asar")
require(path.join(root, "src/main/services/local-media/preview")).registerMediaScheme(require("electron").protocol)
const watchdog = setTimeout(() => { console.error("Normal startup timed out"); app.exit(1) }, 45000)
const fail = error => { console.error(error?.stack || error); clearTimeout(watchdog); app.exit(1) }
process.on("uncaughtException", fail); process.on("unhandledRejection", fail)
dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`) }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_request, callback) => callback({ cancel: true }))
  const { SettingsStore } = require(path.join(root, "src/main/services/settings-store"))
  const settings = new SettingsStore(); assert(settings.settingsFile.startsWith(home + path.sep))
  await settings.setAnalyticsEnabled(false)
  const CliplyApp = require(path.join(root, "src/main/index")), cliply = new CliplyApp()
  let serviceInitializationMs
  const initializeServices = cliply.initializeServices.bind(cliply)
  cliply.initializeServices = async () => { const at = performance.now(); await initializeServices(); serviceInitializationMs = performance.now() - at }
  cliply.scheduleEngineUpdate = () => {} // no external update check during timing
  cliply.setupAutoUpdater = () => {}
  const createWindow = cliply.createWindow.bind(cliply)
  const loaded = new Promise((resolve, reject) => {
    cliply.createWindow = () => {
      createWindow(); cliply.mainWindow.show = () => {}
      cliply.mainWindow.webContents.once("did-finish-load", resolve)
      cliply.mainWindow.webContents.once("render-process-gone", (_event, details) => reject(new Error(details.reason)))
    }
  })
  await cliply.initialize(); await loaded
  const wc = cliply.mainWindow.webContents
  for (let i = 0; i < 100 && !await wc.executeJavaScript("document.getElementById('root')?.childElementCount > 0"); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert(await wc.executeJavaScript("document.getElementById('root')?.childElementCount > 0"))
  const facts = { packaged: app.isPackaged, realServices: Object.keys(cliply.services), readyMs: process.uptime() * 1000,
    serviceInitializationMs,
    settingsIsolated: true, analyticsEnabled: cliply.services.analytics.enabled,
    engineSeeded: cliply.services.ytdlpEngine.getBinaryPath().startsWith(profile + path.sep), freshProfile: true }
  assert.equal(facts.analyticsEnabled, false); assert(facts.engineSeeded)
  app.getAppMetrics(); await new Promise(resolve => setTimeout(resolve, 3000))
  facts.processes = app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpu, memory }))
  const quitAt = performance.now()
  app.once("will-quit", () => {
    facts.quitDrainMs = performance.now() - quitAt
    console.log("Normal service startup passed:", JSON.stringify(facts)); clearTimeout(watchdog)
  })
  app.quit()
}).catch(fail)
