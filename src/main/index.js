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
const IPCHandlers = require("./ipc-handlers")
const { APP_CONFIG } = require("./utils/constants")
const { getAppVersion, isFirstLaunch } = require("./utils/analytics-helpers")

// let the user get their first download going before we check for updates
const UPDATE_CHECK_DELAY_MS = 90 * 1000

// what getAppVersion() reports when it cannot read package.json. persisting it
// would poison the launch after this one: it comes back as previous_version,
// where the version grammar rejects it and the property is dropped
const UNKNOWN_VERSION = "unknown"

// how long a drain may hold the quit open. two seconds is a batch leaving on a
// working connection; past that the events are worth less than the wait
const QUIT_FLUSH_TIMEOUT_MS = 2000

class CliplyApp {
  constructor() {
    this.mainWindow = null
    this.services = {}
    this.ipcHandlers = null
    this.isQuitting = false
    // set once the shutdown drain has run, so the quit it re-issues is not
    // cancelled a second time
    this.hasShutDown = false

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

      // create menu
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

      // make sure userData holds a runnable binary before anything needs it
      const seeded = await this.services.ytdlpUpdater.seed()
      console.log("yt-dlp engine:", this.services.ytdlpEngine.getBinaryPath(), seeded)

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
        this.services.ytdlpUpdater
          .checkForUpdate()
          .then((result) => console.log("yt-dlp update check:", result))
          .catch((error) =>
            console.warn("yt-dlp update check failed:", error.message)
          )
      }, UPDATE_CHECK_DELAY_MS)
      updateCheckTimer.unref()
    } catch (error) {
      console.error("Service initialization failed:", error)
      throw error
    }
  }

  // setup auto-updater
  setupAutoUpdater() {
    try {
      // configure auto-updater
      autoUpdater.checkForUpdatesAndNotify = false
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false

      // disable code signature verification for unsigned builds
      autoUpdater.verifyUpdateCodeSignature = false

      // checking for updates
      autoUpdater.on("checking-for-update", () => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("update:checking")
        }
      })

      // update available - handle based on platform
      autoUpdater.on("update-available", (info) => {
        const isMac = process.platform === "darwin"

        if (isMac) {
          console.log(
            "Update available:",
            info.version,
            "- showing manual download for macOS"
          )

          // macOS: Show manual download popup
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send("update:available", {
              version: info.version,
              releaseNotes: info.releaseNotes,
              releaseDate: info.releaseDate,
              requiresManualDownload: true,
              platform: "darwin"
            })
          }
        } else {
          console.log(
            "Update available:",
            info.version,
            "- auto-downloading..."
          )

          // Windows/Linux: Auto-download as before
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send("update:available", {
              version: info.version,
              releaseNotes: info.releaseNotes,
              releaseDate: info.releaseDate,
              autoDownloading: true
            })
          }

          // auto-download for non-macOS platforms
          this.downloadUpdateWithRetry().catch((error) => {
            console.error("Auto-download failed:", error)
          })
        }
      })

      // update not available
      autoUpdater.on("update-not-available", () => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("update:not-available")
        }
      })

      // download progress
      autoUpdater.on("download-progress", (progress) => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("update:download-progress", {
            percent: Math.round(progress.percent),
            bytesPerSecond: progress.bytesPerSecond,
            total: progress.total,
            transferred: progress.transferred
          })
        }
      })

      // update downloaded - enable auto-install on quit for all updates
      autoUpdater.on("update-downloaded", (info) => {
        console.log("Update downloaded:", info.version, "- ready to install")

        // enable auto-install on quit for all updates
        autoUpdater.autoInstallOnAppQuit = true

        // notify renderer that update is ready
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("update:downloaded", {
            version: info.version,
            autoInstallOnQuit: true
          })
        }
      })

      // error
      autoUpdater.on("error", (error) => {
        console.error("Auto-updater error:", error.message)
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("update:error", {
            message: error.message
          })
        }
      })

      // check for updates after app ready
      app.whenReady().then(() => {
        const shouldCheck = isDev || Math.random() < 0.9

        if (shouldCheck) {
          setTimeout(() => {
            this.checkForUpdatesWithRetry().catch((error) => {
              console.error("Failed to check for updates:", error)
            })
          }, 3000)
        }

        // setup periodic update checks every 12 hours
        this.setupPeriodicUpdateChecks()
      })
    } catch (error) {
      console.error("Auto-updater setup failed:", error)
    }
  }

  // retry logic for update checks
  async checkForUpdatesWithRetry(
    maxRetries = APP_CONFIG.UPDATE_CONFIG.MAX_CHECK_RETRIES
  ) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await autoUpdater.checkForUpdates()
        return
      } catch (error) {
        console.error(`Update check attempt ${attempt} failed:`, error.message)

        if (attempt === maxRetries) {
          throw error
        }

        // wait before retry (exponential backoff)
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  // retry logic for update downloads
  async downloadUpdateWithRetry(
    maxRetries = APP_CONFIG.UPDATE_CONFIG.MAX_DOWNLOAD_RETRIES
  ) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await autoUpdater.downloadUpdate()
        return
      } catch (error) {
        console.error(
          `Update download attempt ${attempt} failed:`,
          error.message
        )

        if (attempt === maxRetries) {
          throw error
        }

        // wait before retry
        const delay = 2000 * attempt
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  // setup periodic update checks
  setupPeriodicUpdateChecks() {
    // check every 12 hours using config
    const checkInterval = APP_CONFIG.UPDATE_CONFIG.PERIODIC_CHECK_INTERVAL

    setInterval(() => {
      // only check if app is not quitting and in production
      if (!this.isQuitting && !isDev) {
        console.log("Performing periodic update check...")
        this.checkForUpdatesWithRetry().catch((error) => {
          console.error("Periodic update check failed:", error)
        })
      }
    }, checkInterval)
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

    // skip cleanup if updating
    if (global.isUpdating) {
      return
    }

    // the quit we re-issued below, arriving back here
    if (this.hasShutDown) {
      return
    }

    this.hasShutDown = true

    if (event && typeof event.preventDefault === "function") {
      event.preventDefault()
    }

    try {
      // update cleanup
      this.updateState.isCheckingForUpdates = false

      // kill any running yt-dlp process - partial .part files stay resumable
      if (this.services.ytdlpEngine) {
        const cancelled = this.services.ytdlpEngine.cancelAll()
        if (cancelled > 0) {
          console.log(`cancelled ${cancelled} running download(s) on quit`)
        }
      }

      // batched events are lost if we exit without draining them. capped,
      // because a flush that cannot finish must not leave the app refusing to
      // close - telemetry is never worth that
      if (this.services.analytics) {
        let flushTimer = null

        await Promise.race([
          this.services.analytics.flush(),
          new Promise((resolve) => {
            flushTimer = setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS)
          })
        ])

        // the cap loses the race far more often than it wins it, and a timer
        // left armed behind a won race holds the loop open for two more seconds
        clearTimeout(flushTimer)
      }

      // cleanup ipc handlers
      if (this.ipcHandlers) {
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
            label: "Send anonymous usage data",
            type: "checkbox",
            checked: this.services.analytics.isEnabled(),
            click: async (menuItem) => {
              // through the service, never the store: the opt-out gate is only
              // re-read at init(), so writing the preference behind its back
              // leaves this session sending for the rest of its life
              const result = await this.services.analytics.setEnabled(
                menuItem.checked
              )

              // a privacy control that silently fails to persist would come
              // back on at the next launch - say so rather than pretend
              if (result && result.success === false) {
                menuItem.checked = !menuItem.checked
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

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)
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
