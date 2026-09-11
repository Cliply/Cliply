// the app's own updates: the electron-updater wiring, and how hard it tries.
//
// every listener here reports to the renderer through the running app's
// window, so the wiring is handed that app; the retries below talk only to
// the updater and read only their own limits.

const { app } = require("electron")
const { autoUpdater } = require("electron-updater")
const { APP_CONFIG } = require("./utils/constants")
const isDev = process.env.NODE_ENV === "development"

// setup auto-updater
function setupAutoUpdater(cliplyApp) {
  try {
    // configure auto-updater
    autoUpdater.checkForUpdatesAndNotify = false
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    // disable code signature verification for unsigned builds
    autoUpdater.verifyUpdateCodeSignature = false

    // checking for updates
    autoUpdater.on("checking-for-update", () => {
      if (cliplyApp.mainWindow && !cliplyApp.mainWindow.isDestroyed()) {
        cliplyApp.mainWindow.webContents.send("update:checking")
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
        if (cliplyApp.mainWindow && !cliplyApp.mainWindow.isDestroyed()) {
          cliplyApp.mainWindow.webContents.send("update:available", {
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
        if (cliplyApp.mainWindow && !cliplyApp.mainWindow.isDestroyed()) {
          cliplyApp.mainWindow.webContents.send("update:available", {
            version: info.version,
            releaseNotes: info.releaseNotes,
            releaseDate: info.releaseDate,
            autoDownloading: true
          })
        }

        // auto-download for non-macOS platforms
        cliplyApp.downloadUpdateWithRetry().catch((error) => {
          console.error("Auto-download failed:", error)
        })
      }
    })

    // update not available
    autoUpdater.on("update-not-available", () => {
      if (cliplyApp.mainWindow && !cliplyApp.mainWindow.isDestroyed()) {
        cliplyApp.mainWindow.webContents.send("update:not-available")
      }
    })

    // download progress
    autoUpdater.on("download-progress", (progress) => {
      if (cliplyApp.mainWindow && !cliplyApp.mainWindow.isDestroyed()) {
        cliplyApp.mainWindow.webContents.send("update:download-progress", {
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
      if (cliplyApp.mainWindow && !cliplyApp.mainWindow.isDestroyed()) {
        cliplyApp.mainWindow.webContents.send("update:downloaded", {
          version: info.version,
          autoInstallOnQuit: true
        })
      }
    })

    // error
    autoUpdater.on("error", (error) => {
      console.error("Auto-updater error:", error.message)
      if (cliplyApp.mainWindow && !cliplyApp.mainWindow.isDestroyed()) {
        cliplyApp.mainWindow.webContents.send("update:error", {
          message: error.message
        })
      }
    })

    // check for updates after app ready
    app.whenReady().then(() => {
      const shouldCheck = isDev || Math.random() < 0.9

      if (shouldCheck) {
        setTimeout(() => {
          cliplyApp.checkForUpdatesWithRetry().catch((error) => {
            console.error("Failed to check for updates:", error)
          })
        }, 3000)
      }

      // setup periodic update checks every 12 hours
      cliplyApp.setupPeriodicUpdateChecks()
    })
  } catch (error) {
    console.error("Auto-updater setup failed:", error)
  }
}

// retry logic for update checks
async function checkForUpdatesWithRetry(
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
async function downloadUpdateWithRetry(
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
function setupPeriodicUpdateChecks(cliplyApp) {
  // check every 12 hours using config
  const checkInterval = APP_CONFIG.UPDATE_CONFIG.PERIODIC_CHECK_INTERVAL

  // unref'd like every other timer here: a 12-hour interval is the longest
  // lived handle in the process, and an armed one is on its own enough to
  // hold the event loop open long after there is anything left to do
  cliplyApp.periodicUpdateTimer = setInterval(() => {
    // only check if app is not quitting and in production
    if (!cliplyApp.isQuitting && !isDev) {
      console.log("Performing periodic update check...")
      cliplyApp.checkForUpdatesWithRetry().catch((error) => {
        console.error("Periodic update check failed:", error)
      })
    }
  }, checkInterval)
  cliplyApp.periodicUpdateTimer.unref()
}

module.exports = {
  setupAutoUpdater,
  checkForUpdatesWithRetry,
  downloadUpdateWithRetry,
  setupPeriodicUpdateChecks
}
