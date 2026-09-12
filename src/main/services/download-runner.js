/**
 * download runner - drives one engine download from start to terminal state
 * owns progress forwarding, the repair-on-failure retry, and analytics, so the
 * ipc layer stays a thin translation of request shapes
 */

const path = require("path")
const fs = require("fs")

const { ERROR_CODES } = require("./ytdlp-engine")
const { describeError } = require("../utils/analytics-helpers")
const { classify, ERROR_STAGES } = require("../utils/error-taxonomy")
const { APP_CONFIG } = require("../utils/constants")

// the statuses the renderer hooks already understand, plus `queued`, which is
// new: a download that has been accepted and is waiting for a slot. it is a
// state the renderer has never had to draw before, and an older consumer that
// only knows the other four writes it into `status` and carries on
const STATUS = {
  QUEUED: "queued",
  DOWNLOADING: "downloading",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
}

class DownloadRunner {
  /**
   * @param {Object} options - {engine, updater, sendEvent, trackEvent,
   *   logAudit, maxConcurrent}
   */
  constructor({
    engine,
    updater,
    sendEvent,
    trackEvent = () => {},
    logAudit = () => {},
    maxConcurrent = APP_CONFIG.MAX_CONCURRENT_DOWNLOADS
  }) {
    this.engine = engine
    this.updater = updater
    this.sendEvent = sendEvent
    this.trackEvent = trackEvent
    this.logAudit = logAudit

    // downloadId -> {handle, type, title, platform, started, request, label}
    this.active = new Map()

    /**
     * the slot semaphore
     *
     * `running` counts downloads that hold a slot, which is not the same as
     * `active.size`: a reservation exists from the moment the ipc layer claims
     * the id, and a queued one is very much active without running. `waiting`
     * holds one `{downloadId, resolve}` per parked run, oldest first, which is
     * what makes the queue FIFO by reservation time.
     */
    this.maxConcurrent = maxConcurrent
    this.running = 0
    this.waiting = []
  }

  /**
   * claim an id before the ipc acknowledgement goes out
   *
   * without this there is a window between "download started" reaching the
   * renderer and run() executing, in which a cancel would find nothing and the
   * download would start anyway.
   *
   * ids arrive from the renderer, so a repeated or forged one must never
   * displace a live download: the second reservation is refused instead of
   * overwriting bookkeeping the first one is still using.
   *
   * @param {string} downloadId - the id handed to the renderer
   * @param {Object} details - {type, platform, title, playlist, request, label}
   * @returns {boolean} false when this id is already running
   */
  reserve(downloadId, details = {}) {
    if (this.active.has(downloadId)) {
      return false
    }

    this.active.set(downloadId, {
      type: details.type,
      title: details.title,
      platform: details.platform,
      /**
       * the request this download was started from, stored exactly as the
       * renderer sent it, and a short human label for the row.
       *
       * main is the only place that knows the whole list, so a renderer that
       * reloads mid-download rebuilds its rows from list() - and a row it
       * cannot describe is a row with no retry. snake_case throughout, because
       * this is the wire payload kept rather than a shape of our own.
       */
      request: details.request,
      label: details.label,
      // one row covering n files rather than one covering a file. `type` stays
      // what it always was - "combined" or "audio" is still what this download
      // fetches, and analytics and the audit log read it - so the difference
      // lives in its own field instead of as a fifth media type
      playlist: Boolean(details.playlist),
      started: Date.now(),
      // every reservation begins queued, whether or not it ever waits: run()
      // moves it on where it takes a handle, so there is one place the status
      // changes rather than one per caller
      status: STATUS.QUEUED,
      handle: null,
      cancelled: false,
      // how far the engine got, kept for the two terminal states that report
      // it. a cancel arrives from another call stack entirely, so there is
      // nowhere else it could be read from by then
      progress: 0
    })

    return true
  }

