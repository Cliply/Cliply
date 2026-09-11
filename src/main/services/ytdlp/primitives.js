/**
 * the small stateful pieces an operation is assembled from - the gate, the
 * stderr buffer, the two progress trackers, the line splitter - and the
 * buffer and timing constants they and the operation are measured in
 */

// how many stderr lines we keep for the report issue payload
const STDERR_BUFFER_LINES = 200

// kill a process that has printed nothing at all for this long
const DEFAULT_WATCHDOG_MS = 2 * 60 * 1000

// ...except while postprocessing, where silence is the expected shape rather
// than a symptom. yt-dlp pipes a postprocessor's ffmpeg output instead of
// letting it through, so a merge, a remux or an mp3 conversion prints nothing
// from the moment it starts until the file lands - minutes, on a long video.
// the download that reaches this phase has already fetched every byte, so the
// only thing DEFAULT_WATCHDOG_MS achieves here is killing a job that is working
const POSTPROCESS_WATCHDOG_MS = 30 * 60 * 1000

// ffmpeg's periodic status line, which it rewrites over a carriage return.
// these are load-bearing for the watchdog and worthless in an issue report:
// one trim can print thousands of them, and a 200-line buffer full of them
// would be a report with the actual failure scrolled out of it
const FFMPEG_PROGRESS_PATTERN = /^(?:frame|size|Lsize)=/

// how long a cancelled process gets to exit before it is killed outright
const KILL_GRACE_MS = 5000

// app quit: the ceiling on waiting for cancelled operations to actually exit.
// longer than KILL_GRACE_MS so the sigkill escalation always gets to fire
// before this gives up, plus slack for taskkill itself to run on windows
const SHUTDOWN_WAIT_MS = KILL_GRACE_MS + 2000

// a warm onedir answers --version in well under a second, but the very first
// run after an install is scanned by the os and can take the best part of a
// minute - so this ceiling only ever catches a genuinely wedged process
const PROBE_TIMEOUT_MS = 2 * 60 * 1000

/**
 * the one gate both downloads and self-updates go through
 *
 * downloads take a shared read lock and wait when an update is mid-flight;
 * `-U` and seeding take an exclusive write lock and *refuse* rather than queue,
 * because an update must never sit behind a two-hour download. both paths
 * change state synchronously inside the acquire call, so there is no window
 * between checking and holding.
 */
class OperationGate {
  constructor() {
    this.readers = 0
    this.writing = false
    this.waitingReaders = []
  }

  /**
   * take a shared lock, waiting for any in-flight write to finish
   * @returns {Promise<Function>} resolves with the release function
   */
  acquireRead() {
    if (!this.writing) {
      this.readers += 1
      return Promise.resolve(this.makeReadRelease())
    }

    return new Promise((resolve) => {
      this.waitingReaders.push(() => {
        this.readers += 1
        resolve(this.makeReadRelease())
      })
    })
  }

  /**
   * take the exclusive lock if nothing else holds the gate
   * @returns {Function|null} release function, or null when busy
   */
  tryAcquireWrite() {
    if (this.writing || this.readers > 0) {
      return null
    }

    this.writing = true

    let released = false
    return () => {
      if (released) return
      released = true
      this.writing = false
      this.drainWaitingReaders()
    }
  }

  makeReadRelease() {
    let released = false
    return () => {
      if (released) return
      released = true
      this.readers = Math.max(0, this.readers - 1)
    }
  }

  drainWaitingReaders() {
    const waiting = this.waitingReaders
    this.waitingReaders = []
    for (const grant of waiting) {
      grant()
    }
  }

  isBusy() {
    return this.writing || this.readers > 0
  }
}

// bounded line buffer for stderr
class RingBuffer {
  constructor(limit = STDERR_BUFFER_LINES) {
    this.limit = limit
    this.lines = []
  }

  push(line) {
    if (!line) return
    this.lines.push(line)
    if (this.lines.length > this.limit) {
      this.lines.splice(0, this.lines.length - this.limit)
    }
  }

  tail(count = this.limit) {
    return this.lines.slice(-count)
  }

