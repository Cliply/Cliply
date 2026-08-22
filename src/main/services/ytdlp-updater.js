/**
 * yt-dlp updater - owns the writable engine in userData/engine/ytdlp
 *
 * the app bundle is read-only (and signed on macos), so the engine that
 * actually runs is a copy under userData. the official builds are pyinstaller
 * *onedir* bundles, and those cannot update themselves (`yt-dlp -U` refuses),
 * so the whole update flow lives here:
 *
 *   latest stable tag -> platform zip + SHA2-256SUMS -> checksum -> staged
 *   unpack -> --version probe -> atomic swap
 *
 * every step before the swap is throwaway work: a failure at any point leaves
 * the running engine exactly as it was. the swap is a pair of renames inside
 * one directory, and only a directory we have already watched start up is ever
 * renamed into place.
 */

const fsp = require("fs").promises
const { createWriteStream } = require("fs")
const crypto = require("crypto")
const https = require("https")
const path = require("path")
const { pipeline } = require("stream/promises")

const { resolveExecutableIn, legacyBinaryName } = require("./ytdlp-engine")
const {
  extractZip,
  parseChecksums,
  throwIfAborted
} = require("../utils/archive")

// the redirect names the newest *stable* tag and, unlike the releases api, is
// not rate limited - which matters when every install checks on launch
const RELEASE_LATEST_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest"
const RELEASE_DOWNLOAD_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download"
const CHECKSUM_ASSET = "SHA2-256SUMS"

// the tag goes into a url, so it is validated rather than trusted
const TAG_PATTERN = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/

// how long the download + unpack phase may take before it is aborted. the
// archives are 18-54 mb, so this is a stalled-connection guard, not a budget
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000

// a staged engine has never run on this machine, so its --version pays the
// one-time os scan the seeded engine already absorbed
const STAGED_PROBE_TIMEOUT_MS = 5 * 60 * 1000

// remembers which packaged engine we have already read a version out of
const BUNDLED_MARKER = ".bundled-engine.json"

const REQUEST_TIMEOUT_MS = 60 * 1000
const MAX_REDIRECTS = 5
// SHA2-256SUMS is ~2 kb; anything near this is a redirect to something else
const MAX_TEXT_BYTES = 1024 * 1024
const USER_AGENT = "Cliply-Desktop"

/**
 * the release asset for a platform/arch pair
 * @param {string} platform - process.platform
 * @param {string} arch - process.arch
 * @returns {string|null} asset file name, or null when unsupported
 */
function releaseAssetFor(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") {
    return "yt-dlp_macos.zip"
  }

  if (platform === "win32") {
    if (arch === "arm64") return "yt-dlp_win_arm64.zip"
    if (arch === "ia32" || arch === "x86") return "yt-dlp_win_x86.zip"
    return "yt-dlp_win.zip"
  }

  if (platform === "linux") {
    return arch === "arm64" ? "yt-dlp_linux_aarch64.zip" : "yt-dlp_linux.zip"
  }

  return null
}

class YtdlpUpdater {
  /**
   * @param {Object} options - {engine, updateTimeoutMs, probeTimeoutMs, http, releaseAsset}
   */
  constructor(options = {}) {
    this.engine = options.engine
    this.updateTimeoutMs = options.updateTimeoutMs || UPDATE_TIMEOUT_MS
    this.probeTimeoutMs = options.probeTimeoutMs || STAGED_PROBE_TIMEOUT_MS
    // the only network surface in here, injectable so tests never leave the box
    this.http = options.http || createHttpClient()
    this.releaseAsset =
      options.releaseAsset !== undefined ? options.releaseAsset : releaseAssetFor()

    this.updating = false
    this.lastCheck = null
    this.lastResult = null
    this.abortController = null

    if (!this.engine) {
      throw new Error("YtdlpUpdater requires a YtdlpEngine instance")
    }
  }

  /**
   * make sure userData/engine holds a usable engine
   * takes the exclusive gate so it can't race a download that is starting
   * @returns {Promise<Object>} {seeded, reason, version}
   */
  async seed() {
    const release = this.acquire()

    if (!release) {
      return { seeded: false, reason: "busy" }
    }

    try {
      return await this.seedLocked()
    } finally {
      this.release(release)
    }
  }

  // take the exclusive half of the shared gate, synchronously
  acquire() {
    const release = this.engine.gate.tryAcquireWrite()

    if (release) {
      this.updating = true
    }

    return release
  }

  release(release) {
    this.updating = false
    release()
  }