  /**
   * run a download to completion, emitting progress events as it goes
   *
   * a playlist is one download id covering N files, so `playlist` widens what
   * this reports rather than changing how it runs: the same handle, the same
   * four terminal states, plus the item counts every one of them now carries.
   *
   * @param {Object} options - {downloadId, type, platform, title, formatId,
   *   trimmed, playlist, createHandle} - createHandle() returns a fresh engine
   *   handle
   * @returns {Promise<Object>} {success, filename, file_path, file_size} or {success:false, error}
   */
  async run(options) {
    const {
      downloadId,
      type,
      platform = "youtube",
      title = "unknown",
      formatId = "unknown",
      trimmed = false,
      playlist = false,
      createHandle
    } = options

    if (!this.active.has(downloadId)) {
      this.reserve(downloadId, { type, platform, title, playlist })
    }

    // a cancel may already have landed in the reservation window
    if (this.active.get(downloadId).cancelled) {
      return this.settleCancelled(downloadId)
    }

    // and here is where a download waits its turn. nothing has spawned yet, so
    // a queued row costs one entry in a map and a pending promise
    const holdsSlot = await this.acquireSlot(downloadId)

    let lastError = null
    let repaired = false

    try {
      // a cancel landing while this was parked wakes it without handing it a
      // slot, and the flag is what it wakes up to read
      const parked = this.active.get(downloadId)

      if (!parked || parked.cancelled) {
        return this.settleCancelled(downloadId)
      }

      // at most two passes: the second only happens when an update actually
      // changed the binary version (repair-on-failure)
      for (let attempt = 0; attempt < 2; attempt++) {
        let handle

        try {
          handle = createHandle()
        } catch (error) {
          lastError = error
          break
        }

        const entry = this.active.get(downloadId)

        // cancelled while we were creating the handle
        if (!entry || entry.cancelled) {
          handle.cancel()
          return this.settleCancelled(downloadId)
        }

        entry.handle = handle
        entry.status = STATUS.DOWNLOADING

        handle.on("progress", (update) => {
          if (Number.isFinite(update.progress)) {
            entry.progress = update.progress
          }

          // a trimmed download is one ffmpeg pass that only reports at the end,
          // so a percentage would sit at 0 and then jump - say "working" instead
          this.sendEvent(downloadId, {
            status: STATUS.DOWNLOADING,
            progress: trimmed ? undefined : update.progress,
            indeterminate: trimmed || undefined,
            speed: update.speed || undefined,
            eta: update.eta || undefined,
            ...(playlist ? itemProgressFields(update) : null)
          })
        })

        try {
          const result = await handle.promise
          return this.settleCompleted({ downloadId, type, platform, formatId, trimmed, result })
        } catch (error) {
          lastError = error

          if (error.code === ERROR_CODES.CANCELLED) {
            // the engine attaches the tally to the rejection, so a cancel can
            // still say which files it left on disk
            return this.settleCancelled(downloadId, error)
          }

          // an extraction-signature break is exactly what a newer yt-dlp fixes.
          //
          // a playlist retry re-runs the whole operation rather than resuming
          // where it broke, which sounds worse than it is: --download-archive
          // holds every item that already landed, so the second pass skips them
          // and picks up at the one that failed
          if (error.updateMayFix && !repaired && this.updater) {
            repaired = true
            // the slot is held across this, on purpose. it is still one
            // download, and freeing it for the length of an update would let a
            // fourth process start beside the three already running
            const update = await this.updater.updateNow().catch(() => null)

            const stillWanted = this.active.get(downloadId)

            if (stillWanted && stillWanted.cancelled) {
              return this.settleCancelled(downloadId)
            }

            if (update && update.updated) {
              console.log(
                `[${downloadId}] retrying after yt-dlp update ${update.from} -> ${update.to}`
              )
              continue
            }
          }

          break
        }
      }

      return this.settleFailed({ downloadId, type, platform, formatId, trimmed, error: lastError })
    } finally {
      // completion, failure, cancel and a throw out of any of them all come
      // through here, which is the only way the next download in line is ever
      // certain to start
      if (holdsSlot) {
        this.releaseSlot()
      }
    }
  }

  /**
   * wait until this download may run
   *
   * the one emission: a row that parks says so once, and a row that never
   * waited says nothing at all, so the renderer sees `queued` only when there
   * is really something to show.
   *
   * @param {string} downloadId - the id handed to the renderer
   * @returns {Promise<boolean>} whether a slot is now held. false means a
   *   cancel woke this waiter rather than a slot coming free
   */
  async acquireSlot(downloadId) {
    if (this.running < this.maxConcurrent) {
      this.running += 1
      return true
    }

    this.sendEvent(downloadId, { status: STATUS.QUEUED, progress: 0 })

    return new Promise((resolve) => {
      this.waiting.push({ downloadId, resolve })
    })
  }

