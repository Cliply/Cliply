/**
 * download history - the rows a downloads panel still has after a restart
 *
 * one json file under userData holding the last `limit` downloads, in the
 * snake_case spelling the download:progress payloads already use, because that
 * is what a row is: the wire payloads kept rather than a shape of our own.
 *
 * it is a record and never a queue. nothing here resumes anything, and a
 * history that cannot be written must not cost anyone a download - so every
 * entry point answers a promise that settles either way, and the rows in memory
 * stay correct even when the file behind them does not.
 */

const crypto = require("crypto")
const fsp = require("fs").promises
const path = require("path")

const { describeError } = require("../utils/analytics-helpers")

// a hundred rows is the whole file: enough that a user scrolling back finds
// what they are looking for, small enough that the read at startup and the
// rewrite on every status change stay a few tens of kilobytes
const HISTORY_LIMIT = 100

/**
 * the statuses a row can still move on from
 *
 * `starting` is the renderer's own word for the gap between its click and
 * main's first event. main never sends it, but a row that reached the file
 * wearing it is just as unfinished as the other two, so it is listed here.
 */
const LIVE_STATUSES = new Set(["queued", "starting", "downloading"])

// what a download that never got to finish becomes. derived, never sent: no
// part of the app reports this status, it is only ever written here
const INTERRUPTED = "interrupted"

class DownloadHistory {
  /**
   * @param {Object} options - {filePath, limit}. a history with no filePath
   *   keeps its rows for the session and writes nothing, which is what a build
   *   that cannot say where userData is gets instead of no history at all
   */
  constructor({ filePath = null, limit = HISTORY_LIMIT } = {}) {
    this.filePath = filePath
    this.limit = limit
    this.rows = []

    /**
     * every read-modify-write in one chain
     *
     * a settle and a reserve landing in the same tick would otherwise both read
     * `rows`, both write, and the second rename would drop whatever the first
     * one did. the chain also puts load() ahead of everything called after it,
     * so the first upsert of a session cannot be overwritten by the file it
     * raced.
     */
    this.chain = Promise.resolve()

    /**
     * what the file read must not undo
     *
     * the rows change in memory synchronously now, so a clear or a removal can
     * land while the one read of the file is still in flight. These say what to
     * do with the rows it brings back; both are only consulted by that read.
     */
    this.clearedEarly = false
    this.removed = new Set()

    // whether the one read of the file has landed. until it has, a clear or a
    // removal that finds nothing here still has a write to make: what it is
    // dropping may be in the file
    this.loaded = true

    /**
     * the file having been read, for callers that answer with `rows`
     *
     * `list()` is synchronous and the chain is not, so a reader arriving in the
     * window between construction and the read landing would be told this
     * install has no history at all - and the renderer hydrates once, with no
     * push channel to correct it afterwards. resolved until load() is called,
     * because until then there is nothing to wait for.
     */
    this.ready = this.chain
  }

  /**
   * read the file, once, before anything else touches the history
   *
   * a missing file is a first launch and a corrupt one is a file we own that
   * did not survive something - both start empty, and the next write repairs
   * it. what it does not do is refuse to start.
   *
   * rows that are still live belong to a run that is over. the quit path marks
   * those itself (see interruptLive), so finding one here means the app never
   * got to: a crash, a kill, a power cut.
   *
   * @returns {Promise<void>} settles when the file has been read and repaired
   */
  load() {
    this.loaded = false

    this.ready = this.enqueue(async () => {
      const stored = await this.readFile()

      // what this session has already written wins: the rows change in memory
      // the moment they are recorded (see upsert), so the file is the older
      // half of the truth by the time it arrives, and a clear or a removal that
      // landed in the window is applied to it here rather than undone
      let interrupted = false

      /**
       * a live row in the *file* belongs to a run that is over: the app went
       * away without marking it (a crash, a kill, a power cut). This session's
       * own live rows are in memory rather than in what was just read, and they
       * are genuinely running, so the marking is applied to the file's rows
       * alone.
       *
       * it happens before the clear below, not after: a row a crash left
       * `downloading` is a finished row by the time anyone can read it, and a
       * clear that arrived while this read was in flight removed it like any
       * other finished row.
       */
      const older = stored
        .filter((row) => row)
        .map((row) => {
          if (!LIVE_STATUSES.has(row.status)) return row

          interrupted = true
          return { ...row, status: INTERRUPTED }
        })

      const kept = this.survivors(older)

      this.rows = normalizeRows([...this.rows, ...kept], this.limit)
      this.loaded = true

      // a row of the file that did not survive is a row the file still holds:
      // the clear that dropped it had nothing in memory to write about, so this
      // is where that write happens
      if (interrupted || kept.length !== older.length) {
        await this.persist()
      }
    })

    return this.ready
  }