  /**
   * the seeding logic itself - callers must already hold the gate
   * @returns {Promise<Object>} {seeded, reason, version}
   */
  async seedLocked() {
    const installedDir = this.engine.getInstalledEngineDir()
    const bundledDir = this.engine.getBundledEngineDir()

    try {
      await fsp.mkdir(this.engine.getEngineDir(), { recursive: true })
    } catch (error) {
      return { seeded: false, reason: "engine-dir-failed", error: error.message }
    }

    const bundledExecutable = resolveExecutableIn(bundledDir)
    const installedExecutable = resolveExecutableIn(installedDir)

    if (!installedExecutable) {
      if (!bundledExecutable) {
        return { seeded: false, reason: "no-binary-available" }
      }

      return this.installDirectory(bundledDir, "missing")
    }

    // an update interrupted at just the wrong moment, or a half-copied seed,
    // leaves a directory that no longer runs
    const installedVersion = await this.engine.probeVersion(installedExecutable, {
      timeoutMs: this.probeTimeoutMs
    })

    if (!installedVersion) {
      if (!bundledExecutable) {
        return { seeded: false, reason: "corrupt-and-no-bundle" }
      }

      return this.installDirectory(bundledDir, "corrupt")
    }

    await this.removeLegacyOnefile()

    if (!bundledExecutable) {
      return { seeded: false, reason: "up-to-date", version: installedVersion }
    }

    const bundledVersion = await this.getBundledVersion(bundledExecutable)

    if (bundledVersion && compareVersions(bundledVersion, installedVersion) > 0) {
      return this.installDirectory(bundledDir, "bundled-newer")
    }

    return { seeded: false, reason: "up-to-date", version: installedVersion }
  }

  /**
   * the version of the engine that ships in the app, remembered across launches
   *
   * the read-only copy in the app bundle has never been executed, so its very
   * first `--version` pays the same one-time os scan a fresh install does.
   * caching the answer against the file's size and mtime means that happens
   * once per app update rather than on the launch after every one of them.
   *
   * @param {string} bundledExecutable - the packaged engine's executable
   * @returns {Promise<string|null>} version string, or null when it won't run
   */
  async getBundledVersion(bundledExecutable) {
    const stats = await fsp.stat(bundledExecutable).catch(() => null)

    if (!stats) {
      return null
    }

    const markerPath = path.join(this.engine.getEngineDir(), BUNDLED_MARKER)
    const marker = await readJson(markerPath)

    // the marker has to look like a version, not merely be a non-empty string:
    // junk in here would compare as the oldest possible release and quietly
    // suppress every bundled upgrade until the file's metadata changed
    if (
      marker &&
      isVersionString(marker.version) &&
      marker.path === bundledExecutable &&
      marker.size === stats.size &&
      marker.mtimeMs === stats.mtimeMs
    ) {
      return marker.version
    }

    const version = await this.engine.probeVersion(bundledExecutable, {
      timeoutMs: this.probeTimeoutMs
    })

    // only a real answer is worth remembering: caching a failed probe would
    // suppress every later retry until the next app update, so a one-off
    // timeout or scanner hiccup could pin the user to an older engine forever
    if (isVersionString(version)) {
      await writeJson(markerPath, {
        path: bundledExecutable,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        version
      })
    } else {
      await removeQuietly(markerPath)
    }

    return version
  }

  /**
   * copy an engine directory into place through a staging copy, so a crash
   * mid-copy can never leave a half-written engine where one is expected
   * @param {string} sourceDir - directory to copy from
   * @param {string} reason - why we are seeding
   * @returns {Promise<Object>} {seeded, reason, version}
   */
  async installDirectory(sourceDir, reason) {
    const installedDir = this.engine.getInstalledEngineDir()
    const stagingDir = path.join(this.engine.getEngineDir(), `.seeding-${process.pid}`)

    try {
      await removeQuietly(stagingDir)
      await copyDirectory(sourceDir, stagingDir)
      await makeExecutable(stagingDir)
      await this.swapIn(stagingDir, installedDir)
    } catch (error) {
      await removeQuietly(stagingDir)
      console.warn("failed to seed the yt-dlp engine:", error.message)
      return { seeded: false, reason: "copy-failed", error: error.message }
    }

    // the engine changed underneath any cached answer
    if (typeof this.engine.invalidateVersion === "function") {
      this.engine.invalidateVersion()
    }

    await this.removeLegacyOnefile()

    // deliberate: the first run of a freshly installed onedir pays a one-time
    // os scan, and paying it here means the user's first action doesn't
    const version = await this.engine.probeVersion(
      resolveExecutableIn(installedDir) || this.engine.getInstalledBinaryPath(),
      { timeoutMs: this.probeTimeoutMs }
    )

    return { seeded: true, reason, version }
  }