  toString(count = this.limit) {
    return this.tail(count).join("\n")
  }
}

// turns per-stream percentages into a single monotonic bar
class ProgressTracker {
  constructor(expectedStreams = 1) {
    this.expectedStreams = Math.max(1, expectedStreams)
    this.streamIndex = 0
    this.lastStreamProgress = 0
    this.lastOverall = 0
  }

  // called when the before_dl marker reveals the real format, which is more
  // reliable than guessing from the selector
  setExpectedStreams(count) {
    if (!Number.isFinite(count) || count < 1) return
    this.expectedStreams = Math.max(count, this.streamIndex + 1)
  }

  update(parsed) {
    const streamProgress = parsed.progress

    // a percentage that jumps backwards means yt-dlp moved on to the next stream
    if (streamProgress + 1 < this.lastStreamProgress) {
      this.streamIndex += 1
    }
    this.lastStreamProgress = streamProgress

    const streams = Math.max(this.expectedStreams, this.streamIndex + 1)
    const overall = ((this.streamIndex + streamProgress / 100) / streams) * 100

    this.lastOverall = Math.min(100, Math.max(this.lastOverall, overall))

    return {
      progress: Math.round(this.lastOverall * 10) / 10,
      streamProgress,
      streamIndex: this.streamIndex,
      speed: parsed.speed,
      eta: parsed.eta,
      etaSeconds: parsed.etaSeconds
    }
  }
}

/**
 * the same bar, one level up: a run of items, each of which is its own download
 *
 * one ProgressTracker per item, thrown away and rebuilt at every before_dl
 * marker. that reset is the point of the class - an item's sweep counter is
 * only meaningful inside that item, and carrying it across would open item 2
 * at 50% because item 1 finished two streams.
 *
 * the run's own bar is `(itemsCompleted + itemProgress / 100) / totalItems`,
 * so it advances smoothly through an item instead of jumping only when one
 * lands.
 */
class PlaylistProgressTracker {
  constructor({ expectedStreams = 1, totalItems = null } = {}) {
    this.expectedStreamsPerItem = Math.max(1, expectedStreams)
    this.totalItems = totalItems && totalItems > 0 ? totalItems : null

    this.item = new ProgressTracker(this.expectedStreamsPerItem)
    this.itemIndex = 1
    this.playlistIndex = null
    this.videoId = null
    this.itemsCompleted = 0
    // whether the item in flight has already been counted whole. its own
    // percentage stops being added on top of itemsCompleted the moment it has,
    // or an item landing would count twice
    this.itemSettled = false
    this.lastOverall = 0
  }

  // the two the operation reads off a tracker without caring which kind it is
  get streamIndex() {
    return this.item.streamIndex
  }

  get expectedStreams() {
    return this.item.expectedStreams
  }

  /**
   * a new item is starting - reset everything that is per-item
   * @param {Object} marker - {itemIndex, playlistIndex, videoId, streams}
   */
  startItem(marker = {}) {
    if (marker.itemIndex) {
      // an autonumber past the end of the selection is not a position in this
      // run. it only ever moves the bar, but there is no reason to let it
      this.itemIndex = this.totalItems
        ? Math.min(marker.itemIndex, this.totalItems)
        : marker.itemIndex
    }

    // the item before this one is done with, however it ended. an item that
    // failed extraction prints no progress and no after_move at all, so
    // counting only the files that landed would freeze the bar for the rest of
    // a run the moment one video turned out to be private
    this.itemsCompleted = Math.max(this.itemsCompleted, this.itemIndex - 1)

    if (marker.playlistIndex !== undefined) {
      this.playlistIndex = marker.playlistIndex
    }
    if (marker.videoId !== undefined) {
      this.videoId = marker.videoId
    }

    this.item = new ProgressTracker(this.expectedStreamsPerItem)
    this.itemSettled = false

    if (marker.streams) {
      this.item.setExpectedStreams(marker.streams)
    }
  }

