/**
 * app updater - everything between electron-updater and the rest of the app
 *
 * this used to be four loose methods on the app class, and the shape of the
 * bugs they had was always the same: no one place knew *why* a check was
 * running. a background check that 404s on a platform we do not publish for is
 * not news; the identical error from a check the user clicked is the only
 * answer they are going to get. one object that knows which is which is what
 * makes both of those correct at once.
 *
 * the engine updater is a different thing entirely - that one keeps yt-dlp
 * current and lives in services/ytdlp-updater.js. this one replaces Cliply.
 */

const { APP_CONFIG } = require("../utils/constants")
const { describeError } = require("../utils/analytics-helpers")

// the channels the renderer's UpdateNotification listens on
const CHANNELS = {
  CHECKING: "update:checking",
  AVAILABLE: "update:available",
  NOT_AVAILABLE: "update:not-available",
  PROGRESS: "update:download-progress",
  DOWNLOADED: "update:downloaded",
  ERROR: "update:error"
}

/**
 * what a check reports back, so a caller can say something true about it
 *
 * `checking` is the only one that means an update flow is now under way; the
 * rest are all "and that is as far as this goes", each for its own reason.
 */
const CHECK_RESULTS = {
  CHECKING: "checking",
  // this build cannot update itself at all - see canUpdate()
  UNSUPPORTED: "unsupported",
  // there is no update feed to read yet. not an error on a background check
  NO_FEED: "no-feed",
  FAILED: "failed"
}

/**
 * electron-updater's own codes for "there is nothing published to update to".
 *
 * every one of them is the ordinary state of a platform we have not cut a
 * release for yet, and of the hours between tagging and the build finishing.
 * an install that shows an error dialog for that is reporting our release
 * process to the user as their problem.
 */
const NO_FEED_CODES = new Set([
  "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
  "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
  "ERR_UPDATER_INVALID_RELEASE_FEED"
])

// the same condition arriving as text rather than as a code: a raw 404 on the
// channel file, which is what github serves for a tag that has no assets yet
const NO_FEED_PATTERN =
  /\b404\b|no published versions|cannot find channel file|latest[-a-z]*\.yml/i

/**
 * how long to wait before the first background check
 *
 * long enough that the user's first download is not competing with it for the
 * connection, short enough that somebody who leaves the app open still gets
 * told the same session.
 */
const FIRST_CHECK_DELAY_MS = 30 * 1000

class AppUpdater {
  /**
   * @param {Object} options - injected so this is testable without electron
   * @param {Object} options.updater - electron-updater's autoUpdater
   * @param {boolean} options.isPackaged - app.isPackaged
   * @param {string} options.platform - process.platform
   * @param {boolean} options.isAppImage - whether this linux build is an
   *   AppImage, which is the only linux format that can replace itself
   * @param {Function} options.send - (channel, payload) => void
   * @param {Function} options.log - console-ish, injected for the tests
   */
  constructor({
    updater,
    isPackaged = false,
    platform = process.platform,
    isAppImage = false,
    send = () => {},
    log = console
  }) {
    this.updater = updater
    this.isPackaged = isPackaged
    this.platform = platform
    this.isAppImage = isAppImage
    this.send = send
    this.log = log

    /**
     * whether the check now in flight was asked for by a person.
     *
     * electron-updater reports asynchronously through events, so by the time
     * an error arrives the call that caused it is long gone - this is how the
     * error handler knows whether anybody is waiting for an answer.
     */
    this.checkIsManual = false

    this.periodicTimer = null
    this.firstCheckTimer = null
    this.wired = false
    this.installing = false
  }

  /**
   * can this build replace itself at all?
   *
   * three separate no's, and they are not the same no:
   *
   * - **not packaged.** electron-updater refuses outright, and it is right to:
   *   there is no installer to hand a new version to.
   * - **macos.** squirrel.mac verifies the code signature of the running app
   *   before it will swap it, and these builds are unsigned. the update is
   *   still *found* and still offered - as a download link, which is what
   *   `requiresManualDownload` on the available event is for.
   * - **linux, not an AppImage.** a .deb belongs to the package manager and a
   *   tarball belongs to whoever unpacked it; neither is ours to overwrite.
   *
   * @returns {boolean} whether an update can be downloaded and installed here
   */
  canUpdate() {
    if (!this.isPackaged) return false
    if (this.platform === "darwin") return false
    if (this.platform === "linux") return this.isAppImage

    return true
  }

