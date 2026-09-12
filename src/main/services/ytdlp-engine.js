/**
 * yt-dlp engine - spawns the standalone yt-dlp binary, one process per operation
 * replaces the python fastapi server: arg building, progress parsing,
 * stderr capture and error mapping live in ./ytdlp/
 *
 * this file is the YtdlpEngine class and the re-export barrel every consumer
 * and test reads. the barrel's keys are the module's public surface - the
 * submodules under ./ytdlp/ are an internal layout, and nothing outside this
 * file requires one directly
 */

const { spawn } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

// shared with the cookie manager on purpose: when the two disagreed about
// "#HttpOnly_" lines, downloads dropped a jar the ui called loaded
const { cookieFileHasEntries } = require("../utils/cookie-jar")

// re-exported from here, where every consumer and test already reads it; the
// cap itself is owned by the mappers - see services/ytdlp/args.js
const { PLAYLIST_MAX_ITEMS } = require("../utils/ytdlp-mappers")

const {
  buildCommonArgs,
  buildTrimArgs,
  buildArgs,
  normalizeAudioMode,
  normalizeAudioLanguage,
  normalizeQualityTier,
  expectedStreamCount,
  normalizeUrl,
  isYouTubeCookieHost,
  PLAYLIST_ERROR_BUDGET,
  PLAYLIST_SLEEP_REQUESTS,
  CONCURRENT_FRAGMENTS,
  PLAYLIST_FRAGMENTS,
  PLAYLIST_CONTAINER
} = require("./ytdlp/args")
const {
  ERROR_CODES,
  ERROR_METADATA,
  TERMINAL_ERRORS,
  explicitError,
  mapError,
  RECORDS_UNWRITABLE
} = require("./ytdlp/errors")
const { YtdlpOperation, killProcessTree } = require("./ytdlp/operation")
const {
  PROGRESS_TEMPLATE,
  FILE_TEMPLATE,
  STREAM_TEMPLATE,
  PLAYLIST_PROGRESS_TEMPLATE,
  PLAYLIST_STREAM_TEMPLATE,
  PLAYLIST_FILE_TEMPLATE,
  PLAYLIST_RECORD_TEMPLATE,
  parseProgressLine,
  parseDestinationLine,
  parseStreamCountLine,
  parsePlaylistProgressLine,
  parsePlaylistStreamLine,
  parsePlaylistFileLine,
  parsePlaylistRecordLine,
  parseArchiveSkipLine
} = require("./ytdlp/parsers")
const {
  ENGINE_DIR_NAME,
  POT_DIR_NAME,
  PLATFORM_DIRS,
  executableCandidates,
  resolveExecutableIn,
  nominalExecutableIn,
  legacyBinaryName,
  fileExists,
  directoryExists,
  electronPath
} = require("./ytdlp/paths")
const {
  normalizePlaylistIndices,
  buildPlaylistItemsSpec,
  buildPlaylistRecordsPath,
  verifySavedFile,
  readArchivedIds,
  archivedSelectionIndices,
  countArchivedSelections,
  expectedItemCount
} = require("./ytdlp/playlist")
const {
  OperationGate,
  RingBuffer,
  ProgressTracker,
  PlaylistProgressTracker,
  LineSplitter,
  STDERR_BUFFER_LINES,
  DEFAULT_WATCHDOG_MS,
  KILL_GRACE_MS,
  SHUTDOWN_WAIT_MS,
  PROBE_TIMEOUT_MS
} = require("./ytdlp/primitives")
const { redactLogLine } = require("../utils/log-redaction")

class YtdlpEngine {
  /**
   * @param {Object} options - explicit paths (tests and callers pass these in;
   *   anything omitted is resolved from electron / the bundled resources)
   */
  constructor(options = {}) {
    this.options = options
    this.userDataPath = options.userDataPath || null
    this.resourcesPath = options.resourcesPath || null
    this.ffmpegPath = options.ffmpegPath || null
    this.denoPath = options.denoPath || null
    this.cookieFile = options.cookieFile || null
    this.cookieManager = options.cookieManager || null
    // whether this install has been refused and needs to escalate to a PO
    // token. it lives on the engine as a plain boolean because run() is
    // synchronous while the setting it comes from is on disk - whoever reads
    // settings pushes the answer in here, the same way the engine version is
    // pushed into analytics
    this.potEnabled = Boolean(options.potEnabled)
    this.watchdogMs = options.watchdogMs || DEFAULT_WATCHDOG_MS
    this.killGraceMs = options.killGraceMs || KILL_GRACE_MS
    this.spawnFn = options.spawnFn || spawn
    this.killFn = options.killFn || process.kill

    this.operations = new Map()

    // {path, version} - see getVersion()
    this.cachedVersion = null

    // downloads and self-updates share one gate so neither can start while the
    // other holds it - see OperationGate
    this.gate = options.gate || new OperationGate()
  }

