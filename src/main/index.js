// load env vars in dev
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config()
}

const { app, BrowserWindow, Menu, shell, dialog } = require("electron")
const { autoUpdater } = require("electron-updater")
const path = require("path")
const isDev = process.env.NODE_ENV === "development"

// import services
const CookieManager = require("./services/cookie-manager")
const { YtdlpEngine } = require("./services/ytdlp-engine")
const { YtdlpUpdater } = require("./services/ytdlp-updater")
const { SettingsStore } = require("./services/settings-store")
const { Analytics } = require("./services/analytics")
const { AppUpdater } = require("./services/app-updater")
const IPCHandlers = require("./ipc-handlers")
const {
  describeError,
  getAppVersion,
  isFirstLaunch
} = require("./utils/analytics-helpers")

// let the user get their first download going before we check for updates
const UPDATE_CHECK_DELAY_MS = 90 * 1000

// the site the embed player is told it is embedded on. it has to name a real
// site that is not youtube itself - a youtube.com referer is refused as a
// self-referential embed (error 152). see giveYouTubeEmbedsAReferer()
const EMBED_REFERER = "https://cliply.space/"

// what getAppVersion() reports when it cannot read package.json. persisting it
// would poison the launch after this one: it comes back as previous_version,
// where the version grammar rejects it and the property is dropped
const UNKNOWN_VERSION = "unknown"