  /**
   * whether a check is worth making at all
   *
   * broader than canUpdate(): a mac build cannot install an update but it can
   * certainly tell the user there is one, which is the whole manual-download
   * path. only an unpackaged build has nothing to say.
   *
   * @returns {boolean}
   */
  canCheck() {
    return this.isPackaged
  }

  /**
   * wire up electron-updater once
   *
   * idempotent on purpose: it is called from app startup and the periodic
   * timer's first fire used to call it again, which subscribed a second copy
   * of every handler and sent the renderer two of every event.
   */
  configure() {
    if (this.wired) return

    const updater = this.updater

    // we decide when to download: a background check that started a download
    // on a metered connection without asking is not a background check
    updater.autoDownload = false

    // flipped to true only once a download has actually landed, so a quit
    // before that can never try to install a half-file
    updater.autoInstallOnAppQuit = false

    /**
     * windows builds are unsigned, so there is no signature for the NSIS
     * updater to check against the running app's. left on, every windows
     * update fails at the last step with a signature error.
     *
     * this is a windows-only option - it has no effect on the other two - and
     * it is exactly as safe as the https download it rides on, which is the
     * same trust the installer was fetched under in the first place.
     */
    updater.verifyUpdateCodeSignature = false

    updater.on("checking-for-update", () => {
      this.send(CHANNELS.CHECKING)
    })

    updater.on("update-available", (info) => this.onUpdateAvailable(info))

    updater.on("update-not-available", () => {
      this.send(CHANNELS.NOT_AVAILABLE)
    })

    updater.on("download-progress", (progress) => {
      this.send(CHANNELS.PROGRESS, {
        percent: Math.round(progress.percent || 0),
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred
      })
    })

    updater.on("update-downloaded", (info) => {
      this.log.log("update downloaded:", info.version)

      // now there is something to install, so a quit may do it
      updater.autoInstallOnAppQuit = true

      this.send(CHANNELS.DOWNLOADED, {
        version: info.version,
        autoInstallOnQuit: true
      })
    })

    updater.on("error", (error) => this.onError(error))

    this.wired = true
  }

  /**
   * an update exists - say so, and start fetching it where we can
   * @param {Object} info - electron-updater's UpdateInfo
   */
  onUpdateAvailable(info) {
    const installable = this.canUpdate()

    this.log.log(
      `update available: ${info.version}`,
      installable ? "- downloading" : "- manual download"
    )

    this.send(CHANNELS.AVAILABLE, {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
      // the renderer branches on these two: one opens the releases page, the
      // other says a download has already started
      requiresManualDownload: !installable,
      autoDownloading: installable,
      platform: this.platform
    })

    if (!installable) return

    this.download().catch((error) => {
      this.log.error("auto-download failed:", describeError(error))
    })
  }

  /**
   * report a failure to whoever is actually waiting for one
   *
   * two kinds of silence here, and both are deliberate:
   *
   * - a **missing feed** is not a failure. it is what every install sees
   *   between a tag and its build finishing, and what a platform we have not
   *   published for sees permanently. the user cannot act on it.
   * - a **background** failure of any kind is not news either. nobody asked;
   *   the next check is twelve hours away and will probably work.
   *
   * both are still logged. what changes is whether a toast interrupts somebody
   * who was not asking a question.
   *
   * @param {Error} error - whatever electron-updater reported
   */
  onError(error) {
    const message = describeError(error)

    if (this.isNoFeed(error)) {
      this.log.log("no update feed published for this platform yet")

      // a manual check still needs an answer, and "you are up to date" is the
      // true one: there is no newer version, because there is no version
      if (this.checkIsManual) {
        this.send(CHANNELS.NOT_AVAILABLE)
      }

      this.checkIsManual = false
      return
    }

    this.log.error("updater error:", message)

    if (this.checkIsManual) {
      this.send(CHANNELS.ERROR, { message })
    }

    this.checkIsManual = false
  }

  /**
   * is this the "nothing has been published" shape?
   * @param {Error} error - whatever electron-updater reported
   * @returns {boolean}
   */
  isNoFeed(error) {
    if (!error) return false

    if (error.code && NO_FEED_CODES.has(error.code)) return true
    if (Number(error.statusCode) === 404) return true

    return NO_FEED_PATTERN.test(describeError(error))
  }