  /**
   * background update check - safe to fire and forget on launch
   * refuses while downloads are running so a swap can't happen mid-download
   * @returns {Promise<Object>} {started, ...update result}
   */
  async checkForUpdate() {
    const release = this.acquire()

    if (!release) {
      return { started: false, reason: "busy" }
    }

    try {
      const result = await this.runUpdateLocked()

      if (result.reason === "no-binary-available") {
        return { started: false, reason: result.reason }
      }

      return { started: true, ...result }
    } finally {
      this.release(release)
    }
  }

  /**
   * update and wait for it - used by the repair-on-failure path
   * @returns {Promise<Object>} {updated, from, to, reason}
   */
  async updateNow() {
    const release = this.acquire()

    if (!release) {
      return { updated: false, reason: "busy" }
    }

    try {
      return await this.runUpdateLocked()
    } finally {
      this.release(release)
    }
  }

  /**
   * the update pipeline - callers must already hold the exclusive gate
   * @returns {Promise<Object>} {updated, from, to, reason, tag}
   */
  async runUpdateLocked() {
    const seeded = await this.seedLocked()
    const installedDir = this.engine.getInstalledEngineDir()

    if (!resolveExecutableIn(installedDir)) {
      return { updated: false, reason: "no-binary-available" }
    }

    this.lastCheck = new Date().toISOString()

    // seeding just probed the engine; asking again would cost another spawn
    const from =
      seeded.version ||
      (await this.engine.probeVersion(resolveExecutableIn(installedDir)))

    let tag = null

    try {
      tag = await this.fetchLatestTag()
    } catch (error) {
      console.warn("yt-dlp update check failed:", error.message)
      return { updated: false, reason: "check-failed", from, to: from, error: error.message }
    }

    if (from && compareVersions(tag, from) <= 0) {
      this.lastResult = { updated: false, from, to: from, tag }
      return { ...this.lastResult, reason: "up-to-date" }
    }

    const staged = await this.stageRelease(tag)

    if (!staged.ok) {
      return { updated: false, reason: staged.reason, from, to: from, tag, error: staged.error }
    }

    // the swap itself is deliberately not interruptible, so this is the last
    // moment a cancel can still be honoured
    if (staged.signal && staged.signal.aborted) {
      await removeQuietly(staged.dir)
      return { updated: false, reason: "cancelled", from, to: from, tag }
    }

    try {
      await this.swapIn(staged.dir, installedDir)
    } catch (error) {
      await removeQuietly(staged.dir)
      console.warn("failed to swap in the updated yt-dlp engine:", error.message)

      // the rename chain can strand the previous engine under its retired
      // name; never report an ordinary failure until something runnable is
      // back at the path the engine actually uses
      const recovery = error.retiredDir
        ? await this.recoverFromFailedSwap(error.retiredDir)
        : { reason: "swap-failed", version: from }

      return {
        updated: false,
        reason: recovery.reason,
        from,
        to: recovery.version,
        tag,
        error: error.message,
        ...(recovery.strandedAt ? { strandedAt: recovery.strandedAt } : {})
      }
    }

    if (typeof this.engine.invalidateVersion === "function") {
      this.engine.invalidateVersion()
    }

    const to = await this.engine.probeVersion(resolveExecutableIn(installedDir))

    // the staged engine ran before the swap, so this only trips when the
    // rename itself went wrong - reseed rather than leave the user with nothing
    if (!to) {
      const repair = await this.seedLocked()

      return {
        updated: false,
        reason: "repaired",
        from,
        to: repair.version || null,
        tag
      }
    }

    this.lastResult = { updated: to !== from, from, to, tag }

    return { ...this.lastResult, reason: "completed" }
  }

