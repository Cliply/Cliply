// ipc handlers

const { ipcMain, dialog, app } = require("electron")
const os = require("os")
const fs = require("fs")
const path = require("path")
const { IPC_CHANNELS } = require("./utils/constants")
const {
  describeError,
  extractQuality,
  audioFormat,
  elapsedBucket,
  speedBucket
} = require("./utils/analytics-helpers")
const {
  ERROR_CATEGORIES,
  ERROR_STAGES,
  classify
} = require("./utils/error-taxonomy")
const {
  mapVideoInfo,
  mapSimpleInfo,
  mapPlaylistInfo,
  hasPlayableVideo,
  buildVideoOutputTemplate,
  buildAudioOutputTemplate,
  buildSimpleOutputTemplate,
  buildPlaylistOutputTemplate,
  buildPlaylistArchivePath
} = require("./utils/ytdlp-mappers")
const { getSimplePlatformOptions } = require("./utils/ytdlp-formats")
const { resolveDownloadId } = require("./utils/download-id")

const { DownloadRunner } = require("./services/download-runner")
const { DownloadHistory } = require("./services/download-history")
const { SettingsStore } = require("./services/settings-store")
const {
  ERROR_CODES,
  PLAYLIST_CONTAINER,
  RECORDS_UNWRITABLE,
  normalizeQualityTier
} = require("./services/ytdlp-engine")

const {
  SUPPORTED_DOWNLOAD_PLATFORMS,
  normalizeTimeRange,
  isPlaylistPlatform,
  isYouTubeRequestUrl,
  normalizePlaylistEntries,
  normalizePlaylistHeight,
  normalizePlaylistAudioMode
} = require("./ipc/validators")
const {
  COOKIE_TEST_URLS,
  JAR_PROBLEMS,
  cookieJarProblemCode,
  cookieJarProblem
} = require("./ipc/cookie-problems")
const {
  RENDERER_EVENTS,
  SUPPORT_MILESTONES,
  MEDIA_TYPES,
  playlistProperties,
  shortErrorMessage
} = require("./ipc/analytics-translation")

/**
 * the request a download row would be retried from
 *
 * kept in the renderer's own snake_case spelling, because it is the wire
 * payload rather than a shape of ours: a retry hands it straight back to the
 * same channel and it is validated again on the way in. fields that were never
 * sent are dropped rather than carried as undefined, so a re-send is the same
 * request the user made and not a wider one.
 *
 * @param {Object} fields - the validated payload fields, snake_case
 * @returns {Object} the same, minus anything absent
 */
function retryRequest(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  )
}

/**
 * one of the runner's reservations, in the spelling the history uses
 *
 * the two halves of the list have to be one shape, and the history row is the
 * one that survives a restart, so the reservation is written the way it will be
 * written to disk a moment later anyway (see reservationRow in
 * services/download-runner.js).
 *
 * @param {Object} status - one row of runner.list()
 * @returns {Object} the same download as a history row
 */
function listRow(status) {
  return {
    download_id: status.downloadId,
    kind: status.playlist
      ? "playlist"
      : status.type === "audio"
        ? "audio"
        : status.platform === "tiktok" || status.platform === "pinterest"
          ? "simple"
          : "video",
    platform: status.platform,
    title: status.title,
    label: status.label,
    status: status.status,
    started_at: status.startTime,
    filename: status.filename,
    error: status.error,
    request: status.request
  }
}

/**
 * a whole, non-negative count, or none
 *
 * `settings.json` is a file on the user's disk and the panel draws whatever is
 * in it: `Number(value) || 0` let through -5 for a hand-edited negative, 1.5
 * for a fraction, and `Infinity` for the perfectly valid json string
 * "Infinity". None of those is a number of downloads.
 *
 * @param {unknown} value - whatever `downloads_completed` held
 * @returns {number} the count, floored, or 0 for anything that is not one
 */