  /**
   * ask whether there is a newer version
   *
   * @param {Object} options - {manual} - true when a person clicked something
   * @returns {Promise<Object>} {status, message} - status is one of CHECK_RESULTS
   */
  async check({ manual = false } = {}) {
    if (!this.canCheck()) {
      return {
        status: CHECK_RESULTS.UNSUPPORTED,
        message: "Updates are only available in installed builds"
      }
    }

    this.configure()

    // a background check must never clear a manual one's flag: the two can
    // overlap, and the person who clicked is the one owed an answer
    this.checkIsManual = this.checkIsManual || manual

    try {
      await this.withRetries(
        () => this.updater.checkForUpdates(),
        APP_CONFIG.UPDATE_CONFIG.MAX_CHECK_RETRIES
      )

      return { status: CHECK_RESULTS.CHECKING }
    } catch (error) {
      // the error event has already fired for this and decided what the user
      // sees; this return is for the caller's own reporting
      const noFeed = this.isNoFeed(error)
      this.checkIsManual = false

      return {
        status: noFeed ? CHECK_RESULTS.NO_FEED : CHECK_RESULTS.FAILED,
        message: describeError(error)
      }
    }
  }

  /**
   * fetch the update this platform can install
   * @returns {Promise<boolean>} whether a download was started
   */
  async download() {
    if (!this.canUpdate()) {
      return false
    }

    await this.withRetries(
      () => this.updater.downloadUpdate(),
      APP_CONFIG.UPDATE_CONFIG.MAX_DOWNLOAD_RETRIES
    )

    return true
  }

  /**
   * quit and let the installer take over
   *
   * the flag is read by the app's own quit path, which skips the teardown that
   * would fight an installer already waiting on this process to exit.
   *
   * @returns {boolean} whether the install was handed off
   */
  install() {
    if (!this.canUpdate()) {
      return false
    }

    this.installing = true
    global.isUpdating = true

    // the ipc reply has to leave before the process starts going away
    setImmediate(() => {
      try {
        this.updater.quitAndInstall(false, true)
      } catch (error) {
        this.log.error("quitAndInstall failed:", describeError(error))
      }
    })

    return true
  }

  /**
   * run something that talks to the network a few times before giving up
   *
   * @param {Function} action - the call to retry
   * @param {number} attempts - how many times in total
   * @returns {Promise<*>} whatever the action resolved with
   */
  async withRetries(action, attempts) {
    let lastError = null

    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      try {
        return await action()
      } catch (error) {
        lastError = error

        // a feed that is not published will not be published by attempt three:
        // retrying it is three times the log noise for the same answer
        if (this.isNoFeed(error) || attempt === attempts) {
          break
        }

        await this.wait(Math.min(1000 * 2 ** (attempt - 1), 10000))
      }
    }

    throw lastError
  }

  // its own method so a test can drive the retry loop without real time
  wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      if (typeof timer.unref === "function") timer.unref()
    })
  }

  /**
   * start checking in the background: once shortly after launch, then daily-ish
   *
   * both timers are unref'd, so neither can hold the process open, and both are
   * cleared on stop() - the old setInterval was neither, which kept a timer
   * alive across a quit that had already torn its services down.
   */
  start() {
    if (!this.canCheck()) {
      this.log.log("app updater: not a packaged build, no checks scheduled")
      return
    }

    this.configure()

    this.firstCheckTimer = setTimeout(() => {
      this.check().catch(() => {})
    }, FIRST_CHECK_DELAY_MS)

    this.periodicTimer = setInterval(() => {
      if (this.installing) return

      this.check().catch(() => {})
    }, APP_CONFIG.UPDATE_CONFIG.PERIODIC_CHECK_INTERVAL)

    for (const timer of [this.firstCheckTimer, this.periodicTimer]) {
      if (timer && typeof timer.unref === "function") timer.unref()
    }
  }

  // called on quit - nothing should fire into a torn-down app
  stop() {
    if (this.firstCheckTimer) {
      clearTimeout(this.firstCheckTimer)
      this.firstCheckTimer = null
    }

    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }
  }
}

module.exports = {
  AppUpdater,
  CHANNELS,
  CHECK_RESULTS,
  NO_FEED_CODES,
  FIRST_CHECK_DELAY_MS
}