  /**
   * the newest stable tag, read from the /releases/latest redirect
   * @returns {Promise<string>} tag, e.g. "2026.08.19"
   */
  async fetchLatestTag() {
    const location = await this.http.getRedirectLocation(RELEASE_LATEST_URL)
    const tag = decodeURIComponent(
      String(location || "")
        .split(/[?#]/)[0]
        .split("/")
        .filter(Boolean)
        .pop() || ""
    ).trim()

    if (!TAG_PATTERN.test(tag)) {
      throw new Error(
        `could not read the latest yt-dlp release tag (${location || "no redirect"})`
      )
    }

    return tag
  }

  /**
   * download, verify and unpack a release into its own staging directory
   *
   * the staging directory only survives when the whole thing worked, so a
   * caller that gets `ok` may rename it straight into place
   *
   * @param {string} tag - release tag
   * @returns {Promise<Object>} {ok, dir, version} or {ok: false, reason, error}
   */
  async stageRelease(tag) {
    const engineDir = this.engine.getEngineDir()
    const workDir = path.join(engineDir, `.download-${tag}`)
    const stagingDir = path.join(engineDir, `.staging-${tag}`)

    const outcome = await this.downloadAndUnpack(tag, workDir, stagingDir)

    // the zip is never needed again, and staging is only kept on success
    await removeQuietly(workDir)

    if (!outcome.ok) {
      await removeQuietly(stagingDir)
    }

    return outcome
  }

  async downloadAndUnpack(tag, workDir, stagingDir) {
    const asset = this.releaseAsset

    if (!asset) {
      return { ok: false, reason: "unsupported-platform" }
    }

    // the abortable half of the update: everything up to the swap
    const controller = new AbortController()
    this.abortController = controller

    const timeout = setTimeout(() => {
      console.warn("yt-dlp update timed out, aborting the download")
      controller.abort()
    }, this.updateTimeoutMs)

    if (typeof timeout.unref === "function") {
      timeout.unref()
    }

    try {
      await removeQuietly(workDir)
      await removeQuietly(stagingDir)
      await fsp.mkdir(workDir, { recursive: true })

      const base = `${RELEASE_DOWNLOAD_BASE}/${encodeURIComponent(tag)}`
      const signal = controller.signal

      const listing = await this.http.getText(`${base}/${CHECKSUM_ASSET}`, { signal })
      const expected = parseChecksums(listing).get(asset)

      if (!expected) {
        return { ok: false, reason: "checksum-missing" }
      }

      const zipPath = path.join(workDir, asset)
      const digest = await this.http.download(`${base}/${asset}`, zipPath, { signal })

      if (digest !== expected) {
        console.warn(`yt-dlp ${tag} checksum mismatch: ${digest} != ${expected}`)
        return { ok: false, reason: "checksum-mismatch" }
      }

      await extractZip(zipPath, stagingDir, { signal })
      await makeExecutable(stagingDir)

      const executable = resolveExecutableIn(stagingDir)

      if (!executable) {
        return { ok: false, reason: "asset-layout-unexpected" }
      }

      // the last gate before the swap: an engine that cannot say what it is,
      // or says it is something other than the release we asked for, never
      // replaces one that works. the signal goes in too - a cancel while the
      // probe is running must stop it, not be discovered afterwards
      const version = await this.engine.probeVersion(executable, {
        timeoutMs: this.probeTimeoutMs,
        signal
      })

      // the probe resolves null on abort, but say so in the caller's words
      throwIfAborted(signal)

      if (!version) {
        return { ok: false, reason: "probe-failed" }
      }

      if (version.trim() !== tag) {
        console.warn(`yt-dlp ${tag} unpacked as ${version.trim()}, refusing it`)
        return {
          ok: false,
          reason: "version-mismatch",
          error: `staged engine reports ${version.trim()}, expected ${tag}`
        }
      }

      return { ok: true, dir: stagingDir, version: version.trim(), signal }
    } catch (error) {
      const aborted = error.name === "AbortError" || controller.signal.aborted
      console.warn(`yt-dlp update ${aborted ? "cancelled" : "failed"}:`, error.message)

      return {
        ok: false,
        reason: aborted ? "cancelled" : "download-failed",
        error: error.message
      }
    } finally {
      clearTimeout(timeout)
      this.abortController = null
    }
  }

  /**
   * put a prepared directory in place of the live one
   *
   * both live in userData/engine, so the renames are same-filesystem and
   * atomic; the old engine is only deleted once the new one is in place, and a
   * failure halfway puts it straight back
   *
   * @param {string} preparedDir - directory to move in
   * @param {string} installedDir - directory to replace
   * @returns {Promise<void>}
   */
  async swapIn(preparedDir, installedDir) {
    const retiredDir = `${installedDir}.retired-${Date.now()}`
    let retired = false

    try {
      // whatever is there goes, directory or not - an older build's onefile
      // could be sitting on this exact path
      if (await pathExists(installedDir)) {
        await fsp.rename(installedDir, retiredDir)
        retired = true
      }

      await fsp.rename(preparedDir, installedDir)
    } catch (error) {
      if (retired) {
        await removeQuietly(installedDir)

        try {
          await fsp.rename(retiredDir, installedDir)
        } catch (restoreError) {
          // the previous engine is still on disk, just not where the engine
          // looks for it. losing that fact here is how a user ends up with no
          // downloader at all, so it travels with the error
          error.retiredDir = retiredDir
          error.restoreError = restoreError.message
        }
      }

      throw error
    }

    await removeQuietly(retiredDir)
  }

  /**
   * put a runnable engine back after a swap that failed mid-rename
   *
   * called with the write gate still held, so nothing can spawn against the
   * half-moved directory while we sort it out
   *
   * @param {string} retiredDir - where the previous engine was renamed to
   * @returns {Promise<Object>} {reason, version, strandedAt}
   */
  async recoverFromFailedSwap(retiredDir) {
    const installedDir = this.engine.getInstalledEngineDir()

    if (typeof this.engine.invalidateVersion === "function") {
      this.engine.invalidateVersion()
    }

    // something usable may already be at the canonical path
    const installed = resolveExecutableIn(installedDir)
    const installedVersion = installed ? await this.engine.probeVersion(installed) : null

    if (installedVersion) {
      await removeQuietly(retiredDir)
      return { reason: "swap-failed", version: installedVersion }
    }

    // one more attempt at moving the previous engine back
    if (await pathExists(retiredDir)) {
      await removeQuietly(installedDir)

      try {
        await fsp.rename(retiredDir, installedDir)
      } catch (error) {
        console.warn("could not restore the previous yt-dlp engine:", error.message)
      }
    }

    const restored = resolveExecutableIn(installedDir)
    const restoredVersion = restored ? await this.engine.probeVersion(restored) : null

    if (restoredVersion) {
      return { reason: "swap-failed", version: restoredVersion }
    }

    // last resort: put the engine that ships with the app back in place
    const reseeded = await this.seedLocked()

    if (reseeded.version) {
      await removeQuietly(retiredDir)
      return { reason: "repaired", version: reseeded.version }
    }

    // nothing runnable anywhere. the retired copy is deliberately left on disk
    // - it is the only engine this machine still has
    console.error(
      `yt-dlp engine is stranded: no runnable engine at ${installedDir}, previous copy kept at ${retiredDir}`
    )

    return { reason: "swap-stranded", version: null, strandedAt: retiredDir }
  }

  /**
   * drop the self-extracting single file older builds installed
   * it can never be used again and costs ~40 mb of the user's disk
   * @returns {Promise<boolean>} whether anything was removed
   */
  async removeLegacyOnefile() {
    const legacy = path.join(this.engine.getEngineDir(), legacyBinaryName())

    try {
      const stats = await fsp.stat(legacy)

      if (!stats.isFile()) {
        return false
      }

      await fsp.rm(legacy, { force: true })
      console.log("removed the legacy single-file yt-dlp engine")
      return true
    } catch {
      // nothing to migrate
      return false
    }
  }

  /**
   * abort an update that is downloading or unpacking
   * the swap itself is two renames and is deliberately not interruptible
   * @returns {boolean} whether anything was aborted
   */
  terminateUpdate() {
    if (!this.abortController) {
      return false
    }

    this.abortController.abort()
    return true
  }

  /**
   * version of the binary the engine would run right now
   * @returns {Promise<string|null>} version string
   */
  async getInstalledVersion() {
    return this.engine.probeVersion(this.engine.getBinaryPath())
  }

  getStatus() {
    return {
      updating: this.updating,
      lastCheck: this.lastCheck,
      lastResult: this.lastResult,
      binaryPath: this.engine.getBinaryPath(),
      installedPath: this.engine.getInstalledBinaryPath()
    }
  }
}

// =============================================================================
// http - plain node https, no dependency and no electron import
// =============================================================================

function createHttpClient() {
  return {
    /**
     * the Location of a single redirect hop, without following it
     * @param {string} url - url to ask
     * @param {Object} options - {signal}
     * @returns {Promise<string|null>} absolute location, or null when not a redirect
     */
    async getRedirectLocation(url, options = {}) {
      const response = await httpGet(url, options)
      response.resume()

      if (!isRedirect(response) || !response.headers.location) {
        return null
      }

      return new URL(response.headers.location, url).toString()
    },

    /**
     * fetch a small text document
     * @param {string} url - url to fetch
     * @param {Object} options - {signal}
     * @returns {Promise<string>} the body
     */
    async getText(url, options = {}) {
      const response = await followRedirects(url, options)
      let body = ""

      response.setEncoding("utf8")

      for await (const chunk of response) {
        body += chunk

        if (body.length > MAX_TEXT_BYTES) {
          response.destroy()
          throw new Error(`unexpectedly large response from ${url}`)
        }
      }

      return body
    },

    /**
     * stream a file to disk, digesting it on the way past
     * @param {string} url - url to download
     * @param {string} destPath - where to write it
     * @param {Object} options - {signal}
     * @returns {Promise<string>} lowercase sha-256 hex digest
     */
    async download(url, destPath, options = {}) {
      const response = await followRedirects(url, options)
      const hash = crypto.createHash("sha256")

      response.on("data", (chunk) => hash.update(chunk))
      await pipeline(response, createWriteStream(destPath), {
        signal: options.signal || undefined
      })

      return hash.digest("hex")
    }
  }
}

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    let request

    try {
      request = https.get(
        url,
        {
          signal: options.signal || undefined,
          headers: { "user-agent": USER_AGENT, accept: "*/*" }
        },
        resolve
      )
    } catch (error) {
      reject(error)
      return
    }

    request.on("error", reject)
    request.setTimeout(options.timeoutMs || REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`request timed out: ${url}`))
    })
  })
}

