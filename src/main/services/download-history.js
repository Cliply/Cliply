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
    return this.enqueue(async () => {
      this.rows = normalizeRows(await this.readFile(), this.limit)

      if (this.markLiveInterrupted()) {
        await this.persist()
      }
    })
  }

  /**
   * record where one download stands
   *
   * fields present replace what the row held; fields absent leave it alone, so
   * a settle can carry its outcome without repeating the title and the request
   * that were written at reserve.
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

    return this.enqueue(async () => {
      const index = this.rows.findIndex((known) => known.download_id === downloadId)

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
          return
        }

        this.rows[index] = { ...this.rows[index], ...row }
      }

      this.rows = normalizeRows(this.rows, this.limit)
      await this.persist()
    })
  }

  /**
   * mark everything still running as interrupted, before it can be cancelled
   *
   * the quit path awaits this: a download the user comes back to should say it
   * was interrupted, which is true, rather than cancelled, which would name the
   * user as the one who stopped it.
   *
   * @returns {Promise<void>} settles when the write has been attempted
   */
  interruptLive() {
    return this.enqueue(async () => {
      if (this.markLiveInterrupted()) {
        await this.persist()
      }
    })
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
   * every row, newest first
   * @returns {Object[]} copies, so a caller cannot edit the history in place
   */
  list() {
    return this.rows.map((row) => ({ ...row }))
  }

  /**
   * forget one row
   * @param {string} downloadId - the id the row is keyed by
   * @returns {Promise<void>} settles when the write has been attempted
   */
  remove(downloadId) {
    return this.enqueue(async () => {
      const next = this.rows.filter((row) => row.download_id !== downloadId)

      if (next.length === this.rows.length) {
        return
      }

      this.rows = next
      await this.persist()
    })
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
    return this.enqueue(async () => {
      const next = this.rows.filter((row) => LIVE_STATUSES.has(row.status))

      if (next.length === this.rows.length) {
        return
      }

      this.rows = next
      await this.persist()
    })
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
 * @param {Object[]} rows - whatever was read or written
 * @param {number} limit - how many to keep
 * @returns {Object[]}
 */
function normalizeRows(rows, limit) {
  return rows
    .filter((row) => row && typeof row.download_id === "string")
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
    .slice(0, limit)
}

module.exports = {
  DownloadHistory,
  HISTORY_LIMIT,
  LIVE_STATUSES,
  INTERRUPTED
}
