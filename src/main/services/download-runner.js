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
const { isSimplePlatform } = require("../utils/ytdlp-formats")
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
   *   logAudit, history, maxConcurrent}
   */
  constructor({
    engine,
    updater,
    sendEvent,
    trackEvent = () => {},
    logAudit = () => {},
    history = null,
    maxConcurrent = APP_CONFIG.MAX_CONCURRENT_DOWNLOADS
  }) {
    this.engine = engine
    this.updater = updater
    this.sendEvent = sendEvent
    this.trackEvent = trackEvent
    this.logAudit = logAudit
    // where a download is written down so it is still there after a restart.
    // optional: every runner behaviour is the same without one, and a build or
    // a test that constructs no history simply keeps no record
    this.history = history

    // downloadId -> {handle, type, title, platform, started, request, label}
    this.active = new Map()

    /**
     * the slot semaphore
     *
     * `running` counts downloads that hold a slot, which is not the same as
     * `active.size`: a reservation exists from the moment the ipc layer claims
     * the id, and a queued one is very much active without running. `waiting`
     * holds one `{downloadId, resolve, sequence}` per parked run, earliest
     * reservation first, which is what makes the queue FIFO.
     *
     * `reservations` is that order: a counter bumped once per reserve(). the
     * wall clock in `entry.started` cannot do this job, because two downloads
     * accepted one setImmediate apart land in the same millisecond and would
     * tie - which is exactly the pair whose order is in question.
     */
    this.maxConcurrent = maxConcurrent
    this.running = 0
    this.waiting = []
    this.reservations = 0

    // whether the queue has been closed for good. see freeze(), which the quit
    // path calls before anything is cancelled
    this.frozen = false
  }

  /**
   * stop handing out slots, without settling anything
   *
   * the quit path is the caller, and the order it needs is the reason this
   * exists at all: the history has to mark the live rows *before* they are
   * cancelled (see markDownloadsInterrupted in index.js), and that marking is a
   * file write with awaits in it. a cancel that was already in flight when the
   * quit began settles during exactly that window, releaseSlot hands its slot
   * to the first waiter, and a fresh yt-dlp process spawns while the app is
   * closing - one the engine's shutdown wait has already taken its snapshot
   * without, and which nothing then waits for.
   *
   * so this is cancelAll's half that can run first: it settles nothing, writes
   * nothing and changes no row's status, so the marking still finds every live
   * row exactly as it was. from here a released slot goes nowhere, a run that
   * reaches the queue is refused one, and run() settles it as cancelled rather
   * than spawning without one.
   *
   * there is no way back. a frozen runner belongs to a process that is going.
   */
  freeze() {
    this.frozen = true
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

    const entry = {
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
      // where this download stands in the queue, decided here rather than
      // wherever run() happens to reach the semaphore: the two orders are not
      // the same one. see acquireSlot
      sequence: (this.reservations += 1),
      // every reservation begins queued, whether or not it ever waits: run()
      // moves it on where it takes a handle, so there is one place the status
      // changes rather than one per caller
      status: STATUS.QUEUED,
      handle: null,
      cancelled: false,
      // whether the renderer has been shown a queued row for this run that
      // nothing else will correct. raised by park() and spent by the
      // announcement in run(), which owes it exactly once
      owesSlotNotice: false,
      // how far the engine got, kept for the two terminal states that report
      // it. a cancel arrives from another call stack entirely, so there is
      // nowhere else it could be read from by then
      progress: 0
    }

    this.active.set(downloadId, entry)

    // the row exists from the moment the download is accepted, not from the
    // moment it starts: a download that waits behind the cap and is then
    // interrupted by a quit never runs at all, and it is still something the
    // user asked for and should find waiting for them
    this.record(downloadId, entry, { status: STATUS.QUEUED })

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
      // slot, and the flag is what it wakes up to read. a freeze is the quit's
      // version of the same answer, for a run that had not reached the queue
      // yet when it landed: no slot, and nothing may spawn without one
      const parked = this.active.get(downloadId)

      if (!parked || parked.cancelled || this.frozen) {
        return this.settleCancelled(downloadId)
      }

      // at most two passes: the second only happens when an update actually
      // changed the binary version (repair-on-failure)
      for (let attempt = 0; attempt < 2; attempt++) {
        let handle

        /**
         * asked again on every pass, not only before the first one.
         *
         * the repair attempt is the case: a run whose first attempt broke waits
         * in `updater.updateNow()`, which can be the length of a download of its
         * own, and a quit landing in that window finds this run holding a slot
         * with no handle. the check above has already been and gone, so without
         * this the update resolving mid-quit starts a second yt-dlp process
         * while the app is closing.
         */
        if (this.frozen) {
          return this.settleCancelled(downloadId)
        }

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
        // the second of the three writes a download costs: it has a slot and a
        // process now. progress does not write - a percentage is not worth a
        // file rewrite, and the panel is watching the events for that anyway
        this.record(downloadId, entry, { status: STATUS.DOWNLOADING })

        /**
         * ...and the row that was drawn as queued hears that it is not any more
         *
         * nothing else says so until the engine's first progress line, and a
         * trimmed download is one ffmpeg pass that reports nothing until the
         * end: the panel would read "Queued" with a Remove beside it for the
         * whole of a download that holds a slot and is writing its file. an
         * ordinary extraction delay is the same thing, briefer.
         *
         * only for a run that actually waited. one that never parked was never
         * drawn as queued - the renderer's own `starting` row is what is on
         * screen, and it already draws an indeterminate bar.
         *
         * indeterminate because there is no percentage yet and a made-up 0%
         * would sit there looking stalled. the first real progress event
         * replaces the flag rather than merging with it, so nothing has to
         * clear it afterwards.
         *
         * said once and then spent: there is one transition out of the queue,
         * and the repair pass is not another one. it holds the same slot it was
         * given here (see the update branch below), so repeating this would
         * throw away whatever progress the first attempt had drawn and put the
         * row back on an indeterminate bar it has already left.
         */
        if (entry.owesSlotNotice) {
          entry.owesSlotNotice = false

          this.sendEvent(downloadId, {
            status: STATUS.DOWNLOADING,
            progress: 0,
            indeterminate: true
          })
        }

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
   *   cancel woke this waiter rather than a slot coming free, or that the
   *   queue is frozen and there are no more slots to be had
   */
  async acquireSlot(downloadId) {
    // refused rather than parked: a waiter added after the queue froze is one
    // nothing will ever wake, and run() answers a refusal by settling the
    // download as cancelled - which is what a quit does to it anyway
    if (this.frozen) {
      return false
    }

    if (this.running < this.maxConcurrent) {
      this.running += 1
      return true
    }

    this.sendEvent(downloadId, { status: STATUS.QUEUED, progress: 0 })

    return new Promise((resolve) => {
      this.park(downloadId, resolve)
    })
  }

  /**
   * put a run in the queue, in the order its download was accepted
   *
   * the queue the user is owed is the order their downloads were accepted,
   * which is the order reserve() ran, so the waiter is inserted by its
   * reservation's sequence rather than appended.
   *
   * every ipc handler now starts its download through startDownload, which
   * defers run() by the same setImmediate and is called with nothing awaited
   * between it and reserve(), so the two orders currently agree. they have not
   * always: the simple-platform path used to await run() inline, and a tiktok
   * link pasted after a youtube one would park ahead of it. the sequence is
   * kept because "accepted first, run first" is the promise, and a caller that
   * reaches run() by some other route should not be able to break it.
   *
   * scanning from the back and stopping at the first sequence below this one
   * keeps equal values in insertion order. sequences are unique, so that is a
   * property of the walk rather than something being relied on.
   *
   * one case this does not cover, on purpose: a download reserved earlier whose
   * run() has not been called yet cannot be waited for, so a slot going free in
   * that window is taken by whoever is already parked. it is one setImmediate
   * wide.
   *
   * @param {string} downloadId - the id handed to the renderer
   * @param {Function} resolve - settles the promise acquireSlot is awaiting
   */
  park(downloadId, resolve) {
    const entry = this.active.get(downloadId)
    // a run always has its reservation by here, so the fallback only keeps an
    // impossible state from sorting to the front of everyone else's queue
    const sequence = entry ? entry.sequence : this.reservations

    // this row is about to be drawn as queued, which is the debt run() settles
    // when the slot arrives
    if (entry) {
      entry.owesSlotNotice = true
    }

    let index = this.waiting.length

    while (index > 0 && this.waiting[index - 1].sequence > sequence) {
      index -= 1
    }

    this.waiting.splice(index, 0, { downloadId, resolve, sequence })
  }

  /**
   * give up a slot, and start whatever was waiting for it
   *
   * the front of `waiting` is the earliest reservation still parked, which
   * park() is what maintains. the slot is handed straight to it rather than
   * freed and re-taken: between a decrement and that waiter's continuation
   * actually running there is a turn of the event loop in which a fresh run()
   * would find room and jump the whole queue.
   */
  releaseSlot() {
    // ...unless the queue is frozen, in which case the slot goes nowhere: the
    // cancel that freed it is part of a quit, and handing it on would start a
    // download the app is in the middle of closing down. the waiters are woken
    // by the cancelAll that follows the freeze, with no slot and nothing spawned
    const next = this.frozen ? null : this.waiting.shift()

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

  /**
   * write down where this download stands
   *
   * three points in a download's life and no more: it was accepted, it took a
   * slot, it settled. that is the whole write budget, and it is what keeps a
   * hundred progress lines a second from turning into a hundred file rewrites.
   *
   * guarded the way track() is, and for the same reason: the history's own
   * writes never throw, but the collaborator is injected and every one of these
   * calls sits somewhere a throw would be read as the download itself failing.
   *
   * @param {string} downloadId - the id handed to the renderer
   * @param {Object|null} entry - the reservation, when there still is one
   * @param {Object} fields - the status and whatever this moment knows
   */
  record(downloadId, entry, fields) {
    if (!this.history) return

    try {
      this.history.upsert({
        download_id: downloadId,
        ...(entry ? reservationRow(entry) : null),
        ...fields
      })
    } catch (error) {
      console.warn(`failed to record ${downloadId}:`, describeError(error))
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

    /**
     * the file and its size only when there is one, exactly as the event does.
     *
     * a playlist's `filePath` is whichever video landed last, so on a playlist
     * row these two describe that one file rather than the run. they are kept
     * anyway - the folder they name is the right folder to open - and what a
     * playlist row actually reads is the counts beside them
     */
    this.record(downloadId, entry, {
      status: STATUS.COMPLETED,
      finished_at: Date.now(),
      ...(filePath ? { filename, file_path: filePath, file_size: fileSize } : null),
      ...historyCounts(tally)
    })

    this.sendEvent(downloadId, {
      status: STATUS.COMPLETED,
      progress: 100,
      filename,
      /**
       * where the file went and how big it is, in the spelling the result has
       * always used them under.
       *
       * the reservation is gone by the time this event lands, so a consumer
       * that missed them here cannot ask for them afterwards: a status lookup
       * has nothing left to read. the ipc reply used to carry both for the
       * simple platforms and no longer does, and a downloads panel wants a size
       * on a finished row.
       *
       * only when there is a path to report. `fileSizeOf` answers 0 for a stat
       * that failed as much as for one that never happened, and an event
       * claiming a zero-byte file is worse than one that says nothing - so a
       * completion the engine named no file for keeps exactly the shape it had.
       *
       * a playlist's `filePath` is whichever video landed last (see the result
       * YtdlpOperation assembles), so these two describe that one file and not
       * the run. `files` and the item counts beside them are what a playlist
       * row is built from; analytics omits its own size for the same reason.
       */
      ...(filePath ? { file_path: filePath, file_size: fileSize } : null),
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

    // dropped by the history when the quit path has already called this row
    // interrupted, which is what keeps a quit from reading back as a user who
    // cancelled everything on their way out
    this.record(downloadId, entry, {
      status: STATUS.CANCELLED,
      finished_at: Date.now(),
      // a cancelled playlist keeps the videos it had already finished, and the
      // row is the only place the user will see how many those were
      ...historyCounts(tally)
    })

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

    // the same two fields the failed event carries, so a row rebuilt from the
    // history after a restart says what a row built from the event says
    this.record(downloadId, entry, {
      status: STATUS.FAILED,
      finished_at: Date.now(),
      error: message,
      category: (error && error.code) || "DOWNLOAD_FAILED",
      // a stalled playlist rejects with the files it did save attached, and
      // "three of twelve saved" is the difference between a row worth retrying
      // and a row that reads as a total loss
      ...historyCounts(tally)
    })

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
 * the half of a history row that comes from the reservation
 *
 * written at every one of the three points rather than only at the first: the
 * history merges, so repeating them costs nothing, and it means a row created
 * by a settle - a history file that lost the reserve write, a download that
 * reached run() by some other route - is still a row that can be drawn and
 * retried rather than a status with nothing around it.
 *
 * @param {Object} entry - the reservation
 * @returns {Object} the row fields the reservation knows
 */
function reservationRow(entry) {
  return {
    kind: historyKind(entry),
    platform: entry.platform,
    title: entry.title,
    label: entry.label,
    // when the user asked, not when it started. a row that waited behind the
    // cap belongs where they put it in the list, and the cap drops the oldest
    // by this too
    started_at: entry.started,
    request: entry.request,
    ...reservedItemsTotal(entry)
  }
}

/**
 * how many videos a playlist row is waiting on, before anything has run
 *
 * the same number the acknowledgement answers with, read from the selection
 * the request carries. without it a playlist row that was queued or
 * interrupted has no denominator at all: the engine never got far enough to
 * count, and "12 videos" is the one thing the user already knows about it.
 *
 * a settle overwrites this with what the run really found (see historyCounts),
 * which is the same key because it is the same fact, better known.
 *
 * @param {Object} entry - the reservation
 * @returns {Object|null} {items_total}, or null for anything but a playlist
 */
function reservedItemsTotal(entry) {
  if (!entry.playlist) return null

  const entries = entry.request && entry.request.entries

  return Array.isArray(entries) ? { items_total: entries.length } : null
}

/**
 * what a playlist run actually did, for the row rather than for the event
 *
 * four counts and not the fifth: `files` is a list of paths that grows with the
 * playlist, and a hundred rows each holding one would be a history file
 * measured in megabytes. the row says how many landed, and the folder is one
 * click away.
 *
 * a count that is not a number is left out rather than written as undefined,
 * because a merge would otherwise blank the `items_total` the reservation put
 * there - a run refused before it could count would erase the only number the
 * row had.
 *
 * @param {Object|null} tally - what itemTally read off the result or rejection
 * @returns {Object|null} the counts, or null when this was not a playlist
 */
function historyCounts(tally) {
  if (!tally) return null

  const counts = {}

  for (const key of [
    "items_saved",
    "items_reused",
    "items_skipped",
    "items_total"
  ]) {
    if (Number.isFinite(tally[key])) {
      counts[key] = tally[key]
    }
  }

  return counts
}

/**
 * which of the four rows a downloads panel draws this is
 *
 * `type` is what the download fetches - "combined" or "audio" - and it is not
 * this question: a playlist of audio fetches audio and is still a playlist row,
 * one that counts videos and whose stored request only the playlist channel can
 * re-send. so the playlist check comes first; deciding by `type` would send a
 * retry to the audio channel carrying a list of entries it knows nothing about.
 *
 * @param {Object} entry - the reservation
 * @returns {string} playlist | audio | simple | video
 */
function historyKind(entry) {
  if (entry.playlist) return "playlist"
  if (entry.type === "audio") return "audio"
  // tiktok and pinterest offer no choice of quality or container, which is the
  // same thing that makes their row a different one to draw
  if (isSimplePlatform(entry.platform)) return "simple"

  return "video"
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