  // ---------------------------------------------------------------------------
  // paths
  // ---------------------------------------------------------------------------

  getUserDataPath() {
    if (this.userDataPath) {
      return this.userDataPath
    }

    this.userDataPath = electronPath("userData") || path.join(os.tmpdir(), "cliply")
    return this.userDataPath
  }

  getResourcesPath() {
    if (this.resourcesPath) {
      return this.resourcesPath
    }

    // in development the repo root plays the role of resourcesPath
    this.resourcesPath =
      process.env.NODE_ENV === "development"
        ? path.join(__dirname, "..", "..", "..")
        : process.resourcesPath || path.join(__dirname, "..", "..", "..")

    return this.resourcesPath
  }

  // userData/engine is the updater's workspace (staging dirs land here too)
  getEngineDir() {
    return path.join(this.getUserDataPath(), "engine")
  }

  // ...and userData/engine/ytdlp is the unpacked engine itself
  getInstalledEngineDir() {
    return path.join(this.getEngineDir(), ENGINE_DIR_NAME)
  }

  getInstalledBinaryPath() {
    const directory = this.getInstalledEngineDir()
    return resolveExecutableIn(directory) || nominalExecutableIn(directory)
  }

  // the read-only copy that ships in the installer
  getBundledEngineDir() {
    return this.resolveBundledDir([
      [ENGINE_DIR_NAME],
      [PLATFORM_DIRS[process.platform] || process.platform, ENGINE_DIR_NAME]
    ])
  }

  getBundledBinaryPath() {
    const directory = this.getBundledEngineDir()
    return resolveExecutableIn(directory) || nominalExecutableIn(directory)
  }

  /**
   * the binary to run: the writable userData copy wins, resources is the fallback
   * @returns {string} path to yt-dlp
   */
  getBinaryPath() {
    const installed = resolveExecutableIn(this.getInstalledEngineDir())

    if (installed) {
      return installed
    }

    return this.getBundledBinaryPath()
  }

  getFfmpegPath() {
    if (this.ffmpegPath) {
      return this.ffmpegPath
    }

    const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
    this.ffmpegPath = this.resolveBundled(
      [[name], [PLATFORM_DIRS[process.platform] || process.platform, name]],
      true
    )

    return this.ffmpegPath
  }

  getDenoPath() {
    if (this.denoPath) {
      return this.denoPath
    }

    const name = process.platform === "win32" ? "deno.exe" : "deno"
    this.denoPath = this.resolveBundled(
      [
        ["deno", name],
        ["deno", PLATFORM_DIRS[process.platform] || process.platform, name]
      ],
      true
    )

    return this.denoPath
  }

  /**
   * where the PO token payload lives, or null when it is not installed
   *
   * two halves, both required: `plugin` is the provider yt-dlp loads through
   * --plugin-dirs, `server` is the generator the provider runs on deno. a jar
   * with only one of them cannot mint anything, so it is treated as absent
   * rather than passed on to fail later with a warning nobody reads.
   *
   * userData wins over the bundled copy, which is the precedence
   * getBinaryPath() already uses for the engine: the payload can either ship in
   * the installer or be downloaded later by the installs that turn out to need
   * it, and a downloaded copy is the newer of the two.
   *
   * @returns {{pluginDir: string, serverHome: string}|null}
   */
  /**
   * remember that this install has to send a PO token from now on
   *
   * separate from the constructor because the answer lives in the settings
   * file, which is read asynchronously long after the engine is built - and
   * because a refusal can arrive mid-session, at which point every later
   * operation should escalate without waiting for a restart.
   *
   * @param {boolean} enabled
   */
  setPotEnabled(enabled) {
    this.potEnabled = Boolean(enabled)
  }

  getPotPaths() {
    const roots = [
      path.join(this.getUserDataPath(), POT_DIR_NAME),
      path.join(this.getResourcesPath(), "binaries", POT_DIR_NAME)
    ]

    for (const root of roots) {
      const pluginDir = path.join(root, "plugin")
      const serverHome = path.join(root, "server")

      if (directoryExists(pluginDir) && directoryExists(serverHome)) {
        return { pluginDir, serverHome }
      }
    }

    return null
  }