  /**
   * the rows of the file this session has not already answered for
   *
   * a clear removes every finished row, so a finished row read afterwards is
   * one it removed; a removal names an id. Both are kept for the length of the
   * load and no longer: from then on the rows in memory are the whole history.
   *
   * @param {Object[]} stored - whatever the file held
   * @returns {Object[]}
   */
  survivors(stored) {
    const known = new Set(this.rows.map((row) => row.download_id))

    return stored.filter((row) => {
      if (!row || known.has(row.download_id)) return false
      if (this.removed.has(row.download_id)) return false

      return this.clearedEarly ? LIVE_STATUSES.has(row.status) : true
    })
  }

  /**
   * record where one download stands
   *
   * fields present replace what the row held; fields absent leave it alone, so
   * a settle can carry its outcome without repeating the title and the request
   * that were written at reserve.
   *
   * **the rows change here, synchronously; only the file write is queued.** the
   * list main pushes to the renderer is built from these rows the moment a
   * download changes (see listSnapshot in ipc-handlers.js), so a row that
   * changed in memory a chain later would be announced in the state it had
   * before the change - which is the whole family of races the push model
   * exists to end.
   *
   * never rejects, and never throws: this is called from inside the runner's
   * try, where a throw would be caught as the download itself breaking.
   *
   * @param {Object} row - a partial row, keyed by download_id
   * @returns {Promise<void>} settles when the write has been attempted
   */
  upsert(row) {
    const downloadId = row && row.download_id

    if (!downloadId) {
      return Promise.resolve()
    }

    const index = this.rows.findIndex(
      (known) => known.download_id === downloadId
    )

    if (index === -1) {
      this.rows.push({ ...row })
    } else {
      /**
       * interrupted is the last word on a row.
       *
       * the quit path marks every live row interrupted and then cancels the
       * downloads, so each of them settles as `cancelled` a moment later -
       * and the user would reopen the app to rows they never cancelled. the
       * late write is dropped here rather than ordered around, because the
       * cancels arrive from four different call stacks and only this one
       * place sees all of them.
       */
      if (this.rows[index].status === INTERRUPTED) {
        return Promise.resolve()
      }

      this.rows[index] = { ...this.rows[index], ...row }
    }

    this.rows = normalizeRows(this.rows, this.limit)

    return this.enqueue(() => this.persist())
  }

  /**
   * mark everything still running as interrupted, before it can be cancelled
   *
   * the quit path awaits this: a download the user comes back to should say it
   * was interrupted, which is true, rather than cancelled, which would name the
   * user as the one who stopped it.
   *
   * the marking happens here and now, like every other change to these rows.
   * Queued behind the writes ahead of it, it lost a race it must not lose: a
   * frozen run cancels itself, its `cancelled` reaches the rows first, and the
   * interruption that arrives afterwards is refused by its own rule.
   *
   * @returns {Promise<void>} settles when the write has been attempted
   */
  interruptLive() {
    const changed = this.markLiveInterrupted()

    // the file read, if it is still in flight, marks its own live rows (see
    // load): they belong to a run that is over either way
    if (!changed && this.loaded) {
      return Promise.resolve()
    }

    return this.enqueue(() => this.persist())
  }

  /**
   * settle once every write asked for so far has reached the disk
   *
   * the entry points each hand back their own place in the chain, so this is
   * for a caller holding none of them and needing the file to be there anyway.
   * the runner's writes are the ones nobody awaits.
   *
   * @returns {Promise<void>}
   */
  flush() {
    return this.chain
  }

  /**
   * every row, once everything already written down has been applied
   *
   * a row's status changes inside the same chained work that writes the file
   * (see upsert), so a download that completed while an earlier write was still
   * in flight is a row that says `downloading` until the chain reaches it. for
   * most readers that is a few milliseconds of nothing; for the renderer's one
   * hydration read it is the whole session, because its snapshot is taken once
   * and no push channel corrects it - the completion event it would have
   * repaired the row with was emitted before it subscribed.
   *
   * so the read waits for the writes that were recorded before it. the chain is
   * fifo, which is what makes "before it" mean anything: whatever is queued
   * after this call was never part of the answer.
   *
   * @returns {Promise<Object[]>} copies, newest first
   */
  async snapshot() {
    await this.flush()

    return this.list()
  }

  /**
   * every row, newest first
   * @returns {Object[]} copies, so a caller cannot edit the history in place
   */
  list() {
    return this.rows.map((row) => ({ ...row }))
  }

  /**
   * forget one finished row
   *
   * a row that is still queued or running is left exactly where it is.
   * forgetting one does not stop the download: the reservation lives on in the
   * runner, and the row would come back at its next status write - as
   * `cancelled`, because the quit path can only mark rows it can still see. the
   * user would then find a download they never cancelled, wearing a row they
   * had asked to be rid of. stopping a queued download is what download:cancel
   * is for, and the row that leaves behind is removable like any other.
   *
   * @param {string} downloadId - the id the row is keyed by
   * @returns {Promise<void>} settles when the write has been attempted
   */
  remove(downloadId) {
    const target = this.rows.find((row) => row.download_id === downloadId)

    if (target && LIVE_STATUSES.has(target.status)) {
      return Promise.resolve()
    }

    this.rows = this.rows.filter((row) => row.download_id !== downloadId)
    // the file read, if it is still in flight, must not bring it back
    this.removed.add(downloadId)

    // nothing here to drop and the file already read: there is nothing to write
    if (!target && this.loaded) {
      return Promise.resolve()
    }

    return this.enqueue(() => this.persist())
  }