async function followRedirects(url, options = {}, hops = 0) {
  const response = await httpGet(url, options)

  if (isRedirect(response) && response.headers.location) {
    response.resume()

    if (hops >= MAX_REDIRECTS) {
      throw new Error(`too many redirects for ${url}`)
    }

    const next = new URL(response.headers.location, url).toString()
    return followRedirects(next, options, hops + 1)
  }

  if (response.statusCode !== 200) {
    response.resume()
    throw new Error(`HTTP ${response.statusCode} for ${url}`)
  }

  return response
}

// yt-dlp versions are the release date, optionally with a build suffix - the
// same shape the release tags take
function isVersionString(value) {
  return typeof value === "string" && TAG_PATTERN.test(value.trim())
}

function isRedirect(response) {
  return response.statusCode >= 300 && response.statusCode < 400
}

// =============================================================================
// small file helpers
// =============================================================================

/**
 * copy a directory tree, preserving permission bits
 * fs.promises.cp would do this in one line, but it still prints an
 * experimental warning on the node electron 28 ships
 * @param {string} source - directory to copy
 * @param {string} destination - directory to create
 * @returns {Promise<void>}
 */
async function copyDirectory(source, destination) {
  await fsp.mkdir(destination, { recursive: true })

  const entries = await fsp.readdir(source, { withFileTypes: true })

  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)

    if (entry.isDirectory()) {
      await copyDirectory(from, to)
      continue
    }

    if (entry.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(from), to)
      continue
    }

    const stats = await fsp.stat(from)
    await fsp.copyFile(from, to)
    await fsp.chmod(to, stats.mode & 0o7777)
  }
}