  // first existing candidate under <resources>/binaries, packaged layout first
  resolveBundled(candidates, allowMissing = false) {
    const base = path.join(this.getResourcesPath(), "binaries")

    for (const segments of candidates) {
      const candidate = path.join(base, ...segments)
      if (fileExists(candidate)) {
        return candidate
      }
    }

    return allowMissing ? null : path.join(base, ...candidates[0])
  }

  // same idea for the engine, which is a directory rather than a single file
  resolveBundledDir(candidates) {
    const base = path.join(this.getResourcesPath(), "binaries")

    for (const segments of candidates) {
      const candidate = path.join(base, ...segments)
      if (directoryExists(candidate)) {
        return candidate
      }
    }

    return path.join(base, ...candidates[0])
  }

  /**
   * the cookie file to pass to --cookies, or null when there is nothing useful
   * @returns {string|null} cookie file path
   */
  /**
   * the jar for one operation, or null when it has no business being there
   *
   * the url decides, not the operation name: getInfo serves youtube, pinterest
   * and tiktok alike, so there is no operation that means "this is youtube".
   *
   * an explicitly passed cookieFile still wins, including an explicit null.
   * That is how the cookie test forces the jar on for its probe, and it is why
   * the check is `!== undefined` rather than a truthiness test.
   *
   * @param {Object} params - the operation's parameters
   * @returns {string|null} path to pass to --cookies
   */
  resolveCookieFile(params = {}) {
    if (params.cookieFile !== undefined) {
      return params.cookieFile
    }

    return isYouTubeCookieHost(params.url) ? this.getCookieFile() : null
  }

