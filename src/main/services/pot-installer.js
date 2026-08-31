/**
 * fetches the PO token payload into userData/pot, once, on demand
 *
 * only an install youtube has actually refused ever needs this, so it is not
 * in the installer: the ~86% who are never blocked download nothing, and the
 * ones who are pay for it at the moment it would help them. that is the same
 * bargain the engine already makes with userData/engine, and it lands the same
 * way - download, verify, unpack, atomic swap - through the same machinery.
 *
 * nothing here may ever fail an operation. the payload being absent is a state
 * the engine already handles: getPotPaths() returns null, buildCommonArgs()
 * omits the flags, and the user gets exactly today's behaviour. so every
 * failure in this file resolves to a reason rather than throwing.
 */

const fsp = require("fs").promises
const path = require("path")

const { createHttpClient, swapIn, removeQuietly } = require("./ytdlp-updater")
// the download digests as it streams, so there is nothing left to hash here
const { extractZip } = require("../utils/archive")

/**
 * the payload version, pinned.
 *
 * the plugin and the generator it drives are version-locked to each other - a
 * major mismatch is a hard refusal from the plugin - so they ship as one
 * artifact and share one version. that makes the lock unbreakable rather than
 * merely documented.
 */
const POT_VERSION = "1.3.2"

// alongside ffmpeg and deno, on the release tag that already holds them
const DEFAULT_BASE_URL =
  "https://github.com/Cliply/Cliply/releases/download/binaries"

/**
 * sha-256 of each published payload, keyed by asset name.
 *
 * pinned here rather than fetched beside the download: a checksum served from
 * the same place as the bytes it vouches for only proves the two agree. the
 * payload version is pinned in this file anyway, so its digest costs nothing
 * to pin next to it.
 *
 * an asset with no entry here is one nobody has published and digested yet,
 * and it is refused rather than fetched - see checksumFor(), and canInstall(),
 * which is that same question asked before a user is told a fix is coming.
 * the entries are therefore the whole list of platforms this feature works on:
 * build-pot-payload.yml publishes exactly these two, and an install on any
 * other platform declines quietly rather than trusting whatever answers the
 * url. adding a platform means publishing its payload and pinning it here, in
 * that order.
 */
const POT_CHECKSUMS = {
  "pot-1.3.2-darwin-arm64.zip":
    "7357586086aaf6b116af1acbc3051723c8e98104777764efe9a54dd2e233a240",
  "pot-1.3.2-win32-x64.zip":
    "57d9db2a1494becf7e434292cbec30fa05577661da31f2ed013bbc92bca932de"
}

// the payload is a node_modules tree; a slow connection needs room for ~70 mb
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

// what a finished install leaves behind, so a later refresh can read the
// version it is replacing without unpacking anything
const VERSION_MARKER = ".pot-version.json"

/**
 * which payload this machine needs
 *
 * one artifact per platform and architecture, because the token generator's
 * fake browser includes a native drawing engine - botguard probes canvas, so
 * it is more faithful to ship it than to drop it, and shipping it means the
 * tree stops being portable.
 *
 * @param {string} platform - process.platform
 * @param {string} arch - process.arch
 * @returns {string} asset name
 */
function payloadAssetFor(platform = process.platform, arch = process.arch) {
  return `pot-${POT_VERSION}-${platform}-${arch}.zip`
}

/**
 * the digest an asset must match, or null when we have not vouched for one
 * @param {string} asset - asset name
 * @returns {string|null} lowercase hex sha-256
 */
function checksumFor(asset) {
  // the override exists so a payload can be staged and verified before it is
  // published. it still has to match, so it is a different digest rather than
  // no digest
  const override = process.env.CLIPLY_POT_SHA256

  if (override) {
    return String(override).trim().toLowerCase()
  }

  return POT_CHECKSUMS[asset] || null
}

class PotInstaller {
  /**
   * @param {Object} options
   * @param {Object} options.engine - the yt-dlp engine, for its userData path
   * @param {Object} [options.http] - injected for tests
   */
  constructor({ engine, http = null } = {}) {
    this.engine = engine
    // built on the first download rather than here: one of these is
    // constructed at every launch and the overwhelming majority never fetch
    // anything at all
    this.http = http
    // the install in flight, so a user who retries three times while it runs
    // starts one download rather than three onto the same directory
    this.inFlight = null
  }

  getPotDir() {
    return path.join(this.engine.getUserDataPath(), "pot")
  }

  /**
   * whether there is a payload this machine could actually fetch
   *
   * the same question install() asks, answered without starting anything, so
   * that a caller can find out before telling the user a fix is on its way. a
   * platform nobody has published and digested a payload for gets no download
   * and no promise of one - see POT_CHECKSUMS.
   *
   * @returns {boolean} true when a published, vouched-for payload exists
   */
  canInstall() {
    return Boolean(checksumFor(payloadAssetFor()))
  }

