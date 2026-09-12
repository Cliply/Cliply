// load env vars in dev
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config()
}

const { app, BrowserWindow, shell, dialog } = require("electron")
const { autoUpdater } = require("electron-updater")
const path = require("path")
const isDev = process.env.NODE_ENV === "development"

// import services
const CookieManager = require("./services/cookie-manager")
const { YtdlpEngine } = require("./services/ytdlp-engine")
const { YtdlpUpdater } = require("./services/ytdlp-updater")
const { PotInstaller } = require("./services/pot-installer")
const { SettingsStore } = require("./services/settings-store")
const { Analytics } = require("./services/analytics")
const IPCHandlers = require("./ipc-handlers")
const {
  describeError,
  getAppVersion,
  isFirstLaunch
} = require("./utils/analytics-helpers")
const { createMenu } = require("./menu")
const {
  setupAutoUpdater,
  checkForUpdatesWithRetry,
  downloadUpdateWithRetry,
  setupPeriodicUpdateChecks
} = require("./auto-updater")
const {
  giveYouTubeEmbedsAReferer,
  createWindow,
  loadApplication,
  onWindowClosed,
  getAppIcon
} = require("./window")

// let the user get their first download going before we check for updates
const UPDATE_CHECK_DELAY_MS = 90 * 1000

// what getAppVersion() reports when it cannot read package.json. persisting it
// would poison the launch after this one: it comes back as previous_version,
// where the version grammar rejects it and the property is dropped
const UNKNOWN_VERSION = "unknown"

// how long a drain may hold the quit open. two seconds is a batch leaving on a
// working connection; past that the events are worth less than the wait
const QUIT_FLUSH_TIMEOUT_MS = 2000

// and how long the download history may. one rename is milliseconds, so this
// is not a budget but a stop: past it the history is stuck on something, and a
// user holding a closed window is paying for a row's wording
const QUIT_HISTORY_TIMEOUT_MS = 2000

/**
 * what an update check reports when nothing went wrong: the engine was already
 * current, or it just became current without the version changing. every other
 * reason is one the engine did not update, which is what engine_update_failed
 * exists to explain - including "busy", where the check never ran at all.
 */
const ENGINE_CURRENT_REASONS = new Set(["up-to-date", "completed"])

class CliplyApp {
  constructor() {
    this.mainWindow = null
    this.services = {}
    this.ipcHandlers = null
    this.isQuitting = false
    // set once the shutdown drain has run, so the quit it re-issues is not
    // cancelled a second time
    this.hasShutDown = false
    // the 12-hour update-check interval, held so the quit can clear it
    this.periodicUpdateTimer = null

    // update handling
    this.updateState = {
      lastCheckTime: null,
      isCheckingForUpdates: false
    }

    // bind methods
    this.createWindow = this.createWindow.bind(this)
    this.onWindowClosed = this.onWindowClosed.bind(this)
    this.onBeforeQuit = this.onBeforeQuit.bind(this)
  }

  // init the app
  async initialize() {
    try {
      await this.validateEnvironment()
      this.checkSupportedArchitecture()

      // set app properties
      app.setName("Cliply")
      app.setVersion(getAppVersion())

      // init services
      await this.initializeServices()

      // setup app event handlers
      this.setupAppEvents()

      // create menu. after ready, because the menu is labelled from
      // app.getLocale(), which answers with an empty string before it - and
      // services can finish first on a fast machine
      await app.whenReady()
      this.createMenu()

      // setup auto-updater in production
      if (!isDev) {
        this.setupAutoUpdater()
      }
    } catch (error) {
      console.error("Failed to initialize Cliply Desktop:", error)
      dialog.showErrorBox(
        "Initialization Error",
        `Failed to start Cliply Desktop:\n\n${error.message}`
      )
      app.quit()
    }
  }

  // validate environment
  async validateEnvironment() {
    try {
      // basic validation
    } catch (error) {
      console.error("Environment validation failed:", error)
      throw error
    }
  }