function normalizeCount(value) {
  const count = Number(value)

  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

/**
 * whether anything between the download folder and this file is a symlink
 *
 * the lexical check in `handleShowInFolder` compares strings, and a string can
 * be inside a folder while the file it names is not: a link at
 * `<downloads>/elsewhere` pointing anywhere on disk makes every path under it
 * pass. So each component below the root is `lstat`ed on the way down, and a
 * link at any of them refuses the whole path.
 *
 * the root itself is not walked. A user whose download folder is a link chose
 * that folder, and refusing it would break the app for them.
 *
 * a component that is not there at all is not an escape: the existence check
 * on the target is what answers that, and it answers it as "gone" rather than
 * as "refused".
 *
 * @param {string} root - the resolved download folder
 * @param {string} inside - the target, relative to it
 * @returns {Promise<boolean>} whether the walk found a link
 */
async function pathEscapes(root, inside) {
  let walked = root

  for (const segment of inside.split(path.sep)) {
    walked = path.join(walked, segment)

    try {
      if ((await fs.promises.lstat(walked)).isSymbolicLink()) return true
    } catch {
      return false
    }
  }

  return false
}

class IPCHandlers {
  constructor(services, autoUpdater = null) {
    this.cookieManager = services.cookieManager
    // every download flow runs on the binary engine
    this.engine = services.ytdlpEngine
    this.updater = services.ytdlpUpdater
    // the one exit point telemetry leaves through. absent in a build that
    // never constructed one, and nothing here may depend on it existing
    this.analytics = services.analytics || null
    this.autoUpdater = autoUpdater
    this.mainWindow = null

    // audit logging
    this.auditLog = []

    // the last playlist listed, so a download can be held to what its own
    // listing said was downloadable - see rememberPlaylistListing
    this.lastPlaylistListing = null

    // one source of truth for the download folder, shared with the settings ipc
    this.settings = services.settingsStore || new SettingsStore()

    // fetches the PO token payload the first time an install is refused.
    // absent in a build that never constructed one, and a refusal still
    // escalates without it - there is just nothing yet to escalate with
    this.potInstaller = services.potInstaller || null

    /**
     * what the downloads panel still knows after a restart
     *
     * `<userData>/downloads/history.json`, beside the playlist archives and
     * resolved through the engine the same way they are. read once here, so
     * the rows are in memory before the renderer can ask for them and before
     * the first reservation can add to them.
     *
     * an engine that cannot say where userData is (a stub, a build without one)
     * leaves the history with no file rather than leaving the app with no
     * history: the panel works for the session, and no download fails for want
     * of somewhere to write it down.
     */
    this.history =
      services.downloadHistory ||
      new DownloadHistory({ filePath: this.historyFilePath() })

    this.history.load()



    /**
     * how many downloads this install has ever finished
     *
     * one number, owned here: `noteCompletedDownload` increments it, the
     * completed event carries it and settings:get-download-count answers with
     * it, so every place it is read agrees. `downloads_completed` in
     * settings.json is where it survives a restart, and the read that starts it
     * is the head of the write chain.
     */
    // which snapshot of the list the renderer has seen (see listSnapshot)
    this.listSeq = 0
    this.lifetimeCompleted = 0
    // how many of those landed in this session, which is how a queued write
    // works out which download it is writing about
    this.sessionCompletions = 0
    this.lifetimeReady = this.loadLifetimeCount()
    this.completionWrites = this.lifetimeReady

    // drives engine downloads and forwards their progress to the renderer
    this.runner = new DownloadRunner({
      engine: this.engine,
      updater: this.updater,
      history: this.history,
      sendEvent: (downloadId, payload) =>
        this.sendDownloadEvent(downloadId, payload),
      // every reservation, every slot taken and every settle is a change to the
      // list the panel draws, and the runner is where all three happen
      listChanged: () => this.publishList(),
      trackEvent: (name, payload) => this.trackDownloadEvent(name, payload),
      logAudit: (operation, success, data) =>
        this.logAudit(operation, success, data)
    })

    this.registerHandlers()
  }

  /**
   * where the download history is kept
   * @returns {string|null} the file, or null when userData cannot be resolved
   */
  historyFilePath() {
    if (typeof this.engine.getUserDataPath !== "function") {
      return null
    }

    return path.join(this.engine.getUserDataPath(), "downloads", "history.json")
  }

  /**
   * the whole download list, as it stands right now
   *
   * one shape, built synchronously from memory: every reservation the runner
   * holds, then every row the history remembers that is not one of them. The
   * renderer replaces its list with this rather than merging it into what it
   * has, which is the difference that ends four rounds of races - a pulled
   * snapshot had to be reconciled against events and clears that could land on
   * either side of it, and there was always one more ordering.
   *
   * `seq` orders the stream: the renderer applies a snapshot only if it is
   * newer than the last one it applied, so a push that overtakes a reply, or a
   * reply that arrives after the push it provoked, costs nothing. It counts
   * snapshots rather than downloads, so it is the same number in the push and
   * in the reply to a read.
   *
   * the lifetime count rides along because it changes with the same events and
   * the panel draws the two together.
   */
  listSnapshot() {
    const rows = []
    const seen = new Set()

    for (const status of this.runner.list()) {
      seen.add(status.downloadId)
      rows.push(listRow(status))
    }

    for (const row of this.history ? this.history.list() : []) {
      if (seen.has(row.download_id)) continue
      rows.push(row)
    }

    return {
      seq: (this.listSeq += 1),
      lifetimeCompleted: this.lifetimeCompleted,
      rows
    }
  }

  /**
   * ...and the renderer hears about it
   *
   * called after every change to the list and after nothing else: a reserve, a
   * slot taken, a settle, a clear, a removal. Progress is not a change to the
   * list - it is a number on a row that already exists - and pushing the whole
   * list four times a second per download would be a list rebuilt on every
   * frame.
   */
  publishList() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return

    this.mainWindow.webContents.send(
      IPC_CHANNELS.DOWNLOADS_LIST,
      this.listSnapshot()
    )
  }

  /**
   * send one download:progress event - the channel the renderer hooks listen on
   *
   * a completion is counted here, before the window is consulted: this is the
   * one path every finished download takes, on every platform, whether or not
   * there is an analytics exit point and whether or not there is still a window
   * to tell. The new total rides out on the event itself (`lifetime_completed`),
   * so the panel's number is main's number rather than a tally the renderer
   * keeps - see the panel v2 review, where every renderer-side tally was either
   * one too many or one too few after a hydration replay.
   */
  sendDownloadEvent(downloadId, payload) {
    const lifetimeCompleted =
      payload && payload.status === "completed"
        ? this.noteCompletedDownload()
        : null

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }

    this.mainWindow.webContents.send(IPC_CHANNELS.DOWNLOAD_PROGRESS, {
      downloadId,
      ...payload,
      ...(lifetimeCompleted === null ? null : { lifetimeCompleted })
    })
  }

  /**
   * hand one event to the exit point, whatever becomes of it there
   *
   * the exit point guards itself, so a throw out of capture() means the
   * collaborator is not the one we think it is - and every caller below is
   * somewhere a throw would be read as the operation failing. the cookie import
   * calls this from inside its own try, where a throw tells the user a jar that
   * imported did not; the download events reach it through the runner, where a
   * throw is a finished file reported as broken; the renderer's channel would
   * reject the ipc call. so this is where the never-throw promise is kept for
   * all of them, rather than three times in three spellings.
   *
   * @param {string} event - a name ALLOWED_PROPERTIES knows
   * @param {Object} properties - the bag for it
   * @returns {boolean} whether it reached the exit point
   */
  capture(event, properties) {
    if (!this.analytics) return false

    try {
      this.analytics.capture(event, properties)
      return true
    } catch (error) {
      // reported rather than swallowed: this is a broken exit point, which is
      // worth knowing about even though nothing here can do anything about it
      console.warn(
        `analytics: ${event} could not be captured:`,
        describeError(error)
      )
      return false
    }
  }

  /**
   * translate a runner event into an analytics event
   * @param {string} name - the runner's event name
   * @param {Object} payload - what the runner knows about the download
   */
  trackDownloadEvent(name, payload) {
    if (!this.analytics) return

    if (name === "download_cancelled") {
      // the cancel taxonomy carries three properties and no more. quality and
      // is_trimmed are not among them, and an unlisted one is dropped behind a
      // warning production never surfaces - so they are not sent
      this.capture("download_cancelled", {
        platform: payload.platform,
        media_type: MEDIA_TYPES[payload.type],
        progress_at_cancel: Math.round(payload.progress || 0),
        ...playlistProperties("download_cancelled", payload)
      })
      return
    }

    // the audio mode, read back off the format id - for an audio download that
    // id IS the mode the renderer sent as download_started's audio_format, so
    // both terminal events join to the start on it. it sits in `base` rather
    // than in either branch so the two ends cannot drift apart later.
    const format = audioFormat(payload.formatId)

    const base = {
      platform: payload.platform,
      media_type: MEDIA_TYPES[payload.type],
      quality: extractQuality(payload.formatId),
      is_trimmed: Boolean(payload.trimmed),
      ...(format ? { audio_format: format } : {}),
      // on both ends, so the two are comparable. without this we could see who
      // imported cookies and never whether it did them any good, which is
      // exactly the hole the po token rollout fell into - shipped, and then no
      // way to answer "did that help"
      ...this.cookieDimension(payload.platform)
    }

    if (name === "download_completed") {
      // the lifetime counter used to be incremented here. it moved to
      // `sendDownloadEvent`, which is the path every completion takes whether
      // or not there is an analytics exit point at all - and the completed
      // event has to carry the new number, so it has to have been counted by
      // the time the event goes out
      //
      // a size of zero is a stat that failed, not an empty file: a download
      // that resolved always wrote something. sending the zero would report
      // an empty file and drag every average through it, so all three of the
      // measurements are omitted rather than guessed at when they are missing
      const elapsed = elapsedBucket(payload.elapsedMs)

      /**
       * ...and a playlist's own measurements are omitted for the same reason
       * one place further along.
       *
       * `payload.fileSize` is the size of the file the result named, and for a
       * playlist that is whichever video happened to land LAST (the result
       * YtdlpOperation assembles in ytdlp/operation.js) - not the run. so
       * `file_size_mb` would report one video out of eleven, and `speed_bucket`
       * would divide that one file's bytes by the time all eleven took, which
       * is not a speed anything experienced. both land on the same properties
       * the single-video funnel is measured by, so sending them would not
       * merely be unreadable - it would drag the average every existing chart
       * already reads.
       *
       * `elapsed_bucket` is kept: how long the run took is the same question
       * whether the run held one video or eleven, and the answer is measured
       * from the same two clocks.
       */
      const perFile = !payload.playlist
      const speed = perFile
        ? speedBucket(payload.fileSize, payload.elapsedMs)
        : null

      this.capture("download_completed", {
        ...base,
        ...(perFile && payload.fileSize
          ? { file_size_mb: Math.round(payload.fileSize / (1024 * 1024)) }
          : {}),
        ...(elapsed ? { elapsed_bucket: elapsed } : {}),
        ...(speed ? { speed_bucket: speed } : {}),
        // a playlist that saved most of its videos exits 1 and arrives here as
        // a completion, which is the whole point of the outcome model: what it
        // did not save is a count on a success rather than a failure that
        // discards the eight files the user did get
        ...playlistProperties("download_completed", payload)
      })
      return
    }

    /**
     * the code carries the pattern detail here, not the message.
     *
     * mapError already classified the raw stderr through this same taxonomy
     * and put the answer in error.code; what it puts in error.message is the
     * user-facing wording, and the raw text stays behind in error.details.
     * classifying that wording instead reports UNKNOWN_ERROR for twelve of the
     * fourteen failures the engine can name - "Your antivirus stopped the
     * video processor" matches no pattern, least of all the antivirus one.
     *
     * handing classify() both is the taxonomy's own contract: an explicit code
     * we own wins, and the patterns are still there for a failure that arrived
     * without one, which is what a throw from outside the engine looks like.
     */
    const { category, stage } = classify(
      { code: payload.errorCode, message: payload.errorMessage },
      ERROR_STAGES.DOWNLOAD
    )

    this.capture("download_failed", {
      ...base,
      error_category: category,
      error_stage: stage,
      error_message: payload.errorMessage,
      progress_at_failure: Math.round(payload.progress || 0),
      ...playlistProperties("download_failed", payload)
    })
  }

  /**
   * report an event the renderer saw
   *
   * the bag is forwarded as it arrived. capture() reads it defensively, keeps
   * only the properties that event declares and checks each value against its
   * kind, so filtering here would be a second, weaker copy of that - and the
   * copy that goes stale. what this owes it is a real event name: a Symbol or
   * an object would otherwise be reported as "<unprintable>" by the very
   * warning meant to explain the drop.
   *
   * @param {Object} _event - the ipc event, unused
   * @param {Object} data - {event, properties} as the preload bridge sent it
   * @returns {Promise<Object>} {success} - the renderer does not act on it
   */
  async handleAnalyticsTrack(_event, data) {
    if (!this.analytics) return { success: false }

    const name = data && data.event

    if (typeof name !== "string" || !RENDERER_EVENTS.has(name)) {
      console.warn("analytics: refused an event the renderer may not send")
      return { success: false }
    }

    const properties =
      data.properties && typeof data.properties === "object"
        ? data.properties
        : {}

    /**
     * the renderer cannot answer this one, so main answers it on the way past.
     *
     * roughly three quarters of bot detection lands on a metadata lookup rather
     * than on a download, which makes media_info_failed the event that actually
     * measures whether cookies help. The renderer has no idea what is in the
     * jar - it only knows what main told it the last time somebody opened the
     * dialog - so the flag is stamped here, where the answer is a file read
     * away.
     */
    const enriched =
      name === "media_info_failed" || name === "media_info_loaded"
        ? { ...properties, ...this.cookieDimension(properties.platform) }
        : properties

    // capture() above keeps the never-throw promise for every caller, so an
    // ipc reply is the only thing left to decide here
    return { success: this.capture(name, enriched) }
  }

  /**
   * count a finished download, and speak up on the rare one that is a milestone
   *
   * the sequence stops. Asking again every ten downloads for as long as someone
   * keeps using the app turns a thank-you into a toll booth, so the gaps widen
   * and then it ends: 5, 15, 40, 60, 100, and never again however many hundreds
   * follow.
   *
   * **the count in memory is the count.** it is incremented here, synchronously,
   * and everything else reads it: the completed event carries it to the panel
   * (see sendDownloadEvent) and settings:get-download-count answers with it.
   * the file is where it survives a restart, nothing more. The renderer counting
   * for itself was the bug this replaced - hydration replays a completion over a
   * snapshot older than it, and any number the renderer derives from its own
   * rows is either one too many or one too few for the rest of the session.
   *
   * fire and forget on purpose: this hangs off the path where a download reports
   * success. A settings write that fails must not turn a finished file into a
   * failed one.
   *
   * the write is still chained, behind the one read that starts the counter
   * (loadLifetimeCount): the engine allows concurrent downloads, and two writes
   * racing would leave the file holding whichever landed last rather than the
   * total. Each chained write persists the total as it stands, so two downloads
   * finishing together write 5 once and 5 again rather than 4 and 5 - and the
   * milestone is decided from this call's own number, which is unique to it, so
   * nobody is asked for a coffee twice in a second.
   *
   * @returns {number} how many downloads this install has now finished
   */
  noteCompletedDownload() {
    const count = (this.lifetimeCompleted += 1)
    // which completion of this session this is, so the work below can name its
    // own total however many landed after it
    const nth = (this.sessionCompletions += 1)

    if (!this.settings) return count

    this.completionWrites = (this.completionWrites || Promise.resolve())
      .then(async () => {
        /**
         * this download's own number, decided here rather than above.
         *
         * `count` is the total as this call saw it, which is the install's
         * total the moment the file has been read - and it is read at
         * construction, long before anything can finish. The subtraction is
         * what keeps the rare exception honest: whatever was counted after this
         * call is taken back off, so two downloads finishing in the same tick
         * are the 4th and the 5th rather than the 5th twice, and nobody is
         * asked for a coffee twice in one second.
         */
        const total = this.lifetimeCompleted - (this.sessionCompletions - nth)

        await this.settings.writeSettings({
          downloads_completed: this.lifetimeCompleted
        })

        if (!SUPPORT_MILESTONES.includes(total)) return
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return

        this.mainWindow.webContents.send(IPC_CHANNELS.SUPPORT_MILESTONE, {
          count: total
        })

        // captured here rather than in the renderer because this is the line
        // that decides a prompt happens. A shown event reported from the other
        // side could only ever say the dialog mounted
        this.capture("support_prompt_shown", { milestone: total })
      })
      .catch((error) => {
        console.error("failed to record a completed download:", error.message)
      })

    return count
  }

  /**
   * read the counter this install starts the session with, once
   *
   * added to rather than assigned, because a download could in principle finish
   * while the read is in flight: what `lifetimeCompleted` holds before this
   * lands is a count of this session's own completions, which is a delta on top
   * of what the file says and not a total the file replaces.
   *
   * it is the head of `completionWrites`, so no write can persist a total that
   * was assembled before the file had been read.
   *
   * @returns {Promise<void>} settles when the counter is the install's own
   */
  loadLifetimeCount() {
    if (!this.settings || typeof this.settings.readAll !== "function") {
      return Promise.resolve()
    }

    return this.settings
      .readAll()
      .then((settings) => {
        this.lifetimeCompleted += normalizeCount(settings.downloads_completed)
      })
      .catch((error) => {
        // a counter we could not read is a zero on the panel, not a broken app.
        // the next completion still counts, and still writes
        console.warn(
          "the lifetime download count could not be read:",
          describeError(error)
        )
      })
  }

  /**
   * was this operation authenticated, for the events where that could matter
   *
   * youtube only. cookies are a youtube lever, and stamping the flag onto a
   * pinterest download would put a column in the data that means nothing and
   * invites a comparison that is not there.
   *
   * the question it exists to answer is the one the po token rollout could not:
   * of the installs youtube is refusing, what share of the refusals happen with
   * a signed-in jar attached. Comparing that rate against installs with no jar
   * is the whole measurement, and it needs the flag on the failures rather than
   * only on the import.
   *
   * @param {string} platform - the platform the operation was for
   * @returns {Object} {used_cookies} for youtube, {} for anything else
   */
  cookieDimension(platform) {
    if (platform !== "youtube" || !this.cookieManager) return {}

    try {
      return { used_cookies: Boolean(this.cookieManager.hasValidCookies()) }
    } catch {
      // a dimension is never worth failing an event over
      return {}
    }
  }

  /**
   * report a cookie import, whichever of the two routes it came in by
   *
   * one shape for both so they cannot drift, and called on the failure paths
   * too: an import that did not take is the more interesting half of the
   * question this event exists to answer.
   *
   * @param {boolean} imported - whether the jar was written
   */
  trackCookieImport(imported) {
    if (!this.analytics) return

    this.capture("cookies_imported", {
      // whether the file landed, not whether it turned out to be a login. the
      // two were the same flag, so a perfectly good signed-out import counted
      // as a failed one and the funnel could not tell the two apart
      success: Boolean(imported),
      // and this is the question its name asks. it was answering the narrower
      // "is this a login", so a jar full of youtube cookies reported false
      has_youtube_cookies: Boolean(this.cookieManager.hasYouTubeCookies()),
      signed_in: Boolean(this.cookieManager.hasValidCookies())
    })
  }

  /**
   * escalate to a PO token, because this install has just been refused
   *
   * yt-dlp's advice is to run the default clients until they stop working and
   * only then reach for a token provider. this is the "stop working" - the one
   * signal that says the default clients are done for this connection, so it is
   * the only thing that turns the escalation on. RATE_LIMITED deliberately does
   * not: the audit found throttling landing mostly on installs that were never
   * blocked at all, which makes it a reading of the user's network rather than
   * of youtube's door policy.
   *
   * both halves are set, because they answer different questions. the engine
   * field is what the *next* operation reads, so a user who was refused once
   * does not have to restart the app to benefit; the settings write is what a
   * restart reads back, so they do not have to be refused again to re-learn it.
   *
   * re-stamped on every refusal rather than written once. the stored timestamp
   * expires the escalation after a week, and refreshing it here is what makes
   * that window mean "a week since youtube last turned us away" instead of "a
   * week since the first time it ever did".
   *
   * @param {string} category - what the taxonomy made of the failure
   * @returns {boolean} whether a payload is being fetched because of this
   */
  noteRefusal(category) {
    if (category !== ERROR_CATEGORIES.BOT_DETECTION) return false

    this.engine.setPotEnabled(true)

    // fired, never awaited: the operation that failed is already answering the
    // user, and it must not wait on our disk to do it. a write that does not
    // land costs one more refusal after the next launch, which is the same
    // failure this install just had - not a new way to break
    Promise.resolve(this.settings.setPotEnabled(true))
      .then((result) => {
        if (result && result.success === false) {
          console.warn(`could not persist the PO token escalation: ${result.error}`)
        }
      })
      .catch((error) => {
        console.warn(
          "could not persist the PO token escalation:",
          describeError(error)
        )
      })

    // the flag alone escalates nothing: the engine only emits the flags when
    // the payload is actually on disk, so this is what makes the escalation
    // real. also fired rather than awaited - a ~70 mb download is not
    // something to hold a failed request open for
    // nothing published for this platform means nothing to fetch, and the
    // sentence we would otherwise add to the error promises a fix that is
    // never coming. asked before starting rather than after, because the user
    // is told now and the download answers later
    if (!this.potInstaller || !this.potInstaller.canInstall()) return false

    const needed = !this.engine.getPotPaths()

    this.potInstaller
      .ensureInstalled()
      .then((result) => {
        // the payload arrives partway through a session, so the super property
        // that reports whether this install has one is not fixed at startup.
        // left stale it would read as "the download never works"
        if (result && result.installed && this.analytics) {
          this.analytics.setPotEnvironment({
            denoPresent: Boolean(this.engine.getDenoPath()),
            potProvider: Boolean(this.engine.getPotPaths())
          })
        }
      })
      .catch((error) => {
        // ensureInstalled already keeps a never-rejects promise; this is here so
        // that a broken collaborator cannot surface as an unhandled rejection
        console.warn("PO token payload install failed:", describeError(error))
      })

    return needed
  }

  // audit logging
  logAudit(operation, success = true, data = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      success,
      error: success ? null : data.error
    }

    this.auditLog.push(logEntry)

    // keep only last 50 entries
    if (this.auditLog.length > 50) {
      this.auditLog.shift()
    }
  }

  // validate required fields
  validateRequest(data, requiredFields) {
    for (const field of requiredFields) {
      if (
        !data ||
        data[field] === undefined ||
        data[field] === null ||
        data[field] === ""
      ) {
        throw new Error(`Missing required field: ${field}`)
      }
    }
  }

  // create standardized error response
  createError(
    message,
    suggestion = "Please try again",
    code = "GENERAL_ERROR",
    extra = null
  ) {
    return {
      success: false,
      error: { message, suggestion, code, ...(extra || {}) }
    }
  }

  // create standardized success response
  createSuccess(data) {
    return {
      success: true,
      data
    }
  }

  // set main window reference
  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow
  }

  // register all ipc handlers
  registerHandlers() {
    // video operations
    ipcMain.handle(
      IPC_CHANNELS.VIDEO_GET_INFO,
      this.handleGetVideoInfo.bind(this)
    )
    ipcMain.handle(
      IPC_CHANNELS.VIDEO_DOWNLOAD_COMBINED,
      this.handleDownloadCombined.bind(this)
    )
    ipcMain.handle(
      IPC_CHANNELS.AUDIO_DOWNLOAD,
      this.handleDownloadAudio.bind(this)
    )

    // playlist operations
    ipcMain.handle(
      IPC_CHANNELS.PLAYLIST_GET_INFO,
      this.handleGetPlaylistInfo.bind(this)
    )
    ipcMain.handle(
      IPC_CHANNELS.PLAYLIST_DOWNLOAD,
      this.handleDownloadPlaylist.bind(this)
    )

    // download management
    ipcMain.handle(
      IPC_CHANNELS.DOWNLOAD_CANCEL,
      this.handleCancelDownload.bind(this)
    )
    ipcMain.handle(
      "download:get-status",
      this.handleGetDownloadStatus.bind(this)
    )
    ipcMain.handle("download:get-list", this.handleGetList.bind(this))
    ipcMain.handle("download:clear-history", this.handleClearHistory.bind(this))
    ipcMain.handle(
      "download:remove-history",
      this.handleRemoveHistory.bind(this)
    )

    // cookie management
    ipcMain.handle(IPC_CHANNELS.COOKIES_TEST, this.handleTestCookies.bind(this))
    ipcMain.handle(
      IPC_CHANNELS.COOKIES_STATUS,
      this.handleGetCookieStatus.bind(this)
    )
    ipcMain.handle(
      "cookies:import-file",
      this.handleImportCookieFile.bind(this)
    )
    ipcMain.handle("cookies:clear", this.handleClearCookies.bind(this))

    // system operations
    ipcMain.handle(
      IPC_CHANNELS.SYSTEM_HEALTH,
      this.handleSystemHealth.bind(this)
    )
    ipcMain.handle(
      IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL,
      this.handleOpenExternal.bind(this)
    )
    ipcMain.handle(
      IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS,
      this.handleGetDiagnostics.bind(this)
    )

    // telemetry
    ipcMain.handle(
      IPC_CHANNELS.ANALYTICS_TRACK,
      this.handleAnalyticsTrack.bind(this)
    )
    ipcMain.handle(
      "system:open-download-folder",
      this.handleOpenDownloadFolder.bind(this)
    )
    ipcMain.handle(
      "system:show-in-folder",
      this.handleShowInFolder.bind(this)
    )
    ipcMain.handle(
      "system:select-download-folder",
      this.handleSelectDownloadFolder.bind(this)
    )
    ipcMain.handle(
      "settings:get-download-path",
      this.handleGetDownloadPath.bind(this)
    )
    ipcMain.handle(
      "settings:get-download-count",
      this.handleGetDownloadCount.bind(this)
    )
    ipcMain.handle(
      "settings:set-download-path",
      this.handleSetDownloadPath.bind(this)
    )

    // auto-updater operations
    ipcMain.handle(
      IPC_CHANNELS.UPDATE_CHECK,
      this.handleCheckForUpdates.bind(this)
    )
    ipcMain.handle(
      IPC_CHANNELS.UPDATE_DOWNLOAD,
      this.handleDownloadUpdate.bind(this)
    )
    ipcMain.handle(
      IPC_CHANNELS.UPDATE_INSTALL,
      this.handleInstallUpdate.bind(this)
    )
    ipcMain.handle(
      "update:force-security-check",
      this.handleForceSecurityCheck.bind(this)
    )
  }

  // handle video info extraction with validation
  async handleGetVideoInfo(event, data) {
    try {
      this.validateRequest(data, ["url"])
      const { url, platform } = data
      const targetPlatform = platform ? String(platform).toLowerCase() : "youtube"

      if (!SUPPORTED_DOWNLOAD_PLATFORMS.includes(targetPlatform)) {
        // classified here because nothing else will: this refusal is raised
        // before the engine runs, so the catch below never sees it and
        // media_info_failed would report it as UNKNOWN_ERROR. a url for a site
        // we do not serve is the invalid one
        return this.createError(
          "Unsupported platform",
          "Please use YouTube, Pinterest, or TikTok",
          "GENERAL_ERROR",
          { category: ERROR_CATEGORIES.INVALID_URL }
        )
      }

      // one spawn, no server to wait for
      const info = await this.engine.getInfo(url)

      // the python pinterest service refused image pins by inspecting formats
      if (targetPlatform === "pinterest" && !hasPlayableVideo(info)) {
        // the same reason: raised here rather than thrown, so it arrives
        // unclassified unless this says so. its own category rather than
        // VIDEO_UNAVAILABLE, which means a video that has gone away - this is
        // somebody pointing a downloader at an image, and the two answer
        // different questions
        return this.createError(
          "This Pinterest pin contains an image, not a video.",
          "The Pinterest downloader only works with video pins.",
          ERROR_CATEGORIES.NOT_A_VIDEO,
          { category: ERROR_CATEGORIES.NOT_A_VIDEO }
        )
      }

      const videoInfo =
        targetPlatform === "youtube"
          ? mapVideoInfo(info)
          : mapSimpleInfo(info, `${targetPlatform}_video`)

      return this.createSuccess(videoInfo)
    } catch (error) {
      console.error("Info extraction failed:", error.message)
      return this.infoFailure(error)
    }
  }

  /**
   * turn a failed metadata request into the response the renderer reads
   *
   * shared by the video and the playlist listing, which fail in exactly the
   * same ways: the same taxonomy, the same escalation, the same wording.
   *
   * @param {Error} error - what the engine threw
   * @returns {Object} the ipc error response
   */
  infoFailure(error) {
    const { category } = classify(error, ERROR_STAGES.FETCH_INFO)

    // the metadata fetch is the first thing a blocked install fails at, so
    // this is usually where the refusal is discovered
    const fetching = this.noteRefusal(category)

    /**
     * the only thing the user is told about the download, and it is told
     * here because this is the one error surface that actually reaches them:
     * `suggestion` is carried all the way to the renderer's DownloadError and
     * then never rendered by anything.
     *
     * a sentence rather than a progress bar. the work is not something they
     * asked for or can act on, and the honest report of it is short: a fix is
     * coming, try again shortly. saying nothing at all would leave a user
     * retrying into the same wall with no idea it was about to stop - and a
     * bare percentage would explain even less than silence.
     *
     * only when a fetch really did start. an install that already has the
     * payload and is still being refused has nothing to wait for, and
     * promising it would be a lie the second time.
     */
    const message = error.message || "Failed to get media information"

    return this.createError(
      fetching
        ? `${message} Setting up a fix in the background - try again in a minute.`
        : message,
      error.suggestion || "Please check the URL and try again",
      error.code || "GENERAL_ERROR",
      {
        details: error.details || undefined,
        category
      }
    )
  }

  // combined video download - resolves as soon as the process is running,
  // completion and failure arrive as download:progress events
  async handleDownloadCombined(event, data) {
    const targetPlatform = data?.platform
      ? String(data.platform).toLowerCase()
      : "youtube"

    if (!SUPPORTED_DOWNLOAD_PLATFORMS.includes(targetPlatform)) {
      return this.createError(
        "Unsupported platform",
        "Please use YouTube, Pinterest, or TikTok"
      )
    }

    // the renderer generates the id so its listener can filter events from the
    // moment it subscribes, before this acknowledgement even arrives
    const downloadId = resolveDownloadId(data && data.download_id, "combined")

    if (!downloadId) {
      return this.createError(
        "Invalid download id",
        "Please restart the app and try again",
        "INVALID_DOWNLOAD_ID"
      )
    }

    try {
      if (targetPlatform === "youtube") {
        // the menu row the user clicked: a real height, and the container that
        // row was labelled with
        this.validateRequest(data, ["url", "height"])
      } else {
        // pinterest and tiktok only need the url
        this.validateRequest(data, ["url"])
      }

      const {
        url,
        height,
        container,
        audio_language: audioLanguage,
        time_range: rawTimeRange,
        precise_cut: preciseCut,
        title = "video",
        format_id: simpleFormatId
      } = data

      const outputDir = await this.getDownloadDirectory()
      const timeRange = normalizeTimeRange(rawTimeRange)

      if (targetPlatform === "youtube") {
        // the template is native now: yt-dlp fills in the title and the height
        const outputTemplate = buildVideoOutputTemplate({ timeRange })

        const createHandle = () =>
          this.engine.downloadCombined({
            url,
            height,
            container,
            // only sent for a video that offers a choice of dubs; the engine
            // validates it before it reaches a format expression
            audioLanguage,
            outputDir,
            outputTemplate,
            timeRange,
            preciseCut
          })

        // claim the id before acking so a cancel arriving immediately after
        // cannot slip through the gap
        if (
          !this.runner.reserve(downloadId, {
            type: "combined",
            platform: targetPlatform,
            title,
            // what a downloads list shows beside the title, and what a retry
            // re-sends. the label is built from the tier the engine will
            // really use rather than from the raw payload, so a container we
            // never offered cannot put a word on the row that disagrees with
            // the file it produces
            label: `${height}p ${normalizeQualityTier({ height, container }).container}`,
            request: retryRequest({
              url,
              title,
              platform: targetPlatform,
              height,
              container,
              audio_language: audioLanguage,
              time_range: rawTimeRange,
              precise_cut: preciseCut
            })
          })
        ) {
          return this.duplicateDownloadError(downloadId)
        }

        // fire and forget: the renderer follows the rest over progress events
        this.startDownload({
          downloadId,
          type: "combined",
          platform: targetPlatform,
          title,
          // analytics reads the quality off this - the height is the quality now
          formatId: `${height}p`,
          trimmed: Boolean(timeRange),
          createHandle
        })

        return this.createSuccess({
          download_id: downloadId,
          status: "started",
          type: "combined"
        })
      }

      /**
       * tiktok and pinterest answer the same way every other kind does: an
       * acknowledgement now, the rest over progress events.
       *
       * awaiting the run here would hold the ipc call open for however long the
       * row waits behind the cap plus the download itself, and a download the
       * queue cannot show is a download the queue does not cover.
       *
       * it also closes the last ordering gap. this was the one path that called
       * run() outside startDownload's setImmediate, so a tiktok link pasted
       * after a youtube one reached the semaphore first. every kind starts
       * through startDownload now, and since nothing awaits between reserve()
       * and it, the order runs reach the queue is the order they were accepted
       * in (see park in services/download-runner.js).
       */
      const outputTemplate = buildSimpleOutputTemplate({
        title,
        platform: targetPlatform
      })

      // each platform keeps the options its python service used - format_id
      // is accepted for its analytics label below, never as a selector
      // override. tiktok's preset exists specifically to avoid the
      // watermarked stream; letting an incoming value replace it would
      // silently undo that
      const preset = getSimplePlatformOptions(targetPlatform)

      const createHandle = () =>
        this.engine.downloadSimple({
          url,
          outputDir,
          outputTemplate,
          formatSelector: preset.formatSelector,
          extraArgs: preset.extraArgs
        })

      if (
        !this.runner.reserve(downloadId, {
          type: "combined",
          platform: targetPlatform,
          title,
          // a simple platform offers no choice at all, so the platform is the
          // only thing there is to say about what this download is
          label: targetPlatform,
          request: retryRequest({ url, title, platform: targetPlatform })
        })
      ) {
        return this.duplicateDownloadError(downloadId)
      }

      // fire and forget: the renderer follows the rest over progress events.
      // nothing translates a failure here any more, because the runner's
      // `failed` event already carries the wording, the details and the
      // category, and startDownload is what notes a refusal
      this.startDownload({
        downloadId,
        type: "combined",
        platform: targetPlatform,
        title,
        formatId: simpleFormatId || targetPlatform,
        createHandle
      })

      return this.createSuccess({
        download_id: downloadId,
        status: "started",
        type: "combined"
      })
    } catch (error) {
      console.error(`[${downloadId}] Combined download failed:`, error.message)

      return this.createError(
        shortErrorMessage(error.message),
        error.suggestion || "Please try again or check your connection",
        error.code || "DOWNLOAD_FAILED",
        {
          details: error.details || error.message,
          category: classify(error, ERROR_STAGES.DOWNLOAD).category
        }
      )
    }
  }

  // audio download - same start-then-events contract as the video flow
  async handleDownloadAudio(event, data) {
    const downloadId = resolveDownloadId(data && data.download_id, "audio")

    if (!downloadId) {
      return this.createError(
        "Invalid download id",
        "Please restart the app and try again",
        "INVALID_DOWNLOAD_ID"
      )
    }

    try {
      this.validateRequest(data, ["url", "audio_mode"])

      const {
        url,
        audio_mode: audioMode,
        audio_language: audioLanguage,
        time_range: rawTimeRange,
        title = "audio"
      } = data

      const outputDir = await this.getDownloadDirectory()
      const timeRange = normalizeTimeRange(rawTimeRange)
      const outputTemplate = buildAudioOutputTemplate({ timeRange })

      const createHandle = () =>
        this.engine.downloadAudio({
          url,
          audioMode,
          audioLanguage,
          outputDir,
          outputTemplate,
          timeRange,
          // audio-only formats ignore the start time unless cuts are forced;
          // extraction re-encodes anyway, so this is free (ticket 1 finding)
          preciseCut: Boolean(timeRange)
        })

      if (
        !this.runner.reserve(downloadId, {
          type: "audio",
          platform: "youtube",
          title,
          // the mode is the whole choice an audio download offers
          label: audioMode,
          request: retryRequest({
            url,
            title,
            platform: "youtube",
            audio_mode: audioMode,
            audio_language: audioLanguage,
            time_range: rawTimeRange
          })
        })
      ) {
        return this.duplicateDownloadError(downloadId)
      }

      this.startDownload({
        downloadId,
        type: "audio",
        platform: "youtube",
        title,
        formatId: audioMode,
        trimmed: Boolean(timeRange),
        createHandle
      })

      return this.createSuccess({
        download_id: downloadId,
        status: "started",
        type: "audio"
      })
    } catch (error) {
      console.error(`[${downloadId}] Audio download failed:`, error.message)

      return this.createError(
        shortErrorMessage(error.message),
        error.suggestion || "Please try again or check your connection",
        error.code || "DOWNLOAD_FAILED",
        {
          details: error.details || error.message,
          category: classify(error, ERROR_STAGES.DOWNLOAD).category
        }
      )
    }
  }

  /**
   * list what a playlist link holds - the rows the picker draws
   *
   * playlists are **youtube only**. a pinterest pin and a tiktok video are
   * single media, and `--flat-playlist` against one answers a question nobody
   * asked, so an unsupported platform is refused the way handleGetVideoInfo
   * refuses one rather than left to fail obscurely in the engine.
   */
  async handleGetPlaylistInfo(_event, data) {
    try {
      this.validateRequest(data, ["url"])
      const { url, platform } = data

      // the link decides, and a label that disagrees with it loses
      if (!isPlaylistPlatform(platform) || !isYouTubeRequestUrl(url)) {
        return this.unsupportedPlaylistPlatform()
      }

      // one spawn, --flat-playlist, ~1s even for a hundred items
      const listing = mapPlaylistInfo(await this.engine.getPlaylistInfo(url))

      this.rememberPlaylistListing(listing)

      return this.createSuccess(listing)
    } catch (error) {
      console.error("Playlist listing failed:", error.message)
      return this.infoFailure(error)
    }
  }

  /**
   * remember the listing a download can be checked against
   *
   * an entry the listing marked `unavailable` is a deleted or private video.
   * downloading one cannot work, and each attempt spends one of yt-dlp's five
   * `--skip-playlist-after-errors` failures - so five of them end the run for
   * the videos that were fine. the renderer disables those rows; this is the
   * half of that check that does not run in the window it is enforcing.
   *
   * one listing rather than a cache, and matched on the playlist id: the
   * picker downloads the playlist it is looking at. a request for anything
   * else goes through unchecked, which is the honest answer - main has no
   * listing of it to check against, and inventing a refusal would be worse.
   *
   * @param {Object} listing - what mapPlaylistInfo returned
   */
  rememberPlaylistListing(listing) {
    if (!listing || !listing.playlist_id) {
      this.lastPlaylistListing = null
      return
    }

    this.lastPlaylistListing = {
      playlistId: listing.playlist_id,
      unavailable: new Set(
        listing.entries
          .filter((entry) => entry.unavailable)
          .map((entry) => entry.index)
      )
    }
  }

  /**
   * the selected positions the last listing said were not downloadable
   * @param {string} playlistId - the playlist the request names
   * @param {Object[]} entries - the validated selection
   * @returns {number[]} positions that cannot be downloaded
   */
  unavailableSelection(playlistId, entries) {
    const listing = this.lastPlaylistListing

    if (!listing || listing.playlistId !== playlistId) {
      return []
    }

    return entries
      .map((entry) => entry.index)
      .filter((index) => listing.unavailable.has(index))
  }

  // playlists are youtube only, and the two handlers say so in one voice
  unsupportedPlaylistPlatform() {
    return this.createError(
      "Playlists are only supported on YouTube",
      "Please paste a YouTube playlist link",
      "GENERAL_ERROR",
      { category: ERROR_CATEGORIES.INVALID_URL }
    )
  }

  /**
   * start a playlist download: one id, one process, n files
   *
   * the same start-then-events contract the single-video flows use, so the
   * renderer follows a playlist over `download:progress` exactly as it follows
   * a video. what is new is on those events, not in this reply: two levels of
   * progress on the way, and a count of what was saved, reused and skipped at
   * the end. a playlist that saved eight of nine is **completed**, not a
   * fourth status nothing downstream knows how to read.
   */
  async handleDownloadPlaylist(_event, data) {
    // before the id is even resolved, so a link we do not serve reserves
    // nothing and spawns nothing. the link decides, not the label beside it
    if (
      !isPlaylistPlatform(data && data.platform) ||
      !isYouTubeRequestUrl(data && data.url)
    ) {
      return this.unsupportedPlaylistPlatform()
    }

    // the request says which tab it came from; everything else is a video
    const audioOnly = Boolean(data) && data.type === "audio"
    const type = audioOnly ? "audio" : "combined"

    // one id for the whole playlist. the renderer generates it so its listener
    // is correlated before this acknowledgement even arrives
    const downloadId = resolveDownloadId(
      data && data.download_id,
      `playlist-${type}`
    )

    if (!downloadId) {
      return this.createError(
        "Invalid download id",
        "Please restart the app and try again",
        "INVALID_DOWNLOAD_ID"
      )
    }

    try {
      // the playlist id is required rather than defaulted: it names the resume
      // archive, and a default would put two different playlists at the same
      // quality into one shared file
      this.validateRequest(
        data,
        audioOnly
          ? ["url", "playlist_id", "entries", "audio_mode"]
          : ["url", "playlist_id", "entries", "height"]
      )

      const {
        url,
        playlist_id: playlistId,
        entries: rawEntries,
        height,
        audio_mode: audioMode,
        ignore_archive: ignoreArchive,
        title = "playlist"
      } = data

      const entries = normalizePlaylistEntries(rawEntries)
      const unavailable = this.unavailableSelection(playlistId, entries)

      if (unavailable.length) {
        return this.createError(
          unavailable.length === entries.length
            ? "None of the selected videos can be downloaded."
            : "Some of the selected videos aren't available.",
          "Unselect the videos marked unavailable and try again.",
          "GENERAL_ERROR",
          { category: ERROR_CATEGORIES.VIDEO_UNAVAILABLE }
        )
      }

      // a playlist is one quality instruction for every video in it: a ceiling
      // yt-dlp applies per video, or one audio preset. neither is derived from
      // a format list, because a flat listing carries none
      const ceiling = audioOnly ? null : normalizePlaylistHeight(height)
      const audio = audioOnly ? normalizePlaylistAudioMode(audioMode) : null

      // what the archive is scoped by. the archive is keyed on video id alone,
      // so it is quality-blind on its own: without this, "download this
      // playlist again in 4K" would silently do nothing at all
      const mode = audioOnly ? audio : `${ceiling}p-${PLAYLIST_CONTAINER}`

      const outputDir = await this.getDownloadDirectory()
      const archiveFile = buildPlaylistArchivePath({
        userDataPath: this.engine.getUserDataPath(),
        playlistId,
        mode,
        outputDir
      })

      this.ensureArchiveDirectory(archiveFile)

      const outputTemplate = buildPlaylistOutputTemplate({ audioOnly })

      const createHandle = () =>
        this.engine.run(audioOnly ? "playlist-audio" : "playlist-combined", {
          url,
          // {index, id} pairs, not bare positions: the engine derives the -I
          // spec from the indices, and works out what the archive already
          // holds by matching the ids against it before it spawns
          playlistEntries: entries,
          ...(audioOnly ? { audioMode: audio } : { height: ceiling }),
          outputDir,
          outputTemplate,
          archiveFile,
          // "download everything again", for a user who deleted the files an
          // archive still remembers. a literal true only - this is the one
          // flag whose accidental truthiness re-downloads a hundred videos
          ...(ignoreArchive === true ? { ignoreArchive: true } : {})
        })

      // claim the id before acking, so a cancel arriving immediately after
      // cannot slip through the gap
      if (
        !this.runner.reserve(downloadId, {
          type,
          platform: "youtube",
          title,
          // one row in a downloads list, covering n videos - see list()
          playlist: true,
          // the count is what a playlist row has instead of a quality: the
          // ceiling applies per video and says nothing about the size of the
          // job, which is the number the user is waiting on
          label: `${entries.length} ${entries.length === 1 ? "video" : "videos"}`,
          // the selection travels with it, so a retry downloads the videos
          // that were picked rather than the whole playlist. `type` here is
          // the wire spelling the renderer sends, which is not the runner's:
          // a playlist of videos is "video" on the wire and "combined" to the
          // runner, and this field is the one that gets re-sent
          request: retryRequest({
            url,
            title,
            platform: "youtube",
            playlist_id: playlistId,
            entries,
            type: audioOnly ? "audio" : "video",
            ...(audioOnly ? { audio_mode: audio } : { height: ceiling }),
            ...(ignoreArchive === true ? { ignore_archive: true } : {})
          })
        })
      ) {
        return this.duplicateDownloadError(downloadId)
      }

      // fire and forget: the renderer follows the rest over progress events
      this.startDownload({
        downloadId,
        type,
        platform: "youtube",
        title,
        // analytics reads the quality off this, exactly as it does for one
        // video: the audio mode for audio, the ceiling for a video
        formatId: audioOnly ? audio : `${ceiling}p`,
        playlist: true,
        createHandle
      })

      return this.createSuccess({
        download_id: downloadId,
        status: "started",
        type,
        items_total: entries.length
      })
    } catch (error) {
      console.error(`[${downloadId}] Playlist download failed:`, error.message)

      return this.createError(
        shortErrorMessage(error.message),
        error.suggestion || "Please try again or check your connection",
        error.code || "DOWNLOAD_FAILED",
        {
          details: error.details || error.message,
          category: classify(error, ERROR_STAGES.DOWNLOAD).category,
          // a refusal that named itself travels as itself: the archive folder
          // and the download folder are both PERMISSION_ERROR, and only this
          // says which one the renderer is looking at
          ...(error.wordingCode ? { wordingCode: error.wordingCode } : null)
        }
      )
    }
  }

  /**
   * create the folder the resume archive lives in, before anything spawns
   *
   * `buildPlaylistArchivePath` is a pure path builder and `<userData>/playlists`
   * does not exist on a fresh install. measured on the shipped binary, a run
   * whose archive directory is missing **exits 1 at the end of an otherwise**
   * **perfect download** and the archive is never written - so every later run
   * re-downloads the lot and resume silently never works.
   *
   * the engine owns `<userData>/playlists/runs/` and creates that itself; this
   * is the directory one level up, which only this caller knows it needs.
   *
   * @param {string} archiveFile - where the archive will be written
   * @throws {Error} the same refusal the engine makes of an unwritable records
   *   file, because it is the same folder and the same answer
   */
  ensureArchiveDirectory(archiveFile) {
    try {
      fs.mkdirSync(path.dirname(archiveFile), { recursive: true })
    } catch (cause) {
      // the engine's own wording for this, imported rather than repeated: it
      // is the same refusal about the same folder, and it carries the code
      // that keeps it apart from a download folder we cannot write to
      const error = new Error(RECORDS_UNWRITABLE.message)
      error.code = ERROR_CODES.PERMISSION_ERROR
      error.wordingCode = RECORDS_UNWRITABLE.code
      error.suggestion = RECORDS_UNWRITABLE.suggestion
      error.details = cause.message
      throw error
    }
  }

  // refusing is the safe half of the trade: replacing a live reservation would
  // cross-wire two event streams onto one id and lose the first download's
  // bookkeeping when the second finishes
  duplicateDownloadError(downloadId) {
    console.warn(`[${downloadId}] refused: that download id is already running`)

    return this.createError(
      "That download is already running",
      "Wait for it to finish, or cancel it first",
      "DUPLICATE_DOWNLOAD"
    )
  }

  // start a download after the ipc reply has gone out, so the renderer always
  // knows the download id before the first progress event reaches it
  startDownload(options) {
    setImmediate(() => {
      this.runner
        .run(options)
        .then((result) => {
          if (!result) return

          // the download half of the refusal check. a cancel is not a refusal,
          // and it settles through here wearing the same `success: false`
          if (!result.success && !result.cancelled) {
            this.noteRefusal(classify(result.error, ERROR_STAGES.DOWNLOAD).category)
            return
          }

          // a playlist that saved some and skipped the rest is a success
          // wearing a failure's reason. the runner classified the stderr of
          // the items that did not make it, and nine videos refused for bot
          // detection is exactly the refusal this escalation exists for - it
          // would otherwise be missed for having arrived on a download that
          // worked
          if (result.success && result.category) {
            this.noteRefusal(result.category)
          }
        })
        .catch((error) => {
          console.error("download runner crashed:", error.message)
        })
    })
  }

  // resolve the folder downloads are written to - the same one the settings ui
  // persists and "open folder" opens
  async getDownloadDirectory() {
    return this.settings.ensureDownloadPath()
  }

  // cancel a download - the engine kills the process for real
  async handleCancelDownload(event, data) {
    try {
      this.validateRequest(data, ["downloadId"])
      const { downloadId } = data

      if (this.runner.cancel(downloadId)) {
        return this.createSuccess({ cancelled: true })
      }

      return this.createError("Download not found")
    } catch (error) {
      console.error("Cancel download failed:", error.message)
      return this.createError("Failed to cancel download")
    }
  }


  // get download status
  async handleGetDownloadStatus(event, data) {
    try {
      this.validateRequest(data, ["downloadId"])
      const { downloadId } = data

      const download = this.runner
        .list()
        .find((entry) => entry.downloadId === downloadId)
      if (download) {
        return this.createSuccess(download)
      } else {
        return this.createError("Download not found")
      }
    } catch (error) {
      console.error("Get download status failed:", error.message)
      return this.createError("Failed to get download status")
    }
  }

  // get all active downloads
  /**
   * the renderer's one read of the list
   *
   * the same snapshot the pushes carry, for the first read of a window and for
   * any re-sync: applied through the same path, ordered by the same counter, so
   * a push that overtook the reply is not undone by it.
   */
  async handleGetList(_event) {
    try {
      // the file has to have been read, or a window that opened in the first
      // moments of the session would be told this install has no history - and
      // the next push is a download away
      await this.history.ready

      return this.createSuccess(this.listSnapshot())
    } catch (error) {
      console.error("Get download list failed:", error.message)
      return this.createError("Failed to get the downloads list")
    }
  }

  /**
   * "clear finished": the rows with nothing left to happen to them go, and the
   * ones still queued or running stay. answers with what is left, and with the
   * epoch it happened at, so the panel does not have to guess which of its rows
   * this covered.
   *
   * the epoch moves before the history does. A snapshot read taken between the
   * two would otherwise carry the new number over rows this clear is about to
   * delete, and the renderer would keep them for the rest of the session.
   */
  async handleClearHistory(_event) {
    try {
      await this.history.clear()
      this.publishList()

      return this.createSuccess(this.listSnapshot())
    } catch (error) {
      console.error("Clear download history failed:", error.message)
      return this.createError("Failed to clear the download history")
    }
  }

  // forget one row. it says nothing about the download itself - a row removed
  // while it is still running keeps running, and cancel is the channel for that.
  // the epoch moves for the same reason it does on a clear: this is the other
  // way a row leaves the history
  async handleRemoveHistory(_event, data) {
    try {
      this.validateRequest(data, ["downloadId"])
      await this.history.remove(data.downloadId)
      this.publishList()

      return this.createSuccess(this.listSnapshot())
    } catch (error) {
      console.error("Remove download history failed:", error.message)
      return this.createError("Failed to remove that download")
    }
  }


  // import cookies from file
  async handleImportCookieFile(_event) {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        title: "select your cookies.txt",
        filters: [
          { name: "cookie files", extensions: ["txt"] },
          { name: "All Files", extensions: ["*"] }
        ],
        properties: ["openFile"]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return this.createError("No file selected")
      }

      const filePath = result.filePaths[0]
      await this.cookieManager.importCookieFile(filePath)
      this.trackCookieImport(true)

      // a refusal throws, so reaching here means the file landed. Whether it is
      // a login is the separate question, and hasValidCookies is the only part
      // the dialog reads
      return this.createSuccess({
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Cookie file import failed:", error.message)
      this.trackCookieImport(false)
      // the manager's sentence is the message, not the suggestion. it used to
      // go in the second slot, which api.ts drops - so every refused import,
      // including the ones with a precise reason, reached the user as the
      // generic "Failed to import cookie file"
      return this.createError(
        error.message || "couldn't import that cookie file",
        "export cookies.txt with a browser extension, then pick that file.",
        // the manager's refusal code, so the renderer can say the same thing in
        // russian. only those cross: a full disk or a permission error carries a
        // node code of its own (ENOSPC, EACCES), and forwarding that would make
        // the field mean two things
        typeof error.code === "string" && error.code.startsWith("COOKIES_")
          ? error.code
          : "GENERAL_ERROR"
      )
    }
  }

  /**
   * test cookies
   *
   * this deliberately does not claim "your cookies work". Extracting a public
   * video with the jar attached proves extraction succeeded, not that youtube
   * accepted the cookies as a login - the same probe passes with no cookies at
   * all. So two separate facts are reported: whether the jar holds live youtube
   * cookies, and what a real extraction did with them. The one strong negative
   * signal is bot detection *while sending the cookies*, which does mean they
   * are not being honoured.
   */
  async handleTestCookies(_event) {
    try {
      // inspectCookieFile reads the file every time, so it already sees a jar
      // that changed or expired since the import
      const inspection = await this.cookieManager.inspectCookieFile()

      if (!inspection.usable) {
        const noteCode = cookieJarProblemCode(inspection)
        const note = JAR_PROBLEMS[noteCode]

        await this.cookieManager.updateStatus({
          lastTest: new Date().toISOString(),
          cookiesLoaded: false,
          extractionCheck: "skipped",
          note,
          noteCode
        })

        return this.createSuccess({
          cookiesLoaded: false,
          extractionCheck: "skipped",
          rejected: false,
          note,
          noteCode,
          status: await this.cookieManager.getStatus(),
          hasValidCookies: false
        })
      }

      // probe with the cookie file forced on, so the result depends on it
      const { extractionCheck, note, noteCode } = await this.probeCookies(
        this.cookieManager.getCookieFilePath()
      )

      await this.cookieManager.updateStatus({
        lastTest: new Date().toISOString(),
        cookiesLoaded: true,
        extractionCheck,
        note,
        noteCode
      })

      return this.createSuccess({
        // the jar loaded - which is all this ever meant
        cookiesLoaded: true,
        extractionCheck,
        // and this is the verdict. the renderer titled its toast off
        // cookiesLoaded alone, so a probe that came back rejected still
        // announced "Cookies look fine" over a description saying youtube had
        // turned them down
        rejected: extractionCheck === "rejected",
        note,
        noteCode,
        status: await this.cookieManager.getStatus(),
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Cookie test failed:", error.message)
      return this.createError("couldn't test the cookies", error.message)
    }
  }

  /**
   * run a real extraction with the jar attached and report what happened
   *
   * walks COOKIE_TEST_URLS, treating an unavailable target as "this probe told
   * us nothing" rather than a verdict. anything else - a success, bot
   * detection, a network failure - is about the cookies, so it ends the walk.
   *
   * every note carries a `noteCode` for the same reason the jar problems do:
   * the renderer translates by code, and the english stays what the logs read.
   * the codes: PROBE_PASSED, PROBE_EMPTY, PROBE_REJECTED, PROBE_UNREACHABLE,
   * PROBE_FAILED, PROBE_TARGETS_DOWN.
   *
   * @param {string|null} cookieFile - the jar to force on for the probe
   * @returns {Promise<Object>} {extractionCheck, note, noteCode}
   */
  async probeCookies(cookieFile) {
    let deadTargets = 0

    for (const url of COOKIE_TEST_URLS) {
      try {
        const info = await this.engine.getInfo(url, { cookieFile })

        if (info && info.title) {
          return {
            extractionCheck: "passed",
            noteCode: "PROBE_PASSED",
            note: "the download path worked with your cookies attached. that alone doesn't prove youtube accepted them."
          }
        }

        return {
          extractionCheck: "unknown",
          noteCode: "PROBE_EMPTY",
          note: "the test video came back with nothing."
        }
      } catch (probeError) {
        console.warn(`cookie probe failed for ${url}:`, probeError.message)

        if (probeError.code === ERROR_CODES.VIDEO_UNAVAILABLE) {
          // the target is gone, not a statement about the cookies - next one
          deadTargets++
          continue
        }

        if (probeError.code === ERROR_CODES.BOT_DETECTION) {
          return {
            extractionCheck: "rejected",
            noteCode: "PROBE_REJECTED",
            note: "youtube still asked us to prove we're not a bot while sending your cookies, so they're expired or not being accepted."
          }
        }

        if (probeError.code === ERROR_CODES.NETWORK_ERROR) {
          return {
            extractionCheck: "unknown",
            noteCode: "PROBE_UNREACHABLE",
            note: "couldn't reach youtube, so the cookies went untested."
          }
        }

        return {
          extractionCheck: "unknown",
          noteCode: "PROBE_FAILED",
          note: `the test couldn't finish: ${probeError.message}`
        }
      }
    }

    return {
      extractionCheck: "unknown",
      noteCode: "PROBE_TARGETS_DOWN",
      note: `all ${deadTargets} of our test videos are down right now, so this says nothing about your cookies.`
    }
  }

  // get cookie status
  async handleGetCookieStatus(_event) {
    try {
      const status = await this.cookieManager.getStatus()
      const fileInfo = await this.cookieManager.getFileInfo()
      const usable = this.cookieManager.hasValidCookies()
      // the sentence rather than the ingredients: cookieJarProblem already
      // knows which way a jar is unusable, and a second copy of that in the
      // renderer is the drift the shared parser exists to prevent. an
      // unreadable file reports zero of everything, which is the "nothing
      // imported" branch and the right thing to say
      const problemCode = usable
        ? null
        : cookieJarProblemCode({
            total: fileInfo.cookieCount,
            youtube: fileInfo.youtubeCookieCount || 0,
            expired: fileInfo.expiredCookieCount || 0,
            hasSid: fileInfo.hasSid,
            signedIn: fileInfo.signedIn,
            loadError: fileInfo.loadError ?? null
          })

      return this.createSuccess({
        status,
        fileInfo,
        hasValidCookies: usable,
        problem: problemCode && JAR_PROBLEMS[problemCode],
        problemCode
      })
    } catch (error) {
      console.error("Get cookie status failed:", error.message)
      return this.createError("couldn't read the cookie status")
    }
  }

  // clear cookies
  async handleClearCookies(_event) {
    try {
      const success = await this.cookieManager.clearCookies()

      return this.createSuccess({
        cleared: success,
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Clear cookies failed:", error.message)
      // the jar is still on disk, so this has to reach the user rather than
      // resolve into a screen that says the login is gone
      return this.createError(
        "couldn't remove the cookies, they're still on this machine",
        error.message
      )
    }
  }

  // system health check
  async handleSystemHealth(_event) {
    try {
      const cookieStatus = await this.cookieManager.getStatus()
      const engineVersion = await this.engine.getVersion().catch(() => null)

      return this.createSuccess({
        timestamp: new Date().toISOString(),
        engine: {
          binaryPath: this.engine.getBinaryPath(),
          version: engineVersion,
          ready: Boolean(engineVersion),
          ffmpeg: Boolean(this.engine.getFfmpegPath()),
          deno: Boolean(this.engine.getDenoPath())
        },
        cookies: {
          hasValid: this.cookieManager.hasValidCookies(),
          fileSize: cookieStatus?.fileSize || 0
        },
        downloads: {
          active: this.runner.size,
          total: this.auditLog.filter(
            (log) => log.operation === "download_success"
          ).length
        },
        performance: {
          uptime: Math.floor(process.uptime()),
          memory: process.memoryUsage().heapUsed
        }
      })
    } catch (error) {
      console.error("System health check failed:", error.message)
      return this.createError("System health check failed")
    }
  }

  // open external url
  async handleOpenExternal(_event, data) {
    try {
      this.validateRequest(data, ["url"])
      const { url } = data

      const { shell } = require("electron")
      await shell.openExternal(url)

      return this.createSuccess({ opened: true, url })
    } catch (error) {
      console.error("Open external URL failed:", error.message)
      return this.createError("Failed to open external URL")
    }
  }

  // collect environment info for issue reports
  async handleGetDiagnostics(_event) {
    let ffmpegAvailable = null
    let ytDlpVersion = null

    try {
      ffmpegAvailable = Boolean(this.engine.getFfmpegPath())
      ytDlpVersion = await this.engine.getVersion()
    } catch (error) {
      console.warn("diagnostics: engine status unavailable:", error.message)
    }

    return this.createSuccess({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      ffmpegAvailable,
      ytDlpVersion
    })
  }

  // open user's downloads folder
  async handleOpenDownloadFolder(_event) {
    try {
      const target = await this.settings.ensureDownloadPath()
      const { shell } = require("electron")
      await shell.openPath(target)
      return this.createSuccess({ opened: true, path: target })
    } catch (error) {
      console.error("Open download folder failed:", error.message)
      return this.createError("Failed to open download folder")
    }
  }

  /**
   * show one downloaded file where it landed
   *
   * the panel's "open folder" on a finished row: the file manager opens on its
   * folder with the file selected, which is the difference between this and
   * `handleOpenDownloadFolder` above, and the reason a path has to travel over
   * ipc at all.
   *
   * **which is why the path is checked before anything is revealed.** the
   * renderer is the only caller today and it sends back a `file_path` main
   * itself wrote, but a channel that reveals whatever it is handed is a channel
   * that reveals anything a compromised renderer names. So the path is resolved
   * and compared against the download folder the same way: `path.relative`
   * between the two, refused when it climbs out (`..`) or when it turns out to
   * be absolute, which is what a different drive on windows looks like.
   *
   * lexical containment is not containment on its own, which is what
   * `pathEscapes` is for: a symlink inside the download folder pointing
   * anywhere else would let a name under it pass the string comparison while
   * the file it reaches is somewhere else entirely. The folder the user
   * configured may itself be a link - that one is their own choice - so only
   * what lies below it is walked.
   *
   * `realpath` on the target is deliberately not used: a file that has since
   * been moved would fail for a reason the caller cannot tell apart from the
   * refusals above, and the fallback to the folder is the whole reason the row
   * still works when the file is gone. That case is answered instead by
   * `shown: false`, which is what the row falls back on - `showItemInFolder`
   * returns nothing at all, so a missing file would otherwise be reported as
   * revealed and the row would do nothing at all.
   */
  async handleShowInFolder(_event, data) {
    try {
      this.validateRequest(data, ["path"])

      const target = path.resolve(data.path)
      const root = path.resolve(await this.settings.ensureDownloadPath())
      const inside = path.relative(root, target)

      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
        return this.createError("That file is not in the download folder")
      }

      if (await pathEscapes(root, inside)) {
        return this.createError("That file is not in the download folder")
      }

      try {
        await fs.promises.access(target)
      } catch {
        // gone, moved, or never written where the row remembers it. not a
        // refusal: the row opens the download folder instead
        return this.createSuccess({ shown: false, path: target })
      }

      const { shell } = require("electron")
      shell.showItemInFolder(target)

      return this.createSuccess({ shown: true, path: target })
    } catch (error) {
      console.error("Show in folder failed:", error.message)
      return this.createError("Failed to show that file")
    }
  }

  /**
   * how many downloads this install has finished, ever
   *
   * the counter in memory, which is the same one the completed events carry, so
   * the panel's first number and every number after it come from one place and
   * cannot disagree about a download that finished while this read was in
   * flight.
   *
   * the panel reads it from the list snapshot now (see listSnapshot), which
   * carries it beside the rows; this channel is what the support dialog and any
   * caller that wants the number on its own still ask.
   */
  async handleGetDownloadCount(_event) {
    try {
      // the file has to have been read: answering 0 to the one read the panel
      // makes would put a zero on screen for an install with a hundred
      // downloads behind it, and nothing pushes a correction until the next one
      // finishes
      await this.lifetimeReady

      return this.createSuccess({ count: this.lifetimeCompleted })
    } catch (error) {
      console.error("Get download count failed:", error.message)
      return this.createError("Failed to read the download count")
    }
  }

  // select download folder
  async handleSelectDownloadFolder(_event) {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        title: "Select Download Folder",
        properties: ["openDirectory", "createDirectory"]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return this.createError("No folder selected")
      }

      return this.createSuccess({
        folderPath: result.filePaths[0],
        changed: true
      })
    } catch (error) {
      console.error("Select download folder failed:", error.message)
      return this.createError("Failed to select folder")
    }
  }

  // get current download path
  async handleGetDownloadPath(_event) {
    try {
      return this.createSuccess(await this.settings.getDownloadPathInfo())
    } catch (error) {
      console.error("get download path failed:", error.message)
      return this.createError("failed to get download path")
    }
  }

  // update download folder location
  async handleSetDownloadPath(_event, data) {
    try {
      this.validateRequest(data, ["path"])

      const result = await this.settings.setDownloadPath(data.path)

      if (!result.success) {
        return this.createError(result.error || "failed to set download path")
      }

      return this.createSuccess(await this.settings.getDownloadPathInfo())
    } catch (error) {
      console.error("set download path failed:", error.message)
      return this.createError("failed to set download path")
    }
  }

  // handle check for updates (manual check - always runs)
  async handleCheckForUpdates(_event) {
    try {
      if (!this.autoUpdater) {
        return this.createError(
          "Auto-updater not available",
          "Updates are only available in production builds"
        )
      }

      // manual check always runs
      await this.autoUpdater.checkForUpdates()
      return this.createSuccess({ checking: true })
    } catch (error) {
      console.error("Check for updates failed:", error.message)
      return this.createError(
        "Failed to check for updates",
        "Please try again later"
      )
    }
  }

  // handle download update
  async handleDownloadUpdate(_event) {
    try {
      if (!this.autoUpdater) {
        return this.createError(
          "Auto-updater not available",
          "Updates are only available in production builds"
        )
      }

      await this.autoUpdater.downloadUpdate()
      return this.createSuccess({ downloading: true })
    } catch (error) {
      console.error("Download update failed:", error.message)
      return this.createError(
        "Failed to download update",
        "Please try again later"
      )
    }
  }

  // handle install update
  async handleInstallUpdate(_event) {
    try {
      if (!this.autoUpdater) {
        return this.createError(
          "Auto-updater not available",
          "Updates are only available in production builds"
        )
      }

      // set a flag to indicate we're updating
      global.isUpdating = true

      // use setImmediate to allow the response to be sent before quitting
      setImmediate(() => {
        try {
          console.log("Attempting to quit and install update...")
          this.autoUpdater.quitAndInstall(false, true)
        } catch (error) {
          console.error("quitAndInstall failed:", error)
          // force quit as fallback
          setTimeout(() => {
            console.log("Force quitting app...")
            require("electron").app.quit()
          }, 1000)
        }
      })

      return this.createSuccess({ installing: true })
    } catch (error) {
      console.error("Install update failed:", error.message)
      return this.createError(
        "Failed to install update",
        "Please try again later"
      )
    }
  }

  // handle force security update check (for emergency api key rotation)
  async handleForceSecurityCheck(_event) {
    try {
      if (!this.autoUpdater) {
        return this.createError(
          "Auto-updater not available",
          "Updates are only available in production builds"
        )
      }

      // force check for updates
      await this.autoUpdater.checkForUpdates()
      return this.createSuccess({
        checking: true,
        forced: true,
        reason: "Security check requested"
      })
    } catch (error) {
      console.error("Force security check failed:", error.message)
      return this.createError(
        "Failed to check for security updates",
        "Please try again later"
      )
    }
  }

  // downloads now end with their process, so nothing can linger here
  cleanupExpiredDownloads() {
    return this.runner.size
  }

  // get audit statistics
  getAuditStats() {
    const total = this.auditLog.length
    const successful = this.auditLog.filter((log) => log.success).length
    const failed = total - successful

    return {
      total,
      successful,
      failed,
      successRate: total > 0 ? Math.round((successful / total) * 100) : 0
    }
  }

  // cleanup ipc handlers
  cleanup() {
    // stop any process still running
    this.runner.cancelAll()

    // remove all listeners
    const channels = [
      IPC_CHANNELS.VIDEO_GET_INFO,
      IPC_CHANNELS.VIDEO_DOWNLOAD_COMBINED,
      IPC_CHANNELS.AUDIO_DOWNLOAD,
      IPC_CHANNELS.PLAYLIST_GET_INFO,
      IPC_CHANNELS.PLAYLIST_DOWNLOAD,
      IPC_CHANNELS.DOWNLOAD_CANCEL,
      IPC_CHANNELS.COOKIES_TEST,
      IPC_CHANNELS.COOKIES_STATUS,
      IPC_CHANNELS.UPDATE_CHECK,
      IPC_CHANNELS.UPDATE_DOWNLOAD,
      IPC_CHANNELS.UPDATE_INSTALL,
      "update:force-security-check",
      IPC_CHANNELS.SYSTEM_HEALTH,
      IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL,
      IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS,
      IPC_CHANNELS.ANALYTICS_TRACK,
      "cookies:import-file",
      "cookies:clear",
      "download:get-status",
      "system:open-download-folder",
      "system:show-in-folder",
      "system:select-download-folder",
      "settings:get-download-path",
      "settings:get-download-count",
      "settings:set-download-path"
    ]

    channels.forEach((channel) => {
      ipcMain.removeAllListeners(channel)
    })

    /**
     * an invoke handler is not a listener, and removeAllListeners does not
     * touch it: `ipcMain.handle` keeps its own registry, and `removeHandler` is
     * the only thing that empties it. a channel left registered means the next
     * `handle` for it throws, and until then the old closure - holding the old
     * history and the old runner - is what answers the renderer.
     *
     * the three history channels, and the two the panel's second pass added.
     * every channel above has the same problem and has had it since before
     * this branch; fixing them is its own change, with its own test for each.
     */
    const invokeChannels = [
      "download:get-list",
      "download:clear-history",
      "download:remove-history",
      "system:show-in-folder",
      "settings:get-download-count"
    ]

    invokeChannels.forEach((channel) => {
      ipcMain.removeHandler(channel)
    })
  }
}

module.exports = IPCHandlers
// exported for tests. this function had no seam and no coverage, and shipped
// with a comment describing a distinction the code did not make: a jar youtube
// had signed out was told it was never signed in. the branch is one line and
// the wrong sentence sends the user to fix the wrong thing, so it is worth a
// test even though nothing else imports it
module.exports.cookieJarProblem = cookieJarProblem
module.exports.cookieJarProblemCode = cookieJarProblemCode
