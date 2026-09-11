/**
 * one spawned yt-dlp process, from the gate it waits behind to the terminal
 * state it settles on
 */

const { spawn } = require("child_process")
const { EventEmitter } = require("events")
const fs = require("fs")

const {
  ERROR_CODES,
  RECORDS_UNWRITABLE,
  explicitError,
  mapError
} = require("./errors")
const {
  FILE_PREFIX,
  stripAnsi,
  parseProgressLine,
  parseDestinationLine,
  parseStreamCountLine,
  parsePlaylistProgressLine,
  parsePlaylistStreamLine,
  parsePlaylistFileLine,
  parsePlaylistRecordLine
} = require("./parsers")
const { verifySavedFile } = require("./playlist")
const {
  RingBuffer,
  ProgressTracker,
  PlaylistProgressTracker,
  LineSplitter,
  STDERR_BUFFER_LINES,
  DEFAULT_WATCHDOG_MS,
  POSTPROCESS_WATCHDOG_MS,
  FFMPEG_PROGRESS_PATTERN,
  KILL_GRACE_MS
} = require("./primitives")
const { redactLogLine } = require("./redaction")

/**
 * kill a child process, taking its descendants with it on windows
 *
 * yt-dlp spawns ffmpeg and deno as its own children. on windows `child.kill`
 * only reaches yt-dlp itself, so the tree has to go through taskkill - which
 * can fail either by not spawning at all or by spawning and exiting non-zero
 * (access denied, pid already gone). both fall back to signalling directly.
 *
 * @param {Object} child - the child process to terminate
 * @param {Object} options - {spawnFn, signal} - signal is the posix signal
 * @returns {void}
 */
function killProcessTree(child, options = {}) {
  if (!child || child.killed) {
    return
  }

  const spawnFn = options.spawnFn || spawn
  const signal = options.signal || "SIGKILL"

  let fellBack = false
  const fallback = () => {
    if (fellBack) return
    fellBack = true
    try {
      child.kill(signal)
    } catch {
      // process already gone
    }
  }

  if (process.platform !== "win32") {
    fallback()
    return
  }

  let killer = null

  try {
    killer = spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    })
  } catch {
    fallback()
    return
  }

  killer.on("error", fallback)
  killer.on("close", (code) => {
    if (code !== 0) {
      fallback()
    }
  })
}

/**
 * one spawned yt-dlp process
 * exposes `promise`, `cancel()` and progress events (`events` is the handle itself)
 */