  /**
   * give up a slot, and start whatever was waiting for it
   *
   * the slot is handed straight to the oldest waiter rather than freed and
   * re-taken: between a decrement and that waiter's continuation actually
   * running there is a turn of the event loop in which a fresh run() would find
   * room and jump the whole queue.
   */
  releaseSlot() {
    const next = this.waiting.shift()

    if (next) {
      next.resolve(true)
      return
    }

    this.running -= 1
  }

  /**
   * take a download out of the queue without giving anyone its slot
   *
   * a cancelled waiter still has to be woken, or run() would sit on a promise
   * nothing will ever resolve and the reservation would never settle. it wakes
   * with `false`, so it settles as cancelled and releases nothing.
   *
   * @param {string} downloadId - the id handed to the renderer
   * @returns {boolean} whether this download was queued
   */
  dropWaiter(downloadId) {
    const index = this.waiting.findIndex((waiter) => waiter.downloadId === downloadId)

    if (index === -1) {
      return false
    }

    const [waiter] = this.waiting.splice(index, 1)
    waiter.resolve(false)

    return true
  }

  /**
   * hand an analytics event to the ipc layer's translator
   *
   * these calls sit inside run()'s try, where a throw would be caught as the
   * download itself breaking - a finished download reported to the user as a
   * failure. the exit point never throws, but the callback is injected and
   * this is the cheapest place to be certain of it.
   *
   * the catch reads the thrown value through describeError rather than off its
   * own `.message`: a getter can throw, and it would throw here, inside the
   * catch, where the download this is guarding is what pays for it.
   *
   * @param {string} name - the runner's own event name
   * @param {Object} payload - what the translator reads
   */
  track(name, payload) {
    try {
      this.trackEvent(name, payload)
    } catch (error) {
      console.warn(`failed to track ${name}:`, describeError(error))
    }
  }

  settleCompleted({ downloadId, type, platform, formatId, trimmed, result }) {
    // the reservation is where the wait began - before the ipc acknowledgement
    // and before the spawn, which is what the user actually sat through
    const entry = this.active.get(downloadId)
    const elapsedMs = entry ? Date.now() - entry.started : null

    this.active.delete(downloadId)

    const filePath = result.filePath || null
    const filename = filePath ? path.basename(filePath) : undefined
    const fileSize = fileSizeOf(filePath)
    const tally = itemTally(result)

    /**
     * partial success must not lose the taxonomy of what did not make it.
     *
     * a run where one item was archive-skipped and the other nine hit bot
     * detection arrives here as a *completed* download, and the only account
     * of those nine is the stderr the engine attached to the result. so it is
     * classified while the reason is still readable: the renderer gets to say
     * why nine were skipped, and the PO token escalation - which fires off a
     * category and nothing else - still hears about a refusal it would
     * otherwise have slept through, because this download succeeded.
     */
    const skipped =
      tally && tally.items_skipped > 0
        ? classify(result.stderr, ERROR_STAGES.DOWNLOAD).category
        : null

    this.logAudit("download_success", true, { type, filename })

    this.sendEvent(downloadId, {
      status: STATUS.COMPLETED,
      progress: 100,
      filename,
      ...tally,
      ...(skipped ? { category: skipped } : null)
    })

    // no title and no filename: what was downloaded is not a question
    // telemetry asks, and the two of them were the only free text here
    this.track("download_completed", {
      type,
      platform,
      formatId,
      trimmed,
      fileSize,
      elapsedMs,
      ...playlistTelemetry(entry, result)
    })

    return {
      success: true,
      filename,
      file_path: filePath,
      file_size: fileSize,
      type,
      download_id: downloadId,
      ...tally,
      ...(skipped ? { category: skipped } : null)
    }
  }

  settleCancelled(downloadId, error = null) {
    // read before the delete: a cancel can land in any of four places, and the
    // reservation is the one thing all four of them have
    const entry = this.active.get(downloadId)
    // a playlist cancel is a kill, and the videos it had already finished are
    // still on disk. reporting an empty list is how "we downloaded nothing"
    // ends up in front of a user looking at eight finished files
    const tally = itemTally(error)

    this.active.delete(downloadId)
    this.logAudit("download_cancelled", true, {})

    this.sendEvent(downloadId, {
      status: STATUS.CANCELLED,
      progress: 0,
      ...tally
    })

    this.track("download_cancelled", {
      type: entry && entry.type,
      platform: entry && entry.platform,
      progress: entry ? entry.progress : 0,
      ...playlistTelemetry(entry, error)
    })

    return { success: false, cancelled: true, download_id: downloadId, ...tally }
  }