// the executable bit is the one permission the engine cannot run without
async function makeExecutable(engineDir) {
  const executable = resolveExecutableIn(engineDir)

  if (!executable) {
    return
  }

  await fsp.chmod(executable, 0o755)
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"))
  } catch {
    // absent or unreadable is simply "nothing remembered"
    return null
  }
}

async function writeJson(filePath, value) {
  try {
    await fsp.writeFile(filePath, JSON.stringify(value))
  } catch {
    // a marker we could not write just means we probe again next launch
  }
}

async function pathExists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

function removeQuietly(target) {
  return fsp.rm(target, { recursive: true, force: true }).catch(() => {})
}

/**
 * compare two yt-dlp versions ("2026.08.19", "2026.08.19.232357")
 * @param {string} a - left version
 * @param {string} b - right version
 * @returns {number} 1 when a is newer, -1 when b is newer, 0 when equal
 */
function compareVersions(a, b) {
  const left = versionParts(a)
  const right = versionParts(b)
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index++) {
    const leftPart = left[index] || 0
    const rightPart = right[index] || 0

    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }

  return 0
}

function versionParts(version) {
  return String(version || "")
    .trim()
    .split(/[^\d]+/)
    .filter((part) => part !== "")
    .map((part) => parseInt(part, 10))
}

module.exports = {
  YtdlpUpdater,
  compareVersions,
  releaseAssetFor,
  createHttpClient,
  UPDATE_TIMEOUT_MS,
  STAGED_PROBE_TIMEOUT_MS
}