class YtdlpOperation extends EventEmitter {
  constructor({
    id,
    operation,
    binaryPath,
    args,
    cwd,
    watchdogMs = DEFAULT_WATCHDOG_MS,
    collectStdout = false,
    expectedStreams = 1,
    expectedItems = null,
    playlist = false,
    outputDir = null,
    recordsFile = null,
    startupError = null,
    reusedIndices = [],
    trackStreamMarker = true,
    gate = null,
    killGraceMs = KILL_GRACE_MS,
    spawnFn = spawn,
    killFn = process.kill
  }) {
    super()

    this.gate = gate
    this.killGraceMs = killGraceMs
    this.spawnFn = spawnFn
    this.killFn = killFn
    this.outputDir = outputDir
    this.recordsFile = recordsFile
    // how many positions the user ticked. the denominator of every count this
    // operation reports, and the one number yt-dlp is not asked about
    this.expectedItems = expectedItems

    this.id = id
    this.operation = operation
    this.binaryPath = binaryPath
    this.args = args
    this.cwd = cwd
    this.watchdogMs = watchdogMs
    this.collectStdout = collectStdout
    this.trackStreamMarker = trackStreamMarker
    this.playlist = Boolean(playlist)

    this.stderrBuffer = new RingBuffer(STDERR_BUFFER_LINES)
    this.tracker = this.playlist
      ? new PlaylistProgressTracker({ expectedStreams, totalItems: expectedItems })
      : new ProgressTracker(expectedStreams)
    this.stdout = ""
    this.filePath = null

    // playlist only: the files this run put on disk, keyed by the item's
    // autonumber so one item cannot be counted twice. filled from the record
    // file at exit and from nowhere else
    this.savedItems = new Map()
    this.recordsRead = false

    // ...and, separately, which of the selected positions yt-dlp will skip
    // because the archive already holds them. computed **before the run**, by
    // intersecting the selection's ids with the archive file, because reading
    // it afterwards would find everything this run had just added to it.
    //
    // it is a different claim from "saved" in any case: the archive records
    // that a download once succeeded, not that the file is there now - a new
    // download folder, or a file the user has deleted since, skips the same.
    //
    // the positions travel alongside the count because yt-dlp never announces
    // an archive-skipped item: they are the only handle the ui has on which
    // rows to draw as already downloaded rather than as never reached
    this.reusedIndices = Array.isArray(reusedIndices) ? [...reusedIndices] : []
    this.reusedItems = this.reusedIndices.length
    this.phase = "starting"
    this.cancelled = false
    this.stalled = false
    this.settled = false
    this.startedAt = Date.now()
    this.child = null
    this.watchdog = null
    this.killTimer = null
    this.releaseGate = null

    // the handle contract in the ticket - `events` is this emitter
    this.events = this

    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })

    // the run never happens if its save channel could not be prepared. this is
    // before begin(), so nothing is spawned and nothing is read: recordsFile
    // is null in this state, which is what keeps readSavedRecords out of the
    // stale file that caused the refusal
    if (startupError) {
      this.fail({
        code: ERROR_CODES.PERMISSION_ERROR,
        cause: startupError,
        wording: RECORDS_UNWRITABLE
      })
      return
    }

    this.begin()
  }

  // wait for the gate (an update may be replacing the binary) before spawning
  begin() {
    if (!this.gate) {
      this.start()
      return
    }

    this.gate.acquireRead().then((release) => {
      // cancelled while we were queued behind an update - never spawn at all.
      // cancel()'s own path already called fail() before this ever resolved,
      // so settled is already true and fail() here would just no-op - without
      // releasing a lock we only just received. release it directly, or every
      // update after this one sees the gate as busy forever.
      if (this.cancelled || this.settled) {
        release()
        return
      }

      this.releaseGate = release
      this.start()
    })
  }

  start() {
    try {
      this.child = this.spawnFn(this.binaryPath, this.args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // yt-dlp spawns ffmpeg and deno as its own children. detaching it into
        // its own process group on posix means a signal to -pid reaches every
        // descendant, not just yt-dlp - the same guarantee windows gets from
        // taskkill /T. windows has no equivalent grouping semantics for this
        // and uses taskkill for its tree-kill instead, so this stays off there.
        detached: process.platform !== "win32",
        env: { ...process.env }
      })
    } catch (error) {
      this.fail({ code: ERROR_CODES.ENGINE_MISSING, cause: error })
      return
    }

    const stdoutSplitter = new LineSplitter((line) => this.handleStdoutLine(line))
    const stderrSplitter = new LineSplitter((line) => this.handleStderrLine(line))

    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => {
      this.touch()
      if (this.collectStdout) {
        this.stdout += chunk
      }
      stdoutSplitter.push(chunk)
    })

    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk) => {
      this.touch()
      stderrSplitter.push(chunk)
    })

    this.child.on("error", (error) => {
      // ENOENT here means the binary vanished between the path check and spawn
      const code =
        error && error.code === "ENOENT"
          ? ERROR_CODES.ENGINE_MISSING
          : ERROR_CODES.DOWNLOAD_FAILED
      this.fail({ code, cause: error })
    })

    this.child.on("close", (exitCode) => {
      stdoutSplitter.flush()
      stderrSplitter.flush()
      this.clearTimers()

      if (this.settled) {
        return
      }

      // what was saved is read here, once, before anything is decided
      this.readSavedRecords()

      // **a playlist outcome is decided by counting items, not by the exit
      // code, in both directions.**
      //
      // yt-dlp exits 1 if any item failed, and an old playlist always holds a
      // few deleted videos, so a run that saved 8 of 9 exits 1 and would
      // otherwise be reported as "Download failed" with eight files on disk.
      //
      // it also exits **0** having done nothing at all: a selected position
      // that left the playlist between the listing and the download leaves it
      // "Downloading 0 items of 11" and perfectly happy. accepting that would
      // draw a full bar over an empty folder, and would hide the day an
      // upgrade stops printing the markers this all counts.
      //
      // a null exit code is excluded on top: that is a process that was
      // signalled rather than one that finished - an oom kill, Activity
      // Monitor, a crash - and it never decided it was done, so it does not
      // get to be `completed` on the strength of whatever it had written.
      //
      // every one of those failures goes through fail() with its tally
      // attached, exactly as a cancel does, so nothing already on disk is lost
      const succeeded = this.playlist
        ? exitCode !== null && this.accountedItems() > 0
        : exitCode === 0

      // the empty-run wording belongs to exactly one branch, and the order
      // matters: a cancel, a stall and an external kill all have their own
      // reason already, and saying "finished without saving" over a run that
      // saved eight files would be a contradiction
      const emptyRun =
        this.playlist &&
        !this.cancelled &&
        !this.stalled &&
        exitCode !== null &&
        this.accountedItems() === 0

      if (succeeded && !this.cancelled && !this.stalled) {
        this.setPhase("completed")
        this.emit(
          "progress",
          this.playlist
            ? this.tracker.finalSnapshot()
            : {
                progress: 100,
                streamProgress: 100,
                streamIndex: this.tracker.streamIndex,
                speed: null,
                eta: null,
                etaSeconds: 0
              }
        )

        // single-video runs get none of these keys, so nothing reading a
        // result today has to learn about items
        const tally = this.playlist ? this.itemTally() : null

        const result = {
          id: this.id,
          operation: this.operation,
          exitCode,
          // a playlist's filePath follows the records too, not the marker the
          // progress bar was reading
          filePath: tally ? tally.files[tally.files.length - 1] || null : this.filePath,
          stdout: this.stdout,
          stderr: this.getStderr(),
          durationMs: Date.now() - this.startedAt,
          ...tally
        }

        this.settled = true
        this.discardRecords()
        this.releaseGateIfHeld()
        this.emit("completed", result)
        this.resolve(result)
        return
      }

      this.fail({ exitCode, emptyRun })
    })

    this.touch()
    this.setPhase("running")
  }

  handleStdoutLine(line) {
    if (!line) return

    // the playlist prints are a different shape from the single-video ones, so
    // they get their own reader rather than a set of conditionals threaded
    // through this one. that separation is what keeps a single-video download
    // parsing exactly as it did before playlists existed
    if (this.playlist) {
      this.handlePlaylistStdoutLine(line)
      return
    }

    const streamCount = parseStreamCountLine(line)
    if (streamCount !== null) {
      if (this.trackStreamMarker) {
        this.tracker.setExpectedStreams(streamCount)
      }
      this.emit("streams", this.tracker.expectedStreams)
      return
    }

    const progress = parseProgressLine(line)
    if (progress) {
      const update = this.tracker.update(progress)

      // yt-dlp prints two 100% lines per stream - without this guard the phase
      // would flap back to downloading after postprocessing has started
      if (this.phase !== "processing" || update.streamProgress < 100) {
        this.setPhase("downloading")
      }

      this.emit("progress", update)

      // the last stream finishing means ffmpeg/postprocessing takes over, and
      // yt-dlp goes quiet until the file lands
      if (
        update.streamProgress >= 100 &&
        update.streamIndex >= this.tracker.expectedStreams - 1
      ) {
        this.setPhase("processing")
      }
      return
    }

    const destination = parseDestinationLine(line)
    if (destination) {
      this.filePath = destination
      this.emit("destination", destination)
      return
    }

    this.emit("stdout", line)
  }

  handlePlaylistStdoutLine(line) {
    const marker = parsePlaylistStreamLine(line)
    if (marker) {
      this.tracker.startItem(marker)
      this.emit("streams", this.tracker.expectedStreams)
      // out of `processing` the moment a new item starts, or item 2 would run
      // its whole download under the half-hour merge deadline
      this.setPhase("downloading")
      // ...and the flag alone does not do it. the chunk this line arrived in
      // called touch() *before* anything was parsed, so the timer running now
      // was armed under the phase the previous item left behind, and setPhase
      // only re-arms on the way *into* `processing`. without this an item that
      // announces itself and then hangs before its first byte waits half an
      // hour to be called stalled
      this.touch()
      // an item boundary moves the run's own bar even when the item that just
      // ended never printed a file, so this is emitted rather than waited on
      this.emit("progress", this.tracker.snapshot())
      return
    }

    const progress = parsePlaylistProgressLine(line)
    if (progress) {
      const update = this.tracker.update(progress)

      // yt-dlp prints two 100% lines per stream - without this guard the phase
      // would flap back to downloading after postprocessing has started
      if (this.phase !== "processing" || update.streamProgress < 100) {
        this.setPhase("downloading")
      }

      this.emit("progress", update)

      // the last stream of *this item* finishing means ffmpeg takes over and
      // yt-dlp goes quiet until the file lands. the next item's marker is what
      // brings the phase back
      if (
        update.streamProgress >= 100 &&
        update.streamIndex >= this.tracker.expectedStreams - 1
      ) {
        this.setPhase("processing")
      }
      return
    }

    // an item finished. **this moves the bar and nothing else** - what was
    // saved is read out of the record file at exit, because this channel also
    // carries metadata we did not write and a marker on it proves nothing
    const file = parsePlaylistFileLine(line)
    if (file) {
      this.tracker.completeItem(file.itemIndex)
      this.filePath = file.filePath
      this.emit("destination", file.filePath)
      // the phase deliberately stays where it is. the item is done and what
      // follows is yt-dlp choosing the next one, which is allowed to be quiet -
      // the next marker is what puts the short deadline back
      this.touch()
      this.emit("progress", this.tracker.snapshot())
      return
    }

    // a line that meant to be a marker and did not parse. it changes no
    // count, but it is worth saying out loud: this is what a yt-dlp that
    // changed its output would look like from in here
    if (stripAnsi(line).trim().startsWith(FILE_PREFIX)) {
      this.noteUnverifiedMarker("malformed")
      return
    }

    this.emit("stdout", line)
  }

  /**
   * read what yt-dlp recorded that it saved
   *
   * the record file is the only input to the saved count. it is appended to
   * by yt-dlp's own after_move hook and by nothing else, so a line that
   * reached it describes a file that reached its destination - and each one
   * is then checked against the filesystem anyway.
   *
   * idempotent: the close handler and fail() may both reach it, and the file
   * is deleted afterwards either way
   *
   * @returns {void}
   */
  readSavedRecords() {
    if (this.recordsRead || !this.playlist) return
    this.recordsRead = true

    if (!this.recordsFile) return

    let contents
    try {
      contents = fs.readFileSync(this.recordsFile, "utf8")
    } catch {
      // never created, which is what a run that reached no after_move looks
      // like. no saves, and not an error
      return
    }

    for (const line of contents.split("\n")) {
      if (!line.trim()) continue

      const record = parsePlaylistRecordLine(line)
      if (!record) {
        this.noteUnverifiedMarker("unreadable record")
        continue
      }

      const saved = verifySavedFile(record.filePath, this.outputDir)
      if (!saved) {
        this.noteUnverifiedMarker("recorded file did not check out")
        continue
      }

      this.savedItems.set(
        Number.isInteger(record.itemIndex) ? record.itemIndex : `path:${saved}`,
        saved
      )
    }
  }

  /**
   * throw the record file away
   *
   * it is per run and describes nothing once the run is over, and it lives in
   * the engine's own state directory rather than the user's. left behind only
   * when the app dies without settling the operation, where it is the one
   * trace of what a crashed run had managed to do
   *
   * @returns {void}
   */
  discardRecords() {
    if (!this.recordsFile) return

    try {
      fs.unlinkSync(this.recordsFile)
    } catch {
      // never created, or already gone
    }
  }

  /**
   * say out loud that a marker was ignored
   *
   * into the stderr buffer rather than nowhere: this is the one thing that
   * turns "the download failed" into a diagnosable report, and it is exactly
   * what a future yt-dlp changing its output would look like from in here.
   * the wording deliberately avoids every phrase the taxonomy matches on, so
   * a diagnostic can never become somebody else's classification.
   *
   * @param {string} reason - why it was not counted
   */
  noteUnverifiedMarker(reason) {
    this.stderrBuffer.push(`cliply: ignored an unverified file marker (${reason})`)
  }

  /**
   * items this run can account for, saved or reused
   *
   * the success test, and the reason it is not the exit code: yt-dlp exits 1
   * if any item failed, and 0 for a selection that turned out to be empty
   *
   * @returns {number} how many of the selected positions are accounted for
   */
  accountedItems() {
    return this.savedItems.size + this.reusedItems
  }

  /**
   * what a playlist run did, for a result or for a failure
   * @returns {Object} {files, itemsSaved, itemsReused, reusedIndices, itemsSkipped, itemsTotal}
   */
  itemTally() {
    const files = [...this.savedItems.values()]
    const itemsSaved = files.length
    const itemsReused = this.reusedItems
    // the selection, always. an item that vanished from the playlist between
    // the listing and the download is one of the skipped - reporting "2 of 2"
    // for a run the user asked three videos of would redefine the job as
    // whatever turned out to be possible
    const itemsTotal = this.expectedItems || this.accountedItems()

    return {
      files,
      itemsSaved,
      itemsReused,
      // the same fact as itemsReused, said per row. a copy, so nothing a
      // consumer does to the array reaches back into the operation
      reusedIndices: [...this.reusedIndices],
      itemsSkipped: Math.max(0, itemsTotal - this.accountedItems()),
      itemsTotal
    }
  }

  handleStderrLine(line) {
    if (!line || !line.trim()) return

    // the watchdog was already fed by the chunk this line arrived in, before
    // anything was parsed - so dropping the line here costs it nothing
    if (FFMPEG_PROGRESS_PATTERN.test(line.trimStart())) return

    const redacted = redactLogLine(line.trimEnd())
    this.stderrBuffer.push(redacted)
    this.emit("stderr", redacted)
  }

  setPhase(phase) {
    if (this.phase === phase) return
    this.phase = phase

    // the deadline is per-phase, and postprocessing's is much longer. re-arm on
    // the way in rather than waiting for output that, in this phase, is not
    // coming - the timer running right now was started under the old deadline.
    //
    // only this phase: the terminal phases are set either side of the close
    // handler's clearTimers(), where arming anything would be a timer nobody
    // clears again
    if (phase === "processing") {
      this.touch()
    }

    this.emit("phase", phase)
  }

  /**
   * how long this phase gets to stay silent before it is called wedged
   * @returns {number} milliseconds, or 0 when the watchdog is off entirely
   */
  watchdogDeadline() {
    if (!this.watchdogMs) return 0

    return this.phase === "processing"
      ? Math.max(this.watchdogMs, POSTPROCESS_WATCHDOG_MS)
      : this.watchdogMs
  }

  // reset the no-output watchdog
  touch() {
    if (this.settled) return

    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }

    const deadline = this.watchdogDeadline()
    if (!deadline) return

    this.watchdog = setTimeout(() => {
      this.stalled = true
      this.killChild()
    }, deadline)
  }

  clearTimers() {
    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }

  // hand the shared lock back so a queued update can proceed
  releaseGateIfHeld() {
    if (this.releaseGate) {
      const release = this.releaseGate
      this.releaseGate = null
      release()
    }
  }

  killChild() {
    if (!this.child || this.child.killed) {
      return
    }

    // yt-dlp spawns ffmpeg (and deno) as children. on windows child.kill only
    // reaches yt-dlp itself, leaving ffmpeg holding the output file, so the
    // whole tree has to go through taskkill
    if (process.platform === "win32") {
      this.killTree()
      return
    }

    this.signalGroup("SIGTERM")

    // sigterm first so yt-dlp gets the chance to stop on its own, then kill
    // hard if it hangs. it does *not* tidy up on the way out: the binary
    // installs no sigterm handler, so python dies where it stands and whatever
    // it had open stays on disk - measured, a cancelled 1080p download leaves
    // a `clip.f137.mp4.part` behind and prints nothing about it. that is by
    // design rather than a leak, since a .part is what makes the next run
    // resume instead of restart - but a *completed* stream left next to a
    // half-written one is why handlePlaylistStdoutLine refuses to count a
    // format intermediate as a saved video
    this.killTimer = setTimeout(() => {
      this.signalGroup("SIGKILL")
    }, this.killGraceMs)
  }

  /**
   * posix only: signal the process group start() detached this child into, so
   * ffmpeg and deno die with it instead of surviving as orphans. a group that
   * is already gone (esrch) falls back to the direct child, so a stuck
   * download is never left uncancellable because the group lookup failed
   * @param {string} signal - "SIGTERM" or "SIGKILL"
   */
  signalGroup(signal) {
    if (!this.child || !this.child.pid) return

    try {
      this.killFn(-this.child.pid, signal)
      return
    } catch {
      // no such process group - fall through to the direct child
    }

    try {
      this.child.kill(signal)
    } catch {
      // process already gone
    }
  }

  killTree() {
    killProcessTree(this.child, { spawnFn: this.spawnFn })
  }

  /**
   * cancel this operation - the child is killed and the promise rejects
   * @returns {boolean} whether the operation was still running
   */
  cancel() {
    if (this.settled || this.cancelled) {
      return false
    }

    this.cancelled = true
    this.setPhase("cancelled")

    // still queued behind an update: settle now, nothing was ever spawned
    if (!this.child) {
      this.fail({})
      return true
    }

    this.killChild()
    return true
  }

  fail({ code = null, exitCode = null, cause = null, emptyRun = false, wording = null }) {
    if (this.settled) return
    this.settled = true
    this.clearTimers()
    this.releaseGateIfHeld()

    // a cancel or a spawn failure never reaches the close handler's read
    this.readSavedRecords()

    const stderrLines = this.stderrBuffer.tail()
    // both branches go through errorShape, so an explicit code carries the same
    // seven keys a classified one does - a wording entry only defines the flags
    // it needs, and the rest have to read as false, not as missing
    const mapped = code
      ? explicitError(code, cause ? redactLogLine(cause.message) : null)
      : mapError({
          exitCode,
          stderrLines,
          cancelled: this.cancelled,
          stalled: this.stalled
        })

    // an explicit code may bring its own words. the taxonomy's entries are
    // shared and frozen, so a caller that knows something more specific than
    // the table does says it here rather than editing the table
    const error = new Error(wording ? wording.message : mapped.message)
    error.code = mapped.code
    error.suggestion = wording ? wording.suggestion : mapped.suggestion
    // ...and a wording that knows itself by name says so, so a reader of the
    // category alone cannot mistake it for the generic entry it overrode
    error.wordingCode = (wording && wording.code) || null
    // the empty-run wording replaces the technical detail *after* the taxonomy
    // has had the untouched stderr, and only when the taxonomy found nothing.
    // pushing it into the ring buffer instead would evict a line: 200 lines
    // is the whole buffer, and a bot-detection error followed by 199 ordinary
    // ones is one push away from being classified as a generic failure
    error.details =
      emptyRun && mapped.code === ERROR_CODES.DOWNLOAD_FAILED
        ? "yt-dlp finished without saving any of the selected videos."
        : mapped.details
    error.retryable = Boolean(mapped.retryable)
    error.updateMayFix = Boolean(mapped.updateMayFix)
    error.needsCookies = Boolean(mapped.needsCookies)
    error.exitCode = exitCode
    error.operationId = this.id
    error.stderrTail = stderrLines

    // a cancelled or stalled playlist keeps whatever it already saved: those
    // files are on disk either way, and discarding the list is how a cancel
    // turns into "we downloaded nothing" in front of a user looking at eight
    // finished videos. a total failure reports an empty list, which is the
    // same statement made honestly
    if (this.playlist) {
      Object.assign(error, this.itemTally())
      this.discardRecords()
    }

    this.emit("failed", error)
    this.reject(error)
  }

  /**
   * last captured stderr lines, redacted and ready for an issue report
   * @param {number} count - how many lines
   * @returns {string} joined stderr tail
   */
  getStderr(count = STDERR_BUFFER_LINES) {
    return this.stderrBuffer.toString(count)
  }
}

module.exports = {
  YtdlpOperation,
  killProcessTree
}