  settleFailed({ downloadId, type, platform, formatId, trimmed, error }) {
    const entry = this.active.get(downloadId)
    const progress = entry ? entry.progress : 0

    this.active.delete(downloadId)

    const message = (error && error.message) || "Download failed"
    const details = buildFailureDetails(error)
    // a stalled playlist rejects like a cancelled one, with the files it did
    // save attached, and they are just as real as the ones a cancel kept
    const tally = itemTally(error)

    this.logAudit("download_failed", false, { type, error: message })

    this.sendEvent(downloadId, {
      status: STATUS.FAILED,
      progress: 0,
      error: message,
      details,
      category: (error && error.code) || "DOWNLOAD_FAILED",
      ...tally,
      /**
       * a playlist can refuse to start for a reason that has nothing to do
       * with the network, the link or the download folder: the engine writes
       * a private record of what it saved, and if it cannot prepare that file
       * it rejects with a PERMISSION_ERROR of its own wording before anything
       * spawns. "Please try again" is the wrong answer to that, and it is the
       * one the renderer falls back to when nothing else arrives - so the
       * suggestion that came with the failure travels with it.
       *
       * playlist runs only. a single-video failed event carries the four keys
       * it has always carried, and every existing consumer reads exactly those
       */
      ...(tally && error && error.suggestion
        ? { suggestion: error.suggestion }
        : null),
      // and the name of that wording, when it has one. the category says
      // PERMISSION_ERROR either way, so this is the only thing separating a
      // records folder we cannot write from a download folder we cannot write
      ...(tally && error && error.wordingCode
        ? { wordingCode: error.wordingCode }
        : null)
    })

    // the code goes over as-is, absent and all: the engine sets DOWNLOAD_FAILED
    // itself when it ran and broke unrecognisably, and defaulting to the same
    // string here would make a failure that never reached the engine at all
    // indistinguishable from one that did
    this.track("download_failed", {
      type,
      platform,
      formatId,
      trimmed,
      progress,
      errorCode: error && error.code,
      errorMessage: message,
      ...playlistTelemetry(entry, error)
    })

    return { success: false, error, message, details, download_id: downloadId, ...tally }
  }

  /**
   * cancel a running download
   * @param {string} downloadId - the id handed to the renderer
   * @returns {boolean} whether something was cancelled
   */
  cancel(downloadId) {
    const entry = this.active.get(downloadId)

    if (!entry) {
      return false
    }

    // the flag covers every phase: reserved-but-not-started, queued behind the
    // cap, waiting on an update, and between retry attempts. the handle may not
    // exist yet.
    const alreadyCancelled = entry.cancelled
    entry.cancelled = true

    // a queued download has no process to kill, so cancelling one is only ever
    // waking it: run() re-reads the flag it was just given and settles through
    // settleCancelled, which emits the same `cancelled` event a running
    // download's would. nothing spawns, and no slot changes hands
    this.dropWaiter(downloadId)

    if (entry.handle) {
      return entry.handle.cancel() || !alreadyCancelled
    }

    return !alreadyCancelled
  }

  cancelAll() {
    let cancelled = 0

    for (const downloadId of [...this.active.keys()]) {
      if (this.cancel(downloadId)) {
        cancelled += 1
      }
    }

    return cancelled
  }

  has(downloadId) {
    return this.active.has(downloadId)
  }

  get size() {
    return this.active.size
  }

  /**
   * a snapshot of every download still in flight
   *
   * shaped to match the renderer's DownloadStatus contract (downloadId,
   * status, progress) plus the extra bookkeeping fields a caller building a
   * downloads list would also want - `playlist` among them, because a playlist
   * is one row that expands into n videos and a single video is one row that
   * does not, and nothing else in here says which of the two this is.
   *
   * `status` now includes `queued`, and `request` and `label` are what a
   * renderer that reloaded mid-download rebuilds a complete row from: the
   * request it would re-send to retry, and the words to put beside the title.
   * @returns {Object[]}
   */
  list() {
    return [...this.active.entries()].map(([downloadId, entry]) => ({
      downloadId,
      status: entry.status,
      progress: entry.progress,
      type: entry.type,
      title: entry.title,
      platform: entry.platform,
      playlist: entry.playlist,
      startTime: entry.started,
      request: entry.request,
      label: entry.label
    }))
  }
}