  /**
   * make sure the payload is installed, fetching it if it is not
   *
   * safe to call on every refusal: an install that is already there is
   * answered without touching the network, and one already running is joined
   * rather than started again. that idempotence is also what a later refresh
   * pass needs, so it can call this rather than grow its own copy.
   *
   * @returns {Promise<Object>} {installed, reason} - never rejects
   */
  ensureInstalled() {
    if (this.inFlight) {
      return this.inFlight
    }

    // present already: the engine finds the payload by looking for both halves
    // of it, so its answer is the one that decides this
    if (this.engine.getPotPaths()) {
      return Promise.resolve({ installed: true, reason: "already-installed" })
    }

    this.inFlight = this.install()
      .catch((error) => {
        // the contract for every caller: a payload that could not be fetched
        // leaves the app exactly as it was, so this is reported and swallowed
        console.warn("PO token payload install failed:", error.message)
        return { installed: false, reason: "install-failed", error: error.message }
      })
      .finally(() => {
        this.inFlight = null
      })

    return this.inFlight
  }

  /**
   * download, verify, unpack and swap the payload into place
   * @returns {Promise<Object>} {installed, reason}
   */
  async install() {
    const asset = payloadAssetFor()
    const expected = checksumFor(asset)

    if (!expected) {
      // nothing is published for this platform yet, or nobody has vouched for
      // what is. either way there is no version of this worth running
      console.warn(`no PO token payload is published for ${asset}`)
      return { installed: false, reason: "no-payload-published" }
    }

    const potDir = this.getPotDir()
    const parent = path.dirname(potDir)
    const workDir = path.join(parent, `.pot-download-${POT_VERSION}`)
    const stagingDir = path.join(parent, `.pot-staging-${POT_VERSION}`)

    const controller = new AbortController()
    const timeout = setTimeout(() => {
      console.warn("PO token payload download timed out, aborting")
      controller.abort()
    }, INSTALL_TIMEOUT_MS)

    if (typeof timeout.unref === "function") {
      timeout.unref()
    }

    try {
      // a previous attempt that died mid-flight leaves both of these behind,
      // and reusing either would install whatever it managed to write
      await removeQuietly(workDir)
      await removeQuietly(stagingDir)
      await fsp.mkdir(workDir, { recursive: true })

      const base = process.env.CLIPLY_POT_BASE_URL || DEFAULT_BASE_URL
      const zipPath = path.join(workDir, asset)
      const signal = controller.signal

      if (!this.http) {
        this.http = createHttpClient()
      }

      const digest = await this.http.download(`${base}/${asset}`, zipPath, {
        signal
      })

      if (digest !== expected) {
        console.warn(`PO token payload checksum mismatch: ${digest} != ${expected}`)
        return { installed: false, reason: "checksum-mismatch" }
      }

      await extractZip(zipPath, stagingDir, { signal })

      // both halves or nothing. the engine treats a payload with only one of
      // them as absent, so an archive that unpacked to something else would
      // otherwise install silently and never be used
      if (!(await hasBothHalves(stagingDir))) {
        return { installed: false, reason: "payload-layout-unexpected" }
      }

      await writeVersionMarker(stagingDir, asset)
      await swapIn(stagingDir, potDir)

      console.log(`installed the PO token payload (${asset})`)
      return { installed: true, reason: "installed" }
    } finally {
      clearTimeout(timeout)
      // the zip is never needed again, and staging only survives as potDir
      await removeQuietly(workDir)
      await removeQuietly(stagingDir)
    }
  }
}

// the two directories the engine's getPotPaths() insists on
async function hasBothHalves(root) {
  for (const half of ["plugin", "server"]) {
    try {
      const stats = await fsp.stat(path.join(root, half))
      if (!stats.isDirectory()) return false
    } catch {
      return false
    }
  }

  return true
}

/**
 * record what was installed, for whoever has to replace it later
 *
 * written into the staging directory rather than beside it, so it moves into
 * place with the payload it describes and cannot outlive it
 */
async function writeVersionMarker(stagingDir, asset) {
  await fsp.writeFile(
    path.join(stagingDir, VERSION_MARKER),
    JSON.stringify({ version: POT_VERSION, asset }, null, 2),
    "utf8"
  )
}

module.exports = {
  PotInstaller,
  payloadAssetFor,
  POT_VERSION,
  VERSION_MARKER,
  // exported for tests - "an asset nobody vouched for is refused" has no seam
  // once every shipping platform has a digest, and it is the guard that keeps
  // an unpublished platform from fetching whatever answers the url
  POT_CHECKSUMS
}
