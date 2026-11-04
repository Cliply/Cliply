// Verify final installer artifacts, not a newly repackaged smoke fixture.
// Installation is deliberately restricted to disposable native GitHub runners.
// GUI checks use the existing isolated-entry harness on copies of installed
// bytes; they do not claim pristine-launch, Gatekeeper or live-update coverage.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createHash } = require("node:crypto")
const { spawnSync } = require("node:child_process")
const { parseArgs } = require("node:util")
const metadata = require("../package.json")
const repo = path.resolve(__dirname, "..")

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repo, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024,
    windowsHide: true, ...options
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.equal(result.status, 0, result.error?.message || `${executable} exited ${result.status}`)
  return result.stdout || ""
}

function assertDisposableRunner() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "installer checks require a disposable GitHub runner")
  assert.equal(process.env.CI, "true", "installer checks are CI-only")
  assert(["darwin", "win32", "linux"].includes(process.platform), "unsupported installer host")
  assert.equal(process.arch, process.platform === "darwin" ? "arm64" : "x64", "use the supported native runner")
  if (process.platform === "linux") assert.notEqual(process.getuid(), 0, "run the app as the ordinary runner user")
}

async function sha256(file) {
  const hash = createHash("sha256")
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function payloadIdentity(resources) {
  const entries = {}
  async function visit(relative) {
    const file = path.join(resources, relative), stat = fs.lstatSync(file)
    const key = relative.split(path.sep).join("/")
    if (stat.isSymbolicLink()) entries[key] = { symlink: fs.readlinkSync(file) }
    else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) await visit(path.join(relative, name))
    } else {
      assert(stat.isFile(), "installer payload must contain regular files or relative links")
      entries[key] = { bytes: stat.size, sha256: await sha256(file) }
    }
  }
  for (const item of ["app.asar", "binaries"]) await visit(item)
  for (const item of ["app.asar.unpacked", "third-party"]) if (fs.existsSync(path.join(resources, item))) await visit(item)
  return entries
}

function installerArtifacts(directory, platform = process.platform) {
  const files = fs.readdirSync(directory)
  const types = platform === "darwin" ? ["dmg"] : platform === "win32" ? ["nsis"] : ["deb", "appimage"]
  return types.map(kind => {
    const extension = { dmg: ".dmg", nsis: ".exe", deb: ".deb", appimage: ".AppImage" }[kind]
    const matches = files.filter(name => name.endsWith(extension) && (kind === "nsis"
      ? name === `Cliply.Setup.${metadata.version}.exe`
      : name.startsWith(`Cliply-${metadata.version}-`)))
    assert.equal(matches.length, 1, `expected one current ${kind} installer, got ${matches.length}`)
    return { kind, file: path.resolve(directory, matches[0]) }
  })
}

