// load env vars in dev
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config()
}

const { app, BrowserWindow, Menu, shell, dialog } = require("electron")
const { autoUpdater } = require("electron-updater")
const { EventEmitter } = require("events")
const path = require("path")
const isDev = process.env.NODE_ENV === "development"

// import services
const ServerManager = require("./services/server-manager")
const CookieManager = require("./services/cookie-manager")
const IPCHandlers = require("./ipc-handlers")
const { APP_CONFIG } = require("./utils/constants")
const { getAppVersion } = require("./utils/analytics-helpers")

// analytics
let trackEvent = null
if (APP_CONFIG.ANALYTICS_CONFIG.ENABLED) {
  try {
    const {
      initialize,
      trackEvent: aptabaseTrackEvent
    } = require("@aptabase/electron/main")
    initialize(APP_CONFIG.ANALYTICS_CONFIG.APP_KEY)
    trackEvent = aptabaseTrackEvent
    // make globally available
    global.trackEvent = trackEvent
    console.log("Analytics initialized")
  } catch (error) {
    console.warn("Failed to initialize analytics:", error.message)
    trackEvent = () => {}
    global.trackEvent = trackEvent
  }
} else {
  trackEvent = () => {}
  global.trackEvent = trackEvent
}

// Configure undici defaults globally to prevent HeadersTimeoutError
const { setGlobalDispatcher, Agent } = require('undici')

// Create agent with no timeouts for long downloads
const agent = new Agent({
  headersTimeout: 0, // No headers timeout  
  bodyTimeout: 0,    // No body timeout
  connectTimeout: 30000 // Keep connection timeout only
})

setGlobalDispatcher(agent)

class CliplyApp {
  constructor() {
    this.mainWindow = null
    this.services = {}
    this.ipcHandlers = null
    this.isQuitting = false

    // event emitter for service communication
    this.eventEmitter = new EventEmitter()

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

  // init services
  async initializeServices() {
    try {
      const resourcesPath = isDev
        ? path.join(__dirname, "..", "..")
        : process.resourcesPath

      // init server manager
      this.services.serverManager = new ServerManager(this.eventEmitter)
      await this.services.serverManager.initialize(resourcesPath)

      // init cookie manager
      this.services.cookieManager = new CookieManager()
      await this.services.cookieManager.initialize()

      // init ipc handlers
      this.autoUpdater = autoUpdater
      this.ipcHandlers = new IPCHandlers(this.services, this.autoUpdater)
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
      this.startPythonServer()

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

    this.mainWindow.on("close", (event) => {
      // allow close during update
      if (global.isUpdating) {
        return
      }

      if (!this.isQuitting && process.platform === "darwin") {
        event.preventDefault()
        this.mainWindow.hide()
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

  // start python server
  async startPythonServer() {
    try {
      // server event listeners
      this.eventEmitter.on("python:server:ready", () => {
        // notify renderer that download functionality is available
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("python:server:ready")
        }
      })

      this.eventEmitter.on("python:server:error", (error) => {
        console.error("Python server error:", error.message)

        // show user-friendly error
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          dialog.showErrorBox(
            "Download Engine Error",
            `The download engine encountered an error:\n\n${error.message}\n\nSome features may not work correctly.`
          )
        }
      })

      // start the server
      const success = await this.services.serverManager.startServer()

      if (!success) {
        console.warn("Python server failed to start")
      }
    } catch (error) {
      console.error("Failed to start Python server:", error)

      // show user-friendly error
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        dialog.showErrorBox(
          "Download Engine Error",
          `Failed to start the download engine:\n\n${error.message}\n\nThe app will continue to work, but downloads may not be available.`
        )
      }
    }
  }

  // handle main window closed
  onWindowClosed() {
    this.mainWindow = null
  }

  // handle before quit
  async onBeforeQuit() {
    this.isQuitting = true

    // skip cleanup if updating
    if (global.isUpdating) {
      return
    }

    try {
      // update cleanup
      this.updateState.isCheckingForUpdates = false

      // stop python server
      if (this.services.serverManager) {
        await this.services.serverManager.stopServer()
      }

      // cleanup ipc handlers
      if (this.ipcHandlers) {
        this.ipcHandlers.cleanup()
      }
    } catch (error) {
      console.error("Error during shutdown:", error)
    }
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
              const { shell } = require("electron")
              const { APP_CONFIG } = require("./utils/constants")
              await shell.openPath(APP_CONFIG.DOWNLOADS_DIR)
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
            label: "Settings",
            accelerator: "CmdOrCtrl+,",
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send("menu:open-settings")
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
                detail: `Version: 0.0.1\nDesktop YouTube downloader with segment support\n\nBuilt with Electron and embedded Python server`,
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
                    ? `System Status: Healthy\n\nPython Server: ${
                        health.data.pythonServer.isReady ? "Ready" : "Not Ready"
                      }\nCookies: ${
                        health.data.cookies.hasValid ? "Valid" : "Invalid"
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
