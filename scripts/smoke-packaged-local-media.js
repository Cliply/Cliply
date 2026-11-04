// Run the production ASAR/preload/renderer and bundled helpers in a disposable
// native app copy. Only dialogs, external services and the test entry are replaced.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const { parseArgs } = require("node:util")
const { verifyPackagedHelpers } = require("./verify-packaged-helpers")
async function run(resources, { idleOnly = false, normalStartup = false, longMedia = false, isolatedPath = false } = {}) {
  resources = path.resolve(resources)
  assert(fs.existsSync(path.join(resources, "app.asar")), "pass an actual native packaged resources directory")
  await verifyPackagedHelpers(resources, { requireFfprobe: !idleOnly && !normalStartup })
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-local-package-"))
  let restoreSandbox
  let failure
  try {
    const mac = process.platform === "darwin"
    const sourceApp = mac ? path.resolve(resources, "../..") : path.dirname(resources)
    const appDir = path.join(scratch, mac ? "Cliply.app" : "app")
    // Keep framework links relative to this copy, not the original bundle.
    fs.cpSync(sourceApp, appDir, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE })
    const copiedResources = path.join(appDir, ...(mac ? ["Contents", "Resources"] : ["resources"]))
    fs.renameSync(path.join(copiedResources, "app.asar"), path.join(copiedResources, "cliply-under-test.asar"))
    if (fs.existsSync(path.join(copiedResources, "app.asar.unpacked"))) fs.renameSync(path.join(copiedResources, "app.asar.unpacked"), path.join(copiedResources, "cliply-under-test.asar.unpacked"))
    const entry = path.join(copiedResources, "app"); fs.mkdirSync(entry)
    for (const name of ["smoke-electron.js", "smoke-local-integration.js", "smoke-editor-workspace.js", "smoke-normal-startup.js", "smoke-losslesscut-preview.js"]) fs.copyFileSync(path.join(__dirname, name), path.join(entry, name))
    fs.writeFileSync(path.join(entry, "package.json"), JSON.stringify({ name: "cliply-package-test", version: "1.0.0", main: normalStartup ? "smoke-normal-startup.js" : "smoke-electron.js" }))
    const userData = path.join(scratch, "profile")
    fs.mkdirSync(userData)
    if (!idleOnly && !normalStartup) require("./smoke-local-integration").fixtures(userData, path.join(copiedResources, "binaries", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"), { longMedia })
    const env = { ...process.env, NODE_ENV: "production", CLIPLY_SMOKE_APP_ROOT: "bundled", CLIPLY_SMOKE_LOCAL_PACKAGE: "1", CLIPLY_SMOKE_INTEGRATION: "1", CLIPLY_SMOKE_USER_DATA: userData }
    for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "CLIPLY_DEV_FFPROBE", "CLIPLY_SMOKE_FFPROBE", "CLIPLY_SMOKE_FFMPEG", "CLIPLY_SMOKE_PREVIEW", "CLIPLY_SMOKE_EXPORT", "CLIPLY_SMOKE_TRACKS", "CLIPLY_SMOKE_REMUX", "CLIPLY_SMOKE_TRIM"]) delete env[key]
    if (!idleOnly && !normalStartup) {
      require("./smoke-losslesscut-preview").fixtures(userData, path.join(copiedResources, "binaries", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"))
      env.CLIPLY_SMOKE_COMPAT = "1"
    } else env.CLIPLY_SMOKE_COMPAT = "0"
    env.CLIPLY_SMOKE_IDLE = idleOnly ? "1" : "0"
    if (isolatedPath) {
      // Prove the application uses bundled absolute helper paths. Fixture
      // generation and ldd verification above still need normal OS tools.
      for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key]
      env.PATH = path.join(scratch, "empty-path"); fs.mkdirSync(env.PATH)
    }
    const executable = mac ? path.join(appDir, "Contents", "MacOS", "Cliply") : path.join(appDir, process.platform === "win32" ? "Cliply.exe" : "cliply-desktop")
    assert(fs.existsSync(executable), `missing packaged launcher: ${executable}`)
    if (process.platform === "linux" && process.env.GITHUB_ACTIONS === "true") {
      restoreSandbox = require("./prepare-linux-smoke-sandbox").prepareLinuxSmokeSandbox(scratch, appDir)
    }
    const result = spawnSync(executable, [], { env, encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024 })
    process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "")
    assert.equal(result.status, 0, result.error?.message || "packaged local-media smoke failed")
    assert.doesNotMatch((result.stdout || "") + (result.stderr || ""), /Error during shutdown:/, "packaged app reported a shutdown failure")
    assert.match(result.stdout, normalStartup ? /Normal service startup passed:/ : idleOnly ? /Packaged idle measurement:/ : /Local integration passed:/)
    console.log(idleOnly ? "Packaged idle check passed" : "Packaged local media passed without development helper overrides")
  } catch (error) {
    failure = error
    throw error
  } finally {
    const cleanupErrors = []
    try { restoreSandbox?.() } catch (error) { cleanupErrors.push(error) }
    try {
      // Only our disposable copy, after spawnSync has returned. Windows image
      // handles may outlive process exit briefly; never hide a persistent lock.
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 5 : 0, retryDelay: 100 })
    } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) {
      if (failure) {
        for (const error of cleanupErrors) console.error("Packaged smoke cleanup failed:", error)
      } else {
        throw new AggregateError(cleanupErrors, "Packaged smoke cleanup failed")
      }
    }
  }
}
if (require.main === module) {
  const { values } = parseArgs({ options: { resources: { type: "string" }, "idle-only": { type: "boolean", default: false }, "normal-startup": { type: "boolean", default: false }, "long-media": { type: "boolean", default: false }, "isolated-path": { type: "boolean", default: false } } })
  if (!values.resources) throw new Error("Pass --resources <actual native packaged resources>")
  run(values.resources, { idleOnly: values["idle-only"], normalStartup: values["normal-startup"], longMedia: values["long-media"], isolatedPath: values["isolated-path"] }).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { run }