  /**
   * an item landed on disk
   * @param {number|null} itemIndex - its autonumber, when the print carried one
   */
  completeItem(itemIndex = null) {
    const completed = Number.isInteger(itemIndex) ? itemIndex : this.itemsCompleted + 1

    this.itemsCompleted = Math.max(this.itemsCompleted, completed)

    // the item in flight is now counted whole, so stop adding its own
    // percentage on top: item 1 of 2 landing would otherwise read
    // (1 + 1) / 2 - a full bar with half the playlist still to download, and
    // the monotonic clamp would pin it there for the rest of the run
    if (!Number.isInteger(itemIndex) || itemIndex >= this.itemIndex) {
      this.itemSettled = true
    }
  }

  update(parsed) {
    // the denominator is never taken off the wire - it is the selection, set
    // once at construction. see PLAYLIST_PROGRESS_TEMPLATE

    // a marker we never saw - the item still has to start, or its progress
    // would be folded into the previous one's
    if (parsed.itemIndex && parsed.itemIndex > this.itemIndex) {
      this.startItem({ itemIndex: parsed.itemIndex })
    }

    return this.snapshot(this.item.update(parsed))
  }

  /**
   * the current reading, with or without a fresh progress line behind it
   * @param {Object|null} itemUpdate - what the item's own tracker just returned
   * @returns {Object} the progress event
   */
  snapshot(itemUpdate = null) {
    const item = itemUpdate || {
      progress: this.item.lastOverall,
      streamProgress: this.item.lastStreamProgress,
      streamIndex: this.item.streamIndex,
      speed: null,
      eta: null,
      etaSeconds: null
    }

    // the selection, set once at construction. a caller that sent none leaves
    // the item in flight as the only lower bound on the run's length
    const totalItems = this.totalItems || Math.max(this.itemIndex, 1)
    const inFlight = this.itemSettled ? 0 : item.progress / 100
    const overall = ((this.itemsCompleted + inFlight) / totalItems) * 100

    this.lastOverall = Math.min(100, Math.max(this.lastOverall, overall))
    const rounded = Math.round(this.lastOverall * 10) / 10

    return {
      // the single 0-100 bar every consumer of a progress event already reads
      progress: rounded,
      overallProgress: rounded,
      itemProgress: item.progress,
      itemsCompleted: this.itemsCompleted,
      totalItems,
      itemIndex: this.itemIndex,
      playlistIndex: this.playlistIndex,
      videoId: this.videoId,
      streamProgress: item.streamProgress,
      streamIndex: item.streamIndex,
      speed: item.speed,
      eta: item.eta,
      etaSeconds: item.etaSeconds
    }
  }

  /**
   * the reading a finished run ends on
   *
   * every item is resolved by now, saved or skipped, so the bar is full. how
   * many of them actually landed is the outcome's business, not the bar's
   *
   * @returns {Object} the final progress event
   */
  finalSnapshot() {
    const totalItems = this.totalItems || Math.max(this.itemIndex, this.itemsCompleted, 1)

    this.itemsCompleted = totalItems
    this.lastOverall = 100

    return {
      progress: 100,
      overallProgress: 100,
      itemProgress: 100,
      itemsCompleted: totalItems,
      totalItems,
      itemIndex: this.itemIndex,
      playlistIndex: this.playlistIndex,
      videoId: this.videoId,
      streamProgress: 100,
      streamIndex: this.item.streamIndex,
      speed: null,
      eta: null,
      etaSeconds: 0
    }
  }
}

// splits a stream into lines, holding back partial ones
class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine
    this.buffer = ""
  }

  push(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r\n|\r|\n/)
    this.buffer = lines.pop()
    for (const line of lines) {
      this.onLine(line)
    }
  }

  flush() {
    if (this.buffer) {
      const line = this.buffer
      this.buffer = ""
      this.onLine(line)
    }
  }
}

module.exports = {
  OperationGate,
  RingBuffer,
  ProgressTracker,
  PlaylistProgressTracker,
  LineSplitter,
  STDERR_BUFFER_LINES,
  DEFAULT_WATCHDOG_MS,
  POSTPROCESS_WATCHDOG_MS,
  FFMPEG_PROGRESS_PATTERN,
  KILL_GRACE_MS,
  SHUTDOWN_WAIT_MS,
  PROBE_TIMEOUT_MS
}