// how long a drain may hold the quit open. two seconds is a batch leaving on a
// working connection; past that the events are worth less than the wait
const QUIT_FLUSH_TIMEOUT_MS = 2000

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

      // create menu
      this.createMenu()

      this.startAppUpdater()
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

      // the app's own updater - the one that replaces Cliply, as opposed
      // to ytdlpUpdater above, which keeps the download engine current. it is a
      // service like the rest of them so the menu, the ipc layer and the
      // background timer are all driving the same object
      this.services.appUpdater = new AppUpdater({
        updater: autoUpdater,
        isPackaged: app.isPackaged,
        platform: process.platform,
        // the only linux format that can replace itself in place. electron
        // sets APPIMAGE for a running AppImage and nothing else does
        isAppImage: Boolean(process.env.APPIMAGE),
        send: (channel, payload) => this.sendToWindow(channel, payload)
      })

      // init ipc handlers
      this.ipcHandlers = new IPCHandlers(this.services, this.services.appUpdater)

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

  /**
   * begin checking for a new version of Cliply in the background
   *
   * unconditional on purpose: the updater knows for itself whether this build
   * can update at all, so a dev run schedules nothing and says so once, rather
   * than failing a check every twelve hours into a log nobody reads.
   */
  startAppUpdater() {
    this.services.appUpdater.start()
  }

  /**
   * send one event to the renderer, if there is one to send it to
   *
   * the updater is built before the window is, and it keeps sending long after
   * a close - so every path out to the renderer goes through here rather than
   * repeating the destroyed-window check at six call sites, which is where the
   * old code kept forgetting it.
   *
   * @param {string} channel - the ipc channel
   * @param {Object} [payload] - what to send with it
   */
  sendToWindow(channel, payload) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }

    this.mainWindow.webContents.send(channel, payload)
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
          ...(previousVersion ? { previous_version: previousVersion } : {})
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

  /**
   * give youtube's embed player a referer to read
   *
   * the packaged app is served with loadFile(), so the renderer runs under
   * file:// - and chromium sends no Referer at all from a file:// page. the
   * embed player decides playability from that header server-side: without it
   * the response carries an errorScreen instead of a video, which is what the
   * user sees as error 153. dev never hits it because vite serves the same
   * page over http://localhost.
   *
   * scoped to the embed url so no other request the app makes gains a referer
   * it did not have before.
   */
  giveYouTubeEmbedsAReferer() {
    this.mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ["https://www.youtube.com/embed/*"] },
      (details, callback) => {
        callback({
          requestHeaders: {
            ...details.requestHeaders,
            Referer: EMBED_REFERER
          }
        })
      }
    )
  }

  // create main window
  createWindow() {
    // create browser window
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        enableRemoteModule: false,
        webSecurity: false, // for youtube iframe compatibility
        allowRunningInsecureContent: true,
        preload: path.join(__dirname, "..", "preload", "preload.js"),
        sandbox: false,
        experimentalFeatures: false,
        enableBlinkFeatures: "",
        disableBlinkFeatures: "Auxclick"
      },
      icon: this.getAppIcon(),
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default"
    })

    this.giveYouTubeEmbedsAReferer()

    // window event handlers
    this.mainWindow.on("closed", this.onWindowClosed)

    this.mainWindow.on("close", (_event) => {
      // allow close during update
      if (global.isUpdating) {
        return
      }

      // quit the app when close button is clicked (consistent behavior)
      if (!this.isQuitting) {
        this.isQuitting = true
        app.quit()
      }
    })

    // show window when ready
    this.mainWindow.once("ready-to-show", () => {
      this.mainWindow.show()

      if (isDev) {
        this.mainWindow.webContents.openDevTools()
      }
    })

    // load the app
    this.loadApplication()

    // set ipc handlers main window reference
    if (this.ipcHandlers) {
      this.ipcHandlers.setMainWindow(this.mainWindow)
    }
  }

  // load application ui
  loadApplication() {
    if (isDev) {
      // development: load from vite dev server
      const startUrl = "http://localhost:5173"
      this.mainWindow.loadURL(startUrl)
    } else {
      // production: load from packaged files
      const rendererPath = path.join(
        __dirname,
        "renderer",
        "dist",
        "index.html"
      )

      try {
        this.mainWindow.loadFile(rendererPath).catch((error) => {
          console.error(`Failed to load renderer: ${error.message}`)

          // fallback path
          const fallbackPath = path.join(
            process.resourcesPath,
            "app.asar",
            "src",
            "main",
            "renderer",
            "dist",
            "index.html"
          )

          return this.mainWindow
            .loadFile(fallbackPath)
            .catch((fallbackError) => {
              console.error(`Fallback also failed: ${fallbackError.message}`)

              dialog.showErrorBox(
                "Application Error",
                `Failed to load the application interface.\n\nPrimary path: ${rendererPath}\nFallback path: ${fallbackPath}\n\nPlease reinstall the application.`
              )
              app.quit()
            })
        })
      } catch (error) {
        console.error(`Critical error loading application: ${error.message}`)
        dialog.showErrorBox(
          "Critical Error",
          `Cannot start application: ${error.message}`
        )
        app.quit()
      }
    }
  }

  // handle main window closed
  onWindowClosed() {
    this.mainWindow = null
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
        // nothing may fire into an app whose services are being torn down.
        // the old setInterval was never cleared and never unref'd, so a
        // background check could still land after the quit that killed the
        // window it wanted to talk to
        if (this.services.appUpdater) {
          this.services.appUpdater.stop()
        }

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

  // get app icon path
  getAppIcon() {
    const iconName = process.platform === "win32" ? "icon.ico" : "icon.png"
    return path.join(__dirname, "..", "..", "assets", iconName)
  }

  // create application menu
  createMenu() {
    // synchronous on purpose: the menu is built during startup and again after
    // an update lands, and neither moment can wait on a --version probe
    const engineVersion = this.services.ytdlpEngine.getKnownVersion()

    const template = [
      {
        label: "File",
        submenu: [
          {
            label: "New Download",
            accelerator: "CmdOrCtrl+N",
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send("menu:new-download")
              }
            }
          },
          { type: "separator" },
          {
            label: "Open Downloads Folder",
            accelerator: "CmdOrCtrl+D",
            click: async () => {
              try {
                if (this.ipcHandlers) {
                  await this.ipcHandlers.handleOpenDownloadFolder()
                }
              } catch (error) {
                console.error("Failed to open downloads folder:", error)
              }
            }
          },
          { type: "separator" },
          {
            label: "Quit",
            accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
            click: () => {
              app.quit()
            }
          }
        ]
      },
      {
        label: "Edit",
        submenu: [
          { label: "Undo", accelerator: "CmdOrCtrl+Z", role: "undo" },
          { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", role: "redo" },
          { type: "separator" },
          { label: "Cut", accelerator: "CmdOrCtrl+X", role: "cut" },
          { label: "Copy", accelerator: "CmdOrCtrl+C", role: "copy" },
          { label: "Paste", accelerator: "CmdOrCtrl+V", role: "paste" }
        ]
      },
      {
        label: "Tools",
        submenu: [
          {
            label: "Check for Updates",
            click: async () => {
              try {
                if (this.ipcHandlers) {
                  const result = await this.ipcHandlers.handleCheckForUpdates()

                  if (result.success) {
                    // update notification component handles ui feedback
                  } else {
                    console.error("Update check failed:", result.error?.message)
                    dialog.showMessageBox(this.mainWindow, {
                      type: "error",
                      title: "Update Check Failed",
                      message: "Failed to check for updates.",
                      detail:
                        result.error?.message || "Please try again later.",
                      buttons: ["OK"]
                    })
                  }
                } else {
                  dialog.showMessageBox(this.mainWindow, {
                    type: "warning",
                    title: "Update Check Unavailable",
                    message: "Update checking is not available.",
                    detail: "Updates are only available in production builds.",
                    buttons: ["OK"]
                  })
                }
              } catch (error) {
                console.error("Manual update check failed:", error)
                dialog.showErrorBox("Error", "Failed to check for updates.")
              }
            }
          },
          { type: "separator" },
          {
            // which engine this install actually downloads with - the single
            // most useful thing to know before filing an issue, and the same
            // string the report attaches.
            //
            // read from the engine rather than from analytics: telemetry is
            // something the user can switch off, and this line has to stay
            // right when they do. it is deliberately unknown-tolerant - a
            // failed probe leaves us with no version for the whole run, and
            // guessing one would be worse than admitting it
            label: engineVersion
              ? `Video engine: yt-dlp ${engineVersion}`
              : "Video engine: version unknown",
            enabled: false
          },
          { type: "separator" },
          {
            // deliberately not "anonymous". every event carries a persistent
            // install id and a city derived from the ip, which is pseudonymous
            // - and this label is read far more often than PRIVACY.md, so it
            // is where the word would do its damage
            label: "Send usage data",
            type: "checkbox",
            checked: this.services.analytics.isEnabled(),
            click: async (menuItem) => {
              // through the service, never the store: the opt-out gate is only
              // re-read at init(), so writing the preference behind its back
              // leaves this session sending for the rest of its life
              const result = await this.services.analytics.setEnabled(
                menuItem.checked
              )

              // this handler closed over the live MenuItem, and electron neither
              // serialises clicks nor disables the item while one is running -
              // so an older click resuming late acts on the checkbox the NEWEST
              // click left behind, not on its own. a result the service has
              // marked superseded has nothing to say about it, and a dialog
              // naming a click already replaced is noise with no way to tell
              // which click it was about.
              if (result && result.superseded) {
                return
              }

              // a privacy control that silently fails to persist would come
              // back on at the next launch - say so rather than pretend
              if (result && result.success === false) {
                // read from the service, never inverted from the click. a tick
                // derived from isEnabled() cannot disagree with what is
                // actually being sent; one that flips agrees only as long as
                // every path gets the arithmetic right, and it has been wrong
                // twice. note a failed opt-out therefore leaves the tick OFF -
                // the service is inert for this session either way, and it is
                // the dialog that says it will not survive a restart.
                menuItem.checked = this.services.analytics.isEnabled()
                dialog.showMessageBox(this.mainWindow, {
                  type: "error",
                  title: "Couldn't save that preference",
                  message: "Your analytics preference could not be saved.",
                  detail: result.error || "Please try again.",
                  buttons: ["OK"]
                })
              }
            }
          }
        ]
      },
      {
        label: "View",
        submenu: [
          { label: "Reload", accelerator: "CmdOrCtrl+R", role: "reload" },
          {
            label: "Force Reload",
            accelerator: "CmdOrCtrl+Shift+R",
            role: "forceReload"
          },
          {
            label: "Toggle Developer Tools",
            accelerator: "F12",
            role: "toggleDevTools"
          },
          { type: "separator" },
          {
            label: "Actual Size",
            accelerator: "CmdOrCtrl+0",
            role: "resetZoom"
          },
          { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", role: "zoomIn" },
          { label: "Zoom Out", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
          { type: "separator" },
          {
            label: "Toggle Fullscreen",
            accelerator: "F11",
            role: "togglefullscreen"
          }
        ]
      },
      {
        label: "Window",
        submenu: [
          { label: "Minimize", accelerator: "CmdOrCtrl+M", role: "minimize" },
          { label: "Close", accelerator: "CmdOrCtrl+W", role: "close" }
        ]
      },
      {
        label: "Help",
        submenu: [
          {
            label: "About Cliply",
            click: () => {
              dialog.showMessageBox(this.mainWindow, {
                type: "info",
                title: "About Cliply",
                message: "Cliply Desktop",
                detail: `Version: ${getAppVersion()}\n\nYour fave little desktop app; powered by open source tools (>ᴗ•)`,
                buttons: ["OK"]
              })
            }
          },
          {
            label: "System Health",
            click: async () => {
              try {
                if (this.ipcHandlers) {
                  const health = await this.ipcHandlers.handleSystemHealth()

                  const message = health.success
                    ? `System Status: Healthy\n\nDownloader: ${
                        health.data.engine.version || "Unknown"
                      }\nFFmpeg: ${
                        health.data.engine.ffmpeg ? "Found" : "Missing"
                      }\nCookies: ${
                        health.data.cookies.hasValid ? "Valid" : "Invalid"
                      }\nActive downloads: ${
                        health.data.downloads.active
                      }\nUptime: ${Math.floor(
                        health.data.performance.uptime / 60
                      )} minutes`
                    : `System Status: Error\n\n${health.error.message}`

                  dialog.showMessageBox(this.mainWindow, {
                    type: health.success ? "info" : "error",
                    title: "System Health",
                    message,
                    buttons: ["OK"]
                  })
                }
              } catch (error) {
                console.error("System health check failed:", error)
                dialog.showErrorBox("Error", "Failed to check system health.")
              }
            }
          },
          { type: "separator" },
          {
            label: "Report Issue",
            click: () => {
              shell.openExternal("https://github.com/Cliply/Cliply/issues")
            }
          }
        ]
      }
    ]

    // macos menu adjustments
    if (process.platform === "darwin") {
      template.unshift({
        label: app.getName(),
        submenu: [
          { label: "About " + app.getName(), role: "about" },
          { type: "separator" },
          { label: "Services", role: "services", submenu: [] },
          { type: "separator" },
          {
            label: "Hide " + app.getName(),
            accelerator: "Command+H",
            role: "hide"
          },
          {
            label: "Hide Others",
            accelerator: "Command+Shift+H",
            role: "hideothers"
          },
          { label: "Show All", role: "unhide" },
          { type: "separator" },
          { label: "Quit", accelerator: "Command+Q", click: () => app.quit() }
        ]
      })

      // window menu
      template[5].submenu = [
        { label: "Close", accelerator: "CmdOrCtrl+W", role: "close" },
        { label: "Minimize", accelerator: "CmdOrCtrl+M", role: "minimize" },
        { label: "Zoom", role: "zoom" },
        { type: "separator" },
        { label: "Bring All to Front", role: "front" }
      ]
    }

    // kept so noteEngineVersion can tell "the menu is up and now reads wrong"
    // from "startup has not built one yet"
    this.menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(this.menu)
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