function nsisArguments(directory, uninstall = false) {
  assert(path.win32.isAbsolute(directory), "NSIS needs an absolute install path")
  assert(!/["\r\n]/.test(directory), "NSIS path must not contain command-line delimiters")
  // NSIS requires /D= and _?= last, without quotes. windowsVerbatimArguments
  // preserves spaces as part of that final parameter (electron-builder does
  // the same in templates/nsis/include/installUtil.nsh).
  return ["/S", "/currentuser", `${uninstall ? "_?=" : "/D="}${directory}`]
}

function noWindowsInstall() {
  for (const hive of ["HKCU", "HKLM"]) {
    const result = spawnSync("reg.exe", ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", "Cliply", "/d"], { encoding: "utf8", windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 1, "refusing to replace an existing Cliply registration")
  }
}

function installedPackage(name) {
  const result = spawnSync("dpkg-query", ["-W", "-f=${db:Status-Status}", name], { encoding: "utf8" })
  if (result.error) throw result.error
  assert([0, 1].includes(result.status), "could not query installed DEB state")
  return result.status === 0 && result.stdout.trim() !== "not-installed"
}

function cleanupInstallation(cleanup, failure) {
  try { cleanup() } catch (error) {
    if (failure) throw new AggregateError([failure, error], "Installer validation and cleanup both failed")
    throw error
  }
}

async function withInstalledArtifact({ kind, file }, root, verify) {
  const owned = path.join(root, kind); fs.mkdirSync(owned)
  if (kind === "dmg") {
    const mount = path.join(owned, "mounted"); fs.mkdirSync(mount)
    let attached = false, failure
    try {
      attached = true
      command("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, file])
      const apps = fs.readdirSync(mount).filter(name => name.endsWith(".app"))
      assert.equal(apps.length, 1, "DMG must contain one app bundle")
      const destination = path.join(owned, "Installed App", apps[0]); fs.mkdirSync(path.dirname(destination))
      command("ditto", [path.join(mount, apps[0]), destination])
      await verify(path.join(destination, "Contents", "Resources"), "readonly-dmg-copy")
    } catch (error) { failure = error; throw error }
    finally { cleanupInstallation(() => { if (attached) command("hdiutil", ["detach", mount]) }, failure) }
  } else if (kind === "nsis") {
    noWindowsInstall()
    const destination = path.join(owned, "Installed App")
    assert(!fs.existsSync(destination), "installer target must be new")
    let attempted = false, failure
    try {
      attempted = true
      command(file, nsisArguments(destination), { windowsVerbatimArguments: true, timeout: 300000 })
      assert(fs.existsSync(path.join(destination, "Cliply.exe")), "NSIS did not install into the requested path with spaces")
      await verify(path.join(destination, "resources"), "nsis-per-user-install")
    } catch (error) { failure = error; throw error }
    finally { cleanupInstallation(() => {
      const uninstaller = path.join(destination, "Uninstall Cliply.exe")
      if (attempted && fs.existsSync(uninstaller)) {
        const copy = path.join(owned, "uninstall.exe"); fs.copyFileSync(uninstaller, copy)
        command(copy, nsisArguments(destination, true), { windowsVerbatimArguments: true, timeout: 180000 })
        assert(!fs.existsSync(path.join(destination, "Cliply.exe")), "NSIS uninstall left the installed executable")
        noWindowsInstall()
      } else if (attempted) assert(!fs.existsSync(destination), "partial NSIS installation needs cleanup")
    }, failure) }
  } else if (kind === "deb") {
    const name = command("dpkg-deb", ["--field", file, "Package"]).trim()
    assert.match(name, /^[a-z0-9][a-z0-9+.-]+$/, "invalid DEB package name")
    assert.equal(name, metadata.name, "unexpected DEB package")
    assert(!installedPackage(name), "refusing to replace an installed Cliply DEB")
    const destination = path.join("/opt", metadata.build.productName)
    assert(!fs.existsSync(destination), "refusing to replace an existing app directory")
    assert(!fs.existsSync("/usr/bin/cliply-desktop"), "refusing to replace an existing launcher")
    let attempted = false, failure
    try {
      attempted = true
      command("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends", file], { timeout: 300000 })
      assert(installedPackage(name), "DEB was not registered as installed")
      await verify(path.join(destination, "resources"), "apt-installed-deb")
    } catch (error) { failure = error; throw error }
    finally { cleanupInstallation(() => {
      if (attempted) {
        command("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "purge", "-y", name], { timeout: 180000 })
        assert(!installedPackage(name), "DEB cleanup left an installed package")
        assert(!fs.existsSync(path.join(destination, "resources", "app.asar")), "DEB cleanup left its app archive")
      }
    }, failure) }
  } else {
    assert.equal(kind, "appimage")
    command(file, ["--appimage-extract"], { cwd: owned, timeout: 180000 })
    await verify(path.join(owned, "squashfs-root", "resources"), "final-appimage-extracted-payload")
  }
}

async function run({ resources, directory = path.join(repo, "dist"), evidence, localMedia = false }) {
  assertDisposableRunner()
  assert(evidence && path.isAbsolute(evidence), "pass an absolute evidence JSON path")
  resources = path.resolve(resources)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-final-installer-"))
  const report = { schema: 1, platform: `${process.platform}-${process.arch}`, version: metadata.version,
    localMedia, guiMethod: "isolated entry in a disposable copy of installed payload, empty helper PATH",
    artifacts: [], passed: false, scratchCleanedUp: false }
  let failure
  const script = (name, args, extra = {}) => command(process.execPath, [path.join(__dirname, name), ...args], { timeout: 180000, ...extra })
  try {
    const expected = await payloadIdentity(resources)
    for (const artifact of installerArtifacts(directory)) {
      const record = { kind: artifact.kind, artifact: path.basename(artifact.file), sha256: await sha256(artifact.file), checks: [], passed: false, installationCleanupVerified: false }
      report.artifacts.push(record)
      await withInstalledArtifact(artifact, root, async (installedResources, method) => {
        record.installMethod = method; record.resources = installedResources
        const actual = await payloadIdentity(installedResources)
        assert.deepEqual(actual, expected, "installer changed the ASAR, helpers or source notices")
        record.checks.push("payload-identity")
        record.appAsarSha256 = actual["app.asar"].sha256
        const probe = actual[`binaries/ffprobe${process.platform === "win32" ? ".exe" : ""}`]
        if (probe) record.packagedFfprobeSha256 = probe.sha256
        script("verify-packaged-helpers.js", ["--resources", installedResources, ...(localMedia ? ["--require-ffprobe", "--require-ffprobe-notices"] : [])])
        record.checks.push("installed-helpers")
        script("smoke-packaged-local-media.js", ["--resources", installedResources, "--normal-startup", "--isolated-path"])
        record.checks.push("real-service-startup-from-installed-payload")
        if (localMedia) {
          script("smoke-packaged-local-media.js", ["--resources", installedResources, "--isolated-path"])
          record.checks.push("offline-local-media-ui-and-compatibility-playback")
        }
        script("smoke-download-recovery.js", ["--resources", installedResources, ...(localMedia ? ["--local-media"] : [])])
        record.checks.push("download-recovery")
        script("smoke-media.js", ["--resources", installedResources])
        record.checks.push("download-media-formats")
      })
      record.installationCleanupVerified = true
      assert.equal(await sha256(artifact.file), record.sha256, "validation changed the installer")
      record.passed = true
    }
    report.passed = true
  } catch (error) {
    failure = error; report.error = error.message; throw error
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 5 : 0, retryDelay: 100 })
      report.scratchCleanedUp = true
    } catch (error) {
      report.passed = false; report.cleanupError = error.message
      if (failure) console.error("Installed-artifact cleanup failed:", error)
      else { failure = error }
    }
    fs.mkdirSync(path.dirname(evidence), { recursive: true })
    fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + "\n")
    if (failure && report.scratchCleanedUp === false) throw failure
  }
  console.log("Final installer artifact checks passed:", evidence)
  return report
}

if (require.main === module) {
  const { values } = parseArgs({ options: { resources: { type: "string" }, directory: { type: "string" }, evidence: { type: "string" }, "local-media": { type: "boolean", default: false } } })
  if (!values.resources) throw new Error("Pass --resources <native unpacked resources> for the installer identity comparison")
  run({ resources: values.resources, directory: values.directory, evidence: values.evidence, localMedia: values["local-media"] }).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { run, assertDisposableRunner, installerArtifacts, nsisArguments, payloadIdentity, withInstalledArtifact }