  // Intel Macs are unsupported: the bundled FFmpeg is arm64-only, so a
  // download would eventually fail with a cryptic "ffmpeg exited with code N"
  // instead we exit early with a clear message.
  checkSupportedArchitecture() {
    if (process.platform !== "darwin") return
    if (process.arch === "arm64") return

    const message = "Cliply requires an Apple Silicon Mac (M1, M2, M3, or later)."
    const detail =
      "Intel-based Macs aren't supported by this build. " +
      "The bundled video engine is compiled for Apple Silicon only. " +
      "You can follow Intel support progress on our GitHub issues."

    console.error(`${message} Detected arch: ${process.arch}`)
    dialog.showErrorBox(message, detail)
    app.exit(1)
  }

  // init services
  async initializeServices() {
    try {
      const resourcesPath = isDev
        ? path.join(__dirname, "..", "..")
        : process.resourcesPath

      // one settings store for the whole main process. ipc-handlers falls back
      // to constructing its own when the bag does not carry one, and two of
      // them means two install id mints racing over the same file - so it is
      // built here, before anything that reads it
      this.services.settingsStore = new SettingsStore()

      // analytics - one exit point for all telemetry. first, so that everything
      // below it can report, and awaited, so nothing captures into a service
      // that has not read the opt-out yet
      this.services.analytics = new Analytics({
        settingsStore: this.services.settingsStore
      })
      await this.services.analytics.init()

      // init cookie manager
      this.services.cookieManager = new CookieManager()
      await this.services.cookieManager.initialize()

      // init the yt-dlp engine - every download flow runs on the binary
      this.services.ytdlpEngine = new YtdlpEngine({
        resourcesPath,
        cookieManager: this.services.cookieManager
      })
      this.services.ytdlpUpdater = new YtdlpUpdater({
        engine: this.services.ytdlpEngine
      })

      // an install that was refused before is still refused now - the block
      // follows the connection, not the session - so the escalation is read
      // back before the first operation rather than rediscovered by failing
      // again. the store expires it on its own after a week, so a stale `true`
      // never survives here as one
      this.services.ytdlpEngine.setPotEnabled(
        await this.services.settingsStore.isPotEnabled()
      )

      // nothing is fetched here - it is built now and asked for later, by the
      // first refusal that finds the payload missing
      this.services.potInstaller = new PotInstaller({
        engine: this.services.ytdlpEngine
      })

      this.notePotEnvironment()

      // make sure userData holds a runnable binary before anything needs it
      const seeded = await this.services.ytdlpUpdater.seed()
      console.log("yt-dlp engine:", this.services.ytdlpEngine.getBinaryPath(), seeded)

      // whatever the seed decided, the version it reports is the engine this
      // session runs on - and the probe happens once, so this is the only
      // chance to hand it on. a refusal reports no version at all, which both
      // consumers ignore rather than storing
      this.noteEngineVersion(seeded.version)

      if (seeded.seeded) {
        this.services.analytics.capture("engine_seeded", {
          reason: seeded.reason,
          engine_version: seeded.version
        })
      }

      // init ipc handlers
      this.autoUpdater = autoUpdater
      this.ipcHandlers = new IPCHandlers(this.services, this.autoUpdater)

      // background update check, deferred
      //
      // the update holds the engine gate until it finishes, and the user's very
      // first action would otherwise queue behind it - which reads as a frozen
      // app on a slow connection. giving them a head start costs nothing: if
      // they are busy when the timer fires the check simply refuses and runs
      // next launch.
      const updateCheckTimer = setTimeout(() => {
        this.checkForEngineUpdate()
      }, UPDATE_CHECK_DELAY_MS)
      updateCheckTimer.unref()
    } catch (error) {
      console.error("Service initialization failed:", error)
      throw error
    }
  }

  /**
   * tell analytics what this install could mint a PO token with
   *
   * both answers are read from the engine rather than passed in, because the
   * engine is what actually decides: it is the same two lookups buildCommonArgs
   * gates the flags on, so what is reported is what was used rather than a
   * second opinion about it.
   */
  notePotEnvironment() {
    this.services.analytics.setPotEnvironment({
      denoPresent: Boolean(this.services.ytdlpEngine.getDenoPath()),
      potProvider: Boolean(this.services.ytdlpEngine.getPotPaths())
    })
  }