/**
 * what a playlist run did, in the spelling the ipc payloads use
 *
 * the engine hangs the same five keys on a result and on a rejection, so one
 * reader serves all four terminal states. a single-video settle has none of
 * them and must keep having none of them: a result shape widened for everybody
 * is a result shape every existing consumer has to re-learn.
 *
 * `items_reused` stays its own number and is never folded into `items_saved`.
 * an archive skip records that a download once succeeded, not that this run
 * wrote a file - the user deleted it, or pointed us at a new folder - so
 * adding the two together would claim saves we did not make.
 *
 * @param {Object|null} source - an engine result, or the error it rejected with
 * @returns {Object|null} the counts, or null when this was not a playlist
 */
function itemTally(source) {
  if (!source || !Array.isArray(source.files)) return null

  return {
    files: source.files,
    items_saved: source.itemsSaved,
    items_reused: source.itemsReused,
    items_skipped: source.itemsSkipped,
    items_total: source.itemsTotal,
    /**
     * which positions the archive accounted for, when the engine said.
     *
     * yt-dlp never announces an archive-skipped item, so without these the
     * renderer's rows for videos the user already has sit at "never reached"
     * and settle as skipped. spread conditionally rather than passed through
     * as undefined: an engine result from before this key existed produces
     * exactly the payload it always did.
     */
    ...(Array.isArray(source.reusedIndices)
      ? { reused_indices: source.reusedIndices }
      : null)
  }
}

/**
 * the playlist half of a terminal analytics payload
 *
 * two separate sources, because they answer two questions that come apart. the
 * **reservation** is what knows this download is a playlist at all: a run
 * refused before the engine could write its own record rejects carrying no
 * tally, and it was a playlist all the same - so `is_playlist` never depends on
 * anything having been counted. the **engine's** result or rejection is what
 * knows the counts, and a payload with none of them is honest about a run that
 * never got as far as counting.
 *
 * camelCase, like every other key in a track payload. the ipc payloads use the
 * snake_case spelling (see itemTally above) and trackDownloadEvent in
 * ipc-handlers.js is the one place the two meet - it decides which counts each
 * event may carry, because the allowlist there does.
 *
 * @param {Object|null} entry - the reservation, before it was deleted
 * @param {Object|null} source - an engine result, or the error it rejected with
 * @returns {Object|null} the playlist properties, or null for a single video
 */
function playlistTelemetry(entry, source) {
  if (!entry || !entry.playlist) return null

  const counts = source || {}

  return {
    playlist: true,
    itemsSaved: counts.itemsSaved,
    itemsReused: counts.itemsReused,
    itemsSkipped: counts.itemsSkipped,
    itemsTotal: counts.itemsTotal
  }
}

/**
 * the per-item half of a playlist's two-level progress
 *
 * the engine's playlist update is a superset of the single-video one - its
 * `progress` is the whole run's bar, which is what a flat consumer already
 * reads - so this only has to carry the second level across.
 *
 * there is no item title here because the engine never sees one: yt-dlp
 * announces an item by id, and the renderer is holding the listing that names
 * it. `playlist_index` is the video's true position in the playlist and
 * `item_index` its position in this run's queue, which are different numbers
 * for any selection with a gap in it.
 *
 * @param {Object} update - a progress event from PlaylistProgressTracker
 * @returns {Object} the fields to add to the download:progress payload
 */
function itemProgressFields(update) {
  return {
    item_progress: update.itemProgress,
    item_index: update.itemIndex,
    items_completed: update.itemsCompleted,
    items_total: update.totalItems,
    playlist_index: update.playlistIndex,
    video_id: update.videoId
  }
}

// the report payload wants the technical detail; stderr is already redacted
function buildFailureDetails(error) {
  if (!error) return undefined

  const tail =
    Array.isArray(error.stderrTail) && error.stderrTail.length
      ? error.stderrTail.join("\n")
      : ""

  // error.details is normally the last ERROR line, which the tail already holds
  const parts = []
  if (error.details && !tail.includes(error.details)) {
    parts.push(error.details)
  }
  if (tail) {
    parts.push(tail)
  }

  const joined = parts.join("\n\n").trim()
  return joined || undefined
}

function fileSizeOf(filePath) {
  if (!filePath) return 0

  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

module.exports = { DownloadRunner, STATUS }