  /**
   * forget every finished row, and keep the ones that are not
   *
   * "clear finished" is the panel's own wording: a download still queued or
   * running has a process behind it and events still to come, so clearing it
   * would leave the panel holding a row nothing can ever complete.
   *
   * @returns {Promise<void>} settles when the write has been attempted
   */
  clear() {
    // recorded whether or not anything went: the file read may still be in
    // flight, and what it brings back was cleared by this too
    this.clearedEarly = true

    const next = this.rows.filter((row) => LIVE_STATUSES.has(row.status))
    const changed = next.length !== this.rows.length

    this.rows = next

    // nothing here to drop and the file already read: there is nothing to write
    if (!changed && this.loaded) {
      return Promise.resolve()
    }

    return this.enqueue(() => this.persist())
  }

  /**
   * put one unit of work on the chain
   *
   * the catch is what keeps the promise this hands back from rejecting, and it
   * is also what keeps the chain alive: a rejected `this.chain` would refuse
   * every write after it for the rest of the session.
   *
   * @param {Function} work - an async read-modify-write over `rows`
   * @returns {Promise<void>}
   */
  enqueue(work) {
    this.chain = this.chain.then(work).catch((error) => {
      // worth saying out loud and worth nothing more than that: the rows in
      // memory are still right, the panel still works, and this run just has a
      // history that will not survive a restart
      console.warn("download history could not be written:", describeError(error))
    })

    return this.chain
  }

  /**
   * whatever the file holds, or nothing
   * @returns {Promise<Object[]>}
   */
  async readFile() {
    if (!this.filePath) {
      return []
    }

    try {
      const raw = await fsp.readFile(this.filePath, "utf8")
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      // missing, unreadable or not json - all of them mean "no history yet"
      return []
    }
  }

  /**
   * rewrite every live row as interrupted
   *
   * `finished_at` is deliberately left alone. a row interrupted at load time
   * would otherwise be stamped with the launch that noticed, which is not when
   * the download stopped and would sort the list by the wrong thing.
   *
   * @returns {boolean} whether anything changed, so a caller can skip the write
   */
  markLiveInterrupted() {
    let changed = false

    this.rows = this.rows.map((row) => {
      if (!LIVE_STATUSES.has(row.status)) {
        return row
      }

      changed = true
      return { ...row, status: INTERRUPTED }
    })

    return changed
  }

  /**
   * write the rows out, whole or not at all
   *
   * the same scratch-file-then-rename the settings store uses (see
   * writeSettings in services/settings-store.js): a reader finds either the
   * previous history or this one, never a half-written file. as there, this
   * covers the process dying rather than the power going out - nothing is
   * fsynced, and a history is not worth the cost of that.
   *
   * @returns {Promise<void>}
   * @throws whatever the write or the rename failed with
   */
  async persist() {
    if (!this.filePath) {
      return
    }

    const dir = path.dirname(this.filePath)
    await fsp.mkdir(dir, { recursive: true })

    // beside the target so the rename stays on one filesystem, and uniquely
    // named so two processes cannot share a scratch file
    const temp = path.join(dir, `.history-${crypto.randomUUID()}.tmp`)

    try {
      await fsp.writeFile(temp, JSON.stringify(this.rows, null, 2), "utf8")
      await fsp.rename(temp, this.filePath)
    } catch (error) {
      // never leave scratch files behind, and never report the cleanup's
      // problem in place of the one that actually failed the write
      await fsp.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
}

/**
 * the rows worth keeping, newest first
 *
 * anything without an id is dropped rather than kept: a row nothing can be
 * keyed by cannot be updated, removed or retried, and a hand-edited or
 * truncated file is exactly where one comes from.
 *
 * ordering is by `started_at` because that is the order the user started them
 * in, which is the order the panel lists them in and the order the cap has to
 * drop from - a row that finished first is not the oldest one.
 *
 * the cap counts finished rows only, and every live row is kept whatever the
 * count says. a queued download evicted from the history is one the quit path
 * can no longer find to mark, so it would settle as `cancelled` and come back
 * as a download the user never stopped. the list can therefore be longer than
 * `limit`, by however many downloads are in flight - which is at most the
 * queue, and every one of them is on its way to being a finished row anyway.
 *
 * @param {Object[]} rows - whatever was read or written
 * @param {number} limit - how many finished rows to keep
 * @returns {Object[]}
 */
function normalizeRows(rows, limit) {
  let finished = 0

  return rows
    .filter((row) => row && typeof row.download_id === "string")
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
    .filter((row) => {
      if (LIVE_STATUSES.has(row.status)) {
        return true
      }

      finished += 1
      return finished <= limit
    })
}

module.exports = {
  DownloadHistory,
  HISTORY_LIMIT,
  LIVE_STATUSES,
  INTERRUPTED
}