  /**
   * pass a freshly probed engine version to everything that shows it
   *
   * the engine service is where this lives. analytics is a consumer of it and
   * not its home: the user can switch telemetry off, and the menu and the
   * issue report still have to be able to say what is running when they do.
   *
   * @param {string} version - what the seed or the update probed, if anything
   */
  noteEngineVersion(version) {
    const shown = this.services.ytdlpEngine.getKnownVersion()

    this.services.ytdlpEngine.rememberVersion(version)
    this.services.analytics.setEngineVersion(version)

    // the menu was built from whatever we knew at startup, and an update lands
    // long after that. a menu item's label is copied into the native menu when
    // the item is inserted - there is no delegate that reads it back - so the
    // only way to correct the line is to build the menu again.
    if (this.menu && this.services.ytdlpEngine.getKnownVersion() !== shown) {
      this.createMenu()
    }
  }

  /**
   * run the deferred engine update check and say what came of it
   * @returns {Promise<void>} resolves however the check went
   */
  checkForEngineUpdate() {
    return this.services.ytdlpUpdater
      .checkForUpdate()
      .then((result) => {
        console.log("yt-dlp update check:", result)
        this.reportEngineUpdate(result)
      })
      .catch((error) => {
        // the check threw rather than reporting - probeVersion rejecting, a
        // rename that could not be recovered. an install that cannot even ask
        // whether its engine is stale is the silent degradation this event
        // exists to surface, and nothing else in the pipeline says so
        //
        // read through describeError, because `.message` is a property access
        // and a getter can throw - here, inside the catch, where the event this
        // is trying to send is what pays for it. nothing thrown at all is still
        // absence, which is what the omitted property says
        const message = error ? describeError(error) : null

        console.warn("yt-dlp update check failed:", message)
        this.reportEngineUpdate({ reason: "check-rejected", error: message })
      })
  }

  /**
   * turn an update check's result into at most one event
   *
   * a stale engine is what breaks downloads, so the question here is not "did
   * the update work" but "is there a reason this install is not on the newest
   * engine". a refusal counts as one; being current already does not.
   *
   * @param {Object} result - what checkForUpdate() returned
   */
  reportEngineUpdate(result) {
    if (!result) return

    if (result.updated) {
      this.services.analytics.capture("engine_updated", {
        // a probe that failed leaves no from-version. absence says that,
        // where a null pretends there was a value to send
        ...(result.from ? { from_version: result.from } : {}),
        to_version: result.to
      })
      this.noteEngineVersion(result.to)
      return
    }

    if (!result.reason || ENGINE_CURRENT_REASONS.has(result.reason)) return

    this.services.analytics.capture("engine_update_failed", {
      update_reason: result.reason,
      ...(result.error ? { error_message: result.error } : {})
    })
  }

  setupAutoUpdater() {
    return setupAutoUpdater(this)
  }

  checkForUpdatesWithRetry(maxRetries) {
    return checkForUpdatesWithRetry(maxRetries)
  }

  downloadUpdateWithRetry(maxRetries) {
    return downloadUpdateWithRetry(maxRetries)
  }

  setupPeriodicUpdateChecks() {
    return setupPeriodicUpdateChecks(this)
  }