  getCookieFile() {
    if (this.cookieManager) {
      const fromManager = this.cookieManager.getCookieFilePath()
      return fromManager && cookieFileHasEntries(fromManager) ? fromManager : null
    }

    if (this.cookieFile && cookieFileHasEntries(this.cookieFile)) {
      return this.cookieFile
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // running operations
  // ---------------------------------------------------------------------------

  /**
   * spawn one yt-dlp operation
   * @param {string} operation - info | playlist-info | combined | audio |
   *   simple | playlist-combined | playlist-audio
   * @param {Object} params - operation parameters (url, formats, output, trim)
   * @param {Object} options - {id, watchdogMs, cwd, onProgress}
   * @returns {YtdlpOperation} handle with promise / cancel() / events
   */
  run(operation, params = {}, options = {}) {
    const resolved = {
      ...params,
      ffmpegPath: params.ffmpegPath || this.getFfmpegPath(),
      denoPath: params.denoPath || this.getDenoPath(),
      cookieFile: this.resolveCookieFile(params),
      // buildCommonArgs needs both, and needs potEnabled first - so an install
      // that was never refused, which is most of them, does not pay two stat
      // calls per operation to look for a payload it would not use anyway
      potEnabled:
        params.potEnabled !== undefined ? params.potEnabled : this.potEnabled
    }

    resolved.potPaths =
      params.potPaths !== undefined
        ? params.potPaths
        : resolved.potEnabled
          ? this.getPotPaths()
          : null

    const id = options.id || `${operation}_${Date.now()}_${this.operations.size}`
    const isInfo = operation === "info" || operation === "playlist-info"
    const isPlaylistDownload =
      operation === "playlist-combined" || operation === "playlist-audio"

    // both of these have to happen *before* the spawn.
    //
    // the record file, because --print-to-file appends: a repeated operation
    // id would otherwise inherit whatever a crashed run left behind, and the
    // directory is engine-owned state that nothing else creates.
    //
    // the archive read, because yt-dlp writes to the archive as it goes -
    // reading it afterwards would report everything this run just added as
    // something it had skipped
    let reusedIndices = []
    let recordsError = null

    if (isPlaylistDownload) {
      resolved.recordsFile = buildPlaylistRecordsPath({
        userDataPath: this.getUserDataPath(),
        operationId: id
      })

      // and it has to actually work. a removal that quietly failed left the
      // path pointing at a *readable* record from the last run under this id,
      // and a download that then failed resolved as having saved the previous
      // run's file. there is no safe way to carry on from here - a channel we
      // cannot vouch for is not a channel - so this throws and the operation
      // settles without yt-dlp ever being spawned
      try {
        if (!resolved.recordsFile) {
          throw new Error("No records path for a playlist download.")
        }

        fs.mkdirSync(path.dirname(resolved.recordsFile), { recursive: true })
        // not recursive on purpose: a directory sitting on the records path is
        // a state nobody should be able to explain, and quietly deleting it is
        // a worse answer than refusing
        fs.rmSync(resolved.recordsFile, { force: true })
        // created, not merely absent, so "we could not write here" and "yt-dlp
        // recorded nothing" stay different states for the rest of the run
        fs.writeFileSync(resolved.recordsFile, "")
      } catch (error) {
        recordsError = error
        resolved.recordsFile = null
      }

      reusedIndices =
        resolved.ignoreArchive === true
          ? []
          : archivedSelectionIndices(
              resolved.playlistEntries,
              readArchivedIds(resolved.archiveFile)
            )
    }

    const handle = new YtdlpOperation({
      id,
      operation,
      binaryPath: this.getBinaryPath(),
      args: buildArgs(operation, resolved),
      // -P already decides where files land; inheriting a cwd that may not
      // exist would only turn into a confusing spawn ENOENT
      cwd: options.cwd || undefined,
      watchdogMs: options.watchdogMs || this.watchdogMs,
      collectStdout: isInfo,
      expectedStreams: expectedStreamCount(operation, resolved),
      // a playlist download reads its stdout through the PLAYLIST_* templates
      // and ends on a count of saved files rather than on the exit code
      playlist: isPlaylistDownload,
      expectedItems: expectedItemCount(operation, resolved),
      // what a recorded save is checked against: the same folder -P was built
      // from, so a save has to land where we asked for it
      outputDir: resolved.outputDir || null,
      recordsFile: resolved.recordsFile || null,
      // a records channel we could not prepare stops the run before it starts
      startupError: recordsError,
      reusedIndices,
      // a trimmed download is muxed by ffmpeg in a single pass, so the format
      // marker would over-count the sweeps
      trackStreamMarker: !resolved.timeRange,
      gate: this.gate,
      killGraceMs: options.killGraceMs || this.killGraceMs,
      spawnFn: this.spawnFn,
      killFn: this.killFn
    })

    if (typeof options.onProgress === "function") {
      handle.on("progress", options.onProgress)
    }

    this.operations.set(id, handle)

    // drop the handle synchronously as it settles, so a caller that awaits the
    // promise sees an accurate active count the moment it resumes
    const forget = () => this.operations.delete(id)
    handle.once("completed", forget)
    handle.once("failed", forget)

    // a spawn that failed inside the constructor already emitted its event
    if (handle.settled) {
      forget()
    }

    // nobody is required to await the promise - swallow the rejection here so
    // an unawaited cancel can never become an unhandled rejection
    handle.promise.catch(() => {})

    return handle
  }

  /**
   * fetch video metadata
   * @param {string} url - video url
   * @param {Object} options - {watchdogMs, cookieFile}
   * @returns {Promise<Object>} the parsed --dump-json payload
   */
  async getInfo(url, options = {}) {
    const handle = this.run("info", { url, ...options }, options)
    const result = await handle.promise

    try {
      return JSON.parse(result.stdout.trim())
    } catch (error) {
      const parseError = new Error("Couldn't read the video details.")
      parseError.code = ERROR_CODES.DOWNLOAD_FAILED
      parseError.suggestion = "Please try again."
      parseError.details = error.message
      throw parseError
    }
  }

  /**
   * fetch playlist metadata - one object, with the videos flat inside it
   * @param {string} url - playlist url
   * @param {Object} options - {watchdogMs, cookieFile}
   * @returns {Promise<Object>} the parsed --dump-single-json payload
   */
  async getPlaylistInfo(url, options = {}) {
    const handle = this.run("playlist-info", { url, ...options }, options)
    const result = await handle.promise

    try {
      return JSON.parse(result.stdout.trim())
    } catch (error) {
      // the same failure shape getInfo() throws. the line-per-entry parser this
      // replaced swallowed a broken payload into an empty array, which reaches
      // the user as a playlist that genuinely has no videos in it - a wrong
      // answer where this is a reported failure
      const parseError = new Error("Couldn't read the playlist details.")
      parseError.code = ERROR_CODES.DOWNLOAD_FAILED
      parseError.suggestion = "Please try again."
      parseError.details = error.message
      throw parseError
    }
  }

  downloadCombined(params, options = {}) {
    return this.run("combined", params, options)
  }

  downloadAudio(params, options = {}) {
    return this.run("audio", params, options)
  }

  downloadSimple(params, options = {}) {
    return this.run("simple", params, options)
  }

  /**
   * the engine version, cached
   *
   * a freshly unpacked onedir bundle pays a one-time os scan on its first run
   * (43 s measured on macos), so `--version` is not something the health checks
   * the renderer fires on mount should ever wait for twice. the answer only
   * changes when we replace the engine, which is what invalidateVersion() is for.
   *
   * @returns {Promise<string|null>} version string, or null when unusable
   */
  async getVersion() {
    const release = await this.gate.acquireRead()
    try {
      const binaryPath = this.getBinaryPath()

      if (this.cachedVersion && this.cachedVersion.path === binaryPath) {
        return this.cachedVersion.version
      }

      const version = await this.probeVersion(binaryPath)
      this.cachedVersion = { path: binaryPath, version }

      return version
    } finally {
      release()
    }
  }

  // call after seeding or a self-update swapped the binary
  invalidateVersion() {
    this.cachedVersion = null
  }

  /**
   * the version we already know, without going near the binary
   *
   * the application menu is built synchronously and the issue report has to
   * name the engine the moment it opens, so neither can await a probe. null
   * means we do not know - which is a state worth saying out loud rather than
   * papering over, since a refused seed leaves us in it for the whole run.
   *
   * @returns {string|null} version string, or null when unknown
   */
  getKnownVersion() {
    const binaryPath = this.getBinaryPath()

    return this.cachedVersion && this.cachedVersion.path === binaryPath
      ? this.cachedVersion.version
      : null
  }

  /**
   * take a version somebody else already probed
   *
   * the seed and the self-update both run `--version` on the engine they just
   * installed, and on a freshly unpacked onedir that first run is the one that
   * costs seconds. handing the answer back here means nothing downstream buys
   * it a second time.
   *
   * precondition: the caller probed the binary getBinaryPath() resolves to
   * *now*. this keys the answer to that path and asks nothing else - so a
   * caller that probes a staged engine before the swap, and reports it here,
   * files the new engine's version against the old one and every reader is
   * told the wrong thing until something invalidates it.
   *
   * @param {string} version - what that probe reported
   */
  rememberVersion(version) {
    // a probe that failed reports no version at all, and that is not an answer
    // worth keeping: recording it would forget a version we did have and pin
    // the result for the rest of the run, where an empty slot lets the next
    // getVersion() go and ask again
    if (!version) return

    this.cachedVersion = { path: this.getBinaryPath(), version }
  }

  /**
   * read the version of the binary that would be run
   * @param {string} binaryPath - optional override
   * @param {Object} options - {timeoutMs} - a first run needs far longer than
   *   a warm one, so the updater raises this when it probes a staged engine
   * @returns {Promise<string|null>} version string, or null when unusable
   */
  probeVersion(binaryPath = this.getBinaryPath(), options = {}) {
    const timeoutMs = options.timeoutMs || PROBE_TIMEOUT_MS
    const signal = options.signal || null

    return new Promise((resolve) => {
      let output = ""
      let child = null
      let settled = false
      let timeout = null
      let onAbort = null
      // a probe we killed cannot be trusted even if the child manages a clean
      // exit on its way out
      let discarded = false

      const settle = (value) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        if (onAbort && signal) signal.removeEventListener("abort", onAbort)
        resolve(value)
      }

      try {
        child = this.spawnFn(binaryPath, ["--version"], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true
        })
      } catch {
        settle(null)
        return
      }

      // node reports both "could not spawn" and "could not signal a running
      // child" as an error event. only the first means nothing is running.
      let spawned = typeof child.pid === "number"
      child.once("spawn", () => {
        spawned = true
      })

      // stopping the probe never settles the promise on its own: the caller
      // may be about to delete the directory this binary is running out of, so
      // it has to wait for the process to be confirmed gone
      const stop = () => {
        discarded = true
        killProcessTree(child, { spawnFn: this.spawnFn })
      }

      timeout = setTimeout(stop, timeoutMs)

      if (signal) {
        if (signal.aborted) {
          stop()
        } else {
          onAbort = stop
          signal.addEventListener("abort", onAbort)
        }
      }

      child.stdout.on("data", (data) => {
        output += data.toString()
      })

      child.on("close", (code) => {
        settle(!discarded && code === 0 && output.trim() ? output.trim() : null)
      })

      child.on("error", () => {
        if (spawned) {
          // the probe is still alive - only its close may settle this
          return
        }

        settle(null)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // bookkeeping
  // ---------------------------------------------------------------------------

  getActiveCount() {
    return this.operations.size
  }

  hasActiveOperations() {
    return this.operations.size > 0
  }

  getOperation(id) {
    return this.operations.get(id) || null
  }

  /**
   * cancel one operation
   * @param {string} id - operation id
   * @returns {boolean} whether it was cancelled
   */
  cancel(id) {
    const handle = this.operations.get(id)
    return handle ? handle.cancel() : false
  }

  // used on app quit - nothing should outlive the window
  cancelAll() {
    let cancelled = 0

    for (const handle of this.operations.values()) {
      if (handle.cancel()) {
        cancelled += 1
      }
    }

    return cancelled
  }

  /**
   * cancel everything and wait for the process tree to actually be gone,
   * not just for the signal to have been sent
   *
   * cancelAll() alone returns the moment signals go out - the sigterm grace
   * period and any taskkill spawn are still in flight. a caller that quits
   * right after it can exit before that escalation ever runs, orphaning
   * whatever yt-dlp had not managed to clean up yet. this waits for each
   * operation's own promise (which only settles once its child's close event
   * fires) instead, bounded so a wedged process can never hold the app open.
   *
   * @param {number} maxWaitMs - ceiling on how long to wait
   * @returns {Promise<number>} how many operations were cancelled
   */
  async awaitShutdown(maxWaitMs = SHUTDOWN_WAIT_MS) {
    // captured before cancelAll(), since a settling operation removes itself
    // from this.operations - the promises are what outlive that
    const settling = [...this.operations.values()].map((handle) =>
      handle.promise.catch(() => {})
    )
    const cancelled = this.cancelAll()

    if (settling.length > 0) {
      await Promise.race([
        Promise.all(settling),
        new Promise((resolve) => setTimeout(resolve, maxWaitMs))
      ])
    }

    return cancelled
  }
}

module.exports = {
  YtdlpEngine,
  YtdlpOperation,
  OperationGate,
  RingBuffer,
  ProgressTracker,
  PlaylistProgressTracker,
  LineSplitter,
  buildArgs,
  buildCommonArgs,
  buildTrimArgs,
  buildPlaylistItemsSpec,
  normalizePlaylistIndices,
  normalizeAudioMode,
  normalizeAudioLanguage,
  // the tier a request really produces, which is what a downloads list has to
  // label a row with: the whitelist and the mp4 fallback both live in there
  normalizeQualityTier,
  expectedStreamCount,
  parseProgressLine,
  parseDestinationLine,
  parseStreamCountLine,
  parsePlaylistProgressLine,
  parsePlaylistStreamLine,
  parsePlaylistFileLine,
  parsePlaylistRecordLine,
  parseArchiveSkipLine,
  verifySavedFile,
  readArchivedIds,
  archivedSelectionIndices,
  countArchivedSelections,
  buildPlaylistRecordsPath,
  normalizeUrl,
  isYouTubeCookieHost,
  redactLogLine,
  mapError,
  RECORDS_UNWRITABLE,
  cookieFileHasEntries,
  executableCandidates,
  resolveExecutableIn,
  nominalExecutableIn,
  legacyBinaryName,
  ERROR_CODES,
  // exported so a test can hold the two wording tables to their invariant:
  // they must not share a key, or wordingFor would silently shadow one
  ERROR_METADATA,
  TERMINAL_ERRORS,
  // the explicit-code half of fail(), exported so the shape contract is tested
  // against what fail actually calls rather than a copy of it
  explicitError,
  PROGRESS_TEMPLATE,
  FILE_TEMPLATE,
  STREAM_TEMPLATE,
  PLAYLIST_PROGRESS_TEMPLATE,
  PLAYLIST_FILE_TEMPLATE,
  PLAYLIST_STREAM_TEMPLATE,
  PLAYLIST_RECORD_TEMPLATE,
  ENGINE_DIR_NAME,
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_ERROR_BUDGET,
  PLAYLIST_SLEEP_REQUESTS,
  CONCURRENT_FRAGMENTS,
  PLAYLIST_FRAGMENTS,
  PLAYLIST_CONTAINER,
  STDERR_BUFFER_LINES
}