  // setup app event handlers
  setupAppEvents() {
    // app ready
    app.whenReady().then(() => {
      this.createWindow()
      this.reportLaunch()

      // macos: re-create window when dock icon clicked
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          this.createWindow()
        }
      })
    })

    // all windows closed
    app.on("window-all-closed", () => {
      // macos: keep app running when all windows closed
      if (process.platform !== "darwin") {
        app.quit()
      }
    })

    // before quit
    app.on("before-quit", this.onBeforeQuit)

    // second instance
    app.on("second-instance", () => {
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore()
        this.mainWindow.focus()
      }
    })

    // web contents security
    app.on("web-contents-created", (event, contents) => {
      // prevent navigation to external urls
      contents.on("will-navigate", (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl)

        if (parsedUrl.origin !== "http://localhost:5173" && isDev) {
          // allow dev server in development
        } else if (!isDev && !navigationUrl.startsWith("file://")) {
          event.preventDefault()
        }
      })

      // prevent new window creation
      contents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url)
        return { action: "deny" }
      })

      // disable node integration in new webcontents
      contents.on("new-window", (event) => {
        event.preventDefault()
      })
    })
  }

  /**
   * send app_launched, then record this version for the next launch to read.
   *
   * the stored version has to be read before it is overwritten - that ordering
   * is the whole of what makes previous_version meaningful, and it is how an
   * upgrade becomes visible in the data.
   */
  /**
   * does this install currently hold a signed-in youtube jar?
   *
   * never throws: a launch report is not worth losing over a dimension, and an
   * unreadable jar is a false rather than a missing answer - it is not signed
   * in either way.
   *
   * @returns {boolean}
   */
  cookiesSignedIn() {
    try {
      return Boolean(this.services.cookieManager?.hasValidCookies())
    } catch {
      return false
    }
  }

  reportLaunch() {
    return this.services.settingsStore
      .readAll()
      .then((settings) => {
        const previousVersion = settings.last_version

        this.services.analytics.capture("app_launched", {
          is_first_launch: isFirstLaunch(),
          // spread rather than `|| null`: a first launch genuinely has no
          // previous version, and absence says that where a null pretends
          // there was a value to send
          ...(previousVersion ? { previous_version: previousVersion } : {}),
          /**
           * how many installs actually have working cookies, asked once a
           * launch.
           *
           * cookies_imported answers "who imported, ever" - a one-off event
           * that never expires, so a jar youtube rotated out three weeks ago
           * still counts as an import forever. This is the standing figure:
           * of the installs running today, what share are signed in right now.
           * The gap between the two is the re-import problem, and without this
           * event there is no way to see it.
           */
          cookies_signed_in: this.cookiesSignedIn()
        })

        const version = getAppVersion()

        if (!version || version === UNKNOWN_VERSION) {
          return
        }

        return this.services.settingsStore.writeSettings({
          last_version: version
        })
      })
      .catch(() => {
        // a settings read or write failure must never stop the app launching
      })
  }

  giveYouTubeEmbedsAReferer() {
    return giveYouTubeEmbedsAReferer(this)
  }

  createWindow() {
    return createWindow(this)
  }

  loadApplication() {
    return loadApplication(this)
  }

  onWindowClosed() {
    return onWindowClosed(this)
  }

  /**
   * handle before quit
   *
   * electron does not await an async before-quit listener: it carries on
   * tearing the process down the moment this returns at its first await, which
   * is before a batched analytics flush has left the machine. so the first pass
   * cancels the quit, drains, and quits again - the second pass sees the flag
   * and lets it through.
   * @param {Object} [event] - electron's before-quit event
   */
  async onBeforeQuit(event) {
    this.isQuitting = true

    // the quit we re-issued below, arriving back here
    if (this.hasShutDown) {
      return
    }

    this.hasShutDown = true

    // cleared unconditionally, install or not: the check it would fire is
    // already refused by the isQuitting flag above, so all an armed interval
    // can do from here is outlive the work
    if (this.periodicUpdateTimer) {
      clearInterval(this.periodicUpdateTimer)
      this.periodicUpdateTimer = null
    }

    /**
     * installing an update is still a quit, and it is the quit whose last
     * events matter most: it is the boundary between two versions, which is
     * the whole reason previous_version exists. so it drains like any other.
     *
     * what it skips is the teardown that would fight the installer - killing
     * the running downloads and tearing down ipc. cancelling this quit is safe
     * for the installer itself: electron-updater has already spawned it by the
     * time it calls app.quit() (BaseUpdater.quitAndInstall installs first, then
     * quits from a setImmediate), the spawned installer waits on this process
     * to exit, and its own quitAndInstallCalled guard means the second quit
     * below cannot start a second install.
     */
    const installing = Boolean(global.isUpdating)

    if (event && typeof event.preventDefault === "function") {
      event.preventDefault()
    }

    try {
      // update cleanup and the engine shutdown wait both only apply to an
      // ordinary quit - an install-triggered one skips the teardown that
      // would fight the installer, per the comment above
      let shutdownPromise = Promise.resolve()

      if (!installing) {
        this.updateState.isCheckingForUpdates = false

        // an install quit skips this with the rest of the teardown: nothing is
        // being cancelled there, so there is nothing to get in front of, and
        // the rows are marked at the next launch by load() instead
        await this.markDownloadsInterrupted()

        // kill any running yt-dlp process and actually wait for the tree to
        // exit - partial .part files stay resumable either way, but a wait
        // shorter than the engine's own sigterm->sigkill escalation would let
        // this process quit before that escalation ever fires, orphaning
        // whatever the signal alone did not clean up. runs alongside the
        // analytics flush below rather than after it, so a quit with nothing
        // in flight is not slowed down by a wait that resolves instantly
        if (this.services.ytdlpEngine) {
          shutdownPromise = this.services.ytdlpEngine
            .awaitShutdown()
            .then((cancelled) => {
              if (cancelled > 0) {
                console.log(`cancelled ${cancelled} running download(s) on quit`)
              }
            })
        }
      }

      // batched events are lost if we exit without draining them. capped,
      // because a flush that cannot finish must not leave the app refusing to
      // close - telemetry is never worth that, and least of all when an
      // installer is waiting on this process to go
      let analyticsPromise = Promise.resolve()

      if (this.services.analytics) {
        let flushTimer = null

        analyticsPromise = Promise.race([
          this.services.analytics.flush(),
          new Promise((resolve) => {
            flushTimer = setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS)
          })
        ]).then(() => {
          // the cap loses the race far more often than it wins it, and a timer
          // left armed behind a won race holds the loop open for two more
          // seconds
          clearTimeout(flushTimer)
        })
      }

      await Promise.all([shutdownPromise, analyticsPromise])

      // cleanup ipc handlers
      if (!installing && this.ipcHandlers) {
        this.ipcHandlers.cleanup()
      }
    } catch (error) {
      console.error("Error during shutdown:", error)
    }

    // outside the try: whatever went wrong above, the app still has to quit
    app.quit()
  }

  /**
   * write down what was still running, before anything kills it
   *
   * the cancels that follow settle every live download as `cancelled` a moment
   * before the process goes, and the user would reopen the app to rows they
   * never cancelled. marked first, the history drops those late writes (see
   * upsert in services/download-history.js) and the rows say `interrupted`,
   * which is what happened. so this keeps its place ahead of the shutdown.
   *
   * what it does not keep is the power to stop the quit. it is one rename, and
   * everything after it - the engine shutdown, the analytics drain, the ipc
   * teardown and the second app.quit() - matters more than the wording on a
   * row: a history stuck on a write it will never finish, or one that rejects,
   * costs the marking and nothing else. its own cap, because the analytics one
   * is armed later and would not cover a phase that runs before it.
   *
   * @returns {Promise<void>} settles when the history has been marked, or when
   *   the cap says to stop waiting for it
   */
  async markDownloadsInterrupted() {
    const history = this.ipcHandlers && this.ipcHandlers.history

    if (!history) {
      return
    }

    let historyTimer = null

    try {
      await Promise.race([
        history.interruptLive(),
        new Promise((resolve) => {
          historyTimer = setTimeout(resolve, QUIT_HISTORY_TIMEOUT_MS)
        })
      ])
    } catch (error) {
      // caught here rather than by the shutdown's own catch, which would take
      // the whole teardown down with it
      console.warn(
        "could not mark the running downloads as interrupted:",
        error && error.message
      )
    } finally {
      // a timer left armed behind a won race holds the loop open for two more
      // seconds, which is the thing this cap exists to prevent
      clearTimeout(historyTimer)
    }
  }

  getAppIcon() {
    return getAppIcon()
  }

  createMenu() {
    return createMenu(this)
  }
}

// single instance enforcement
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  console.log("Another instance is already running. Quitting...")
  app.quit()
} else {
  // create and init the app
  const cliplyApp = new CliplyApp()
  cliplyApp.initialize()
}

// error handling
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error)

  const sanitizedMessage = error.message

  dialog.showErrorBox(
    "Unexpected Error",
    `An unexpected error occurred:\n\n${sanitizedMessage}`
  )
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
})

module.exports = CliplyApp
