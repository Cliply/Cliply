// ipc handlers

const { ipcMain, dialog } = require("electron")
const { IPC_CHANNELS, APP_CONFIG } = require("./utils/constants")
const {
  categorizeError,
  extractQuality,
  extractTitleFromFilename,
  sanitizeTitle
} = require("./utils/analytics-helpers")

// get trackEvent from global
const getTrackEvent = () => global.trackEvent || (() => {})

class IPCHandlers {
  constructor(services, autoUpdater = null) {
    this.serverManager = services.serverManager
    this.cookieManager = services.cookieManager
    this.autoUpdater = autoUpdater
    this.mainWindow = null

    // audit logging
    this.auditLog = []

    // active downloads
    this.activeDownloads = new Map()

    this.registerHandlers()
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
    code = "GENERAL_ERROR"
  ) {
    return {
      success: false,
      error: { message, suggestion, code }
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

    // forward python server events
    this.serverManager.eventEmitter.on("python:server:starting", () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("python:server:starting")
      }
    })

    this.serverManager.eventEmitter.on("python:server:ready", () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("python:server:ready")
      }
    })

    this.serverManager.eventEmitter.on("python:server:error", (error) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("python:server:error", {
          message: error.message
        })
      }
    })
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

    // download management
    ipcMain.handle(
      IPC_CHANNELS.DOWNLOAD_CANCEL,
      this.handleCancelDownload.bind(this)
    )
    ipcMain.handle(
      "download:get-status",
      this.handleGetDownloadStatus.bind(this)
    )
    ipcMain.handle("download:get-all", this.handleGetAllDownloads.bind(this))

    // cookie management
    ipcMain.handle(
      IPC_CHANNELS.COOKIES_IMPORT,
      this.handleImportCookies.bind(this)
    )
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
      "system:open-download-folder",
      this.handleOpenDownloadFolder.bind(this)
    )
    ipcMain.handle(
      "system:select-download-folder",
      this.handleSelectDownloadFolder.bind(this)
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
      const { url } = data

      if (!this.serverManager.isServerReady()) {
        return this.createError(
          "Download engine starting",
          "Please wait a moment and try again",
          "ENGINE_STARTING"
        )
      }

      const response = await this.serverManager.makeRequest(
        APP_CONFIG.PYTHON_SERVER.ENDPOINTS.VIDEO_INFO,
        {
          method: "POST",
          body: JSON.stringify({ url })
        }
      )

      const videoInfo = await response.json()

      return this.createSuccess(videoInfo)
    } catch (error) {
      console.error("Video info extraction failed:", error.message)
      return this.createError(
        "Failed to get video information",
        "Please check the URL and try again"
      )
    }
  }

  // combined download with single atomic tracking
  async handleDownloadCombined(event, data) {
    const downloadId = `combined_${Date.now()}`
    let title = "unknown" // default title for error tracking
    let video_format_id = "unknown" // default for error tracking

    try {
      // validate input
      this.validateRequest(data, ["url", "video_format_id", "audio_format_id"])
      const {
        url,
        video_format_id: videoFormatId,
        audio_format_id: audioFormatId,
        time_range,
        title: requestTitle = "video"
      } = data

      title = requestTitle
      video_format_id = videoFormatId

      // check python server
      if (!this.serverManager.isServerReady()) {
        return this.createError(
          "Download engine starting",
          "Please wait a moment and try again",
          "ENGINE_STARTING"
        )
      }

      // track active download
      this.activeDownloads.set(downloadId, {
        type: "combined",
        title,
        url,
        started: Date.now(),
        status: "starting"
      })

      this.activeDownloads.get(downloadId).status = "downloading"

      try {
        // prepare request
        const requestData = {
          url,
          video_format_id: videoFormatId,
          audio_format_id: audioFormatId
        }
        if (time_range) {
          requestData.time_range = time_range
        }

        // download via python server
        const response = await this.serverManager.makeRequest(
          APP_CONFIG.PYTHON_SERVER.ENDPOINTS.DOWNLOAD_COMBINED,
          {
            method: "POST",
            body: JSON.stringify(requestData)
          }
        )

        const result = await response.json()

        if (result.success) {
          this.activeDownloads.delete(downloadId)
          this.logAudit("download_success", true, {
            type: "combined",
            filename: result.filename
          })

          // track success
          try {
            const actualTitle = result.filename
              ? extractTitleFromFilename(result.filename)
              : title
            const eventData = {
              type: "combined",
              video_title: sanitizeTitle(actualTitle),
              format_quality: extractQuality(videoFormatId),
              file_size_mb: Math.round((result.file_size || 0) / (1024 * 1024))
            }
            getTrackEvent()(
              APP_CONFIG.ANALYTICS_CONFIG.EVENTS.DOWNLOAD_COMPLETED,
              eventData
            )
          } catch (analyticsError) {
            console.warn(
              "Failed to track download completion:",
              analyticsError.message
            )
          }

          return this.createSuccess({
            filename: result.filename,
            file_path: result.file_path,
            file_size: result.file_size,
            type: "combined",
            download_id: downloadId
          })
        } else {
          throw new Error(result.error || "Download failed")
        }
      } catch (downloadError) {
        this.activeDownloads.delete(downloadId)
        this.logAudit("download_failed", false, {
          type: "combined",
          error: downloadError.message
        })
        throw downloadError
      }
    } catch (error) {
      this.activeDownloads.delete(downloadId)
      console.error(`[${downloadId}] Combined download failed:`, error.message)

      // track failure
      try {
        const eventData = {
          error_type: categorizeError(error.message),
          type: "combined",
          video_title: sanitizeTitle(title),
          format_quality: extractQuality(video_format_id)
        }
        getTrackEvent()(
          APP_CONFIG.ANALYTICS_CONFIG.EVENTS.DOWNLOAD_FAILED,
          eventData
        )
      } catch (analyticsError) {
        console.warn(
          "Failed to track download failure:",
          analyticsError.message
        )
      }

      return this.createError(
        "Download failed",
        "Please try again or check your connection"
      )
    }
  }

  // audio download with single atomic tracking
  async handleDownloadAudio(event, data) {
    const downloadId = `audio_${Date.now()}`
    let title = "unknown" // default title for error tracking
    let format_id = "unknown" // default for error tracking

    try {
      // validate input
      this.validateRequest(data, ["url", "format_id"])
      const {
        url,
        format_id: formatId,
        time_range,
        title: requestTitle = "audio"
      } = data

      title = requestTitle
      format_id = formatId

      // check python server
      if (!this.serverManager.isServerReady()) {
        return this.createError(
          "Download engine starting",
          "Please wait a moment and try again",
          "ENGINE_STARTING"
        )
      }

      // track active download
      this.activeDownloads.set(downloadId, {
        type: "audio",
        title,
        url,
        started: Date.now(),
        status: "starting"
      })

      this.activeDownloads.get(downloadId).status = "downloading"

      try {
        // prepare request
        const requestData = { url, format_id: formatId }
        if (time_range) {
          requestData.time_range = time_range
        }

        // download via python server
        const response = await this.serverManager.makeRequest(
          APP_CONFIG.PYTHON_SERVER.ENDPOINTS.DOWNLOAD_AUDIO,
          {
            method: "POST",
            body: JSON.stringify(requestData)
          }
        )

        const result = await response.json()

        if (result.success) {
          this.activeDownloads.delete(downloadId)
          this.logAudit("download_success", true, {
            type: "audio",
            filename: result.filename
          })

          // track success
          try {
            const actualTitle = result.filename
              ? extractTitleFromFilename(result.filename)
              : title
            const eventData = {
              type: "audio",
              video_title: sanitizeTitle(actualTitle),
              format_quality: extractQuality(formatId),
              file_size_mb: Math.round((result.file_size || 0) / (1024 * 1024))
            }
            getTrackEvent()(
              APP_CONFIG.ANALYTICS_CONFIG.EVENTS.DOWNLOAD_COMPLETED,
              eventData
            )
          } catch (analyticsError) {
            console.warn(
              "Failed to track audio download completion:",
              analyticsError.message
            )
          }

          return this.createSuccess({
            filename: result.filename,
            file_path: result.file_path,
            file_size: result.file_size,
            type: "audio",
            download_id: downloadId
          })
        } else {
          throw new Error(result.error || "Download failed")
        }
      } catch (downloadError) {
        this.activeDownloads.delete(downloadId)
        this.logAudit("download_failed", false, {
          type: "audio",
          error: downloadError.message
        })
        throw downloadError
      }
    } catch (error) {
      this.activeDownloads.delete(downloadId)
      console.error(`[${downloadId}] Audio download failed:`, error.message)

      // track failure
      try {
        // use actual format id
        const actualFormatId = data?.format_id || format_id
        const eventData = {
          error_type: categorizeError(error.message),
          type: "audio",
          video_title: sanitizeTitle(title),
          format_quality: extractQuality(actualFormatId)
        }
        getTrackEvent()(
          APP_CONFIG.ANALYTICS_CONFIG.EVENTS.DOWNLOAD_FAILED,
          eventData
        )
      } catch (analyticsError) {
        console.warn(
          "Failed to track audio download failure:",
          analyticsError.message
        )
      }

      return this.createError(
        "Download failed",
        "Please try again or check your connection"
      )
    }
  }

  // cancel a download
  async handleCancelDownload(event, data) {
    try {
      this.validateRequest(data, ["downloadId"])
      const { downloadId } = data

      if (this.activeDownloads.has(downloadId)) {
        this.activeDownloads.delete(downloadId)
        // note: python server handles cancellation internally
        return this.createSuccess({ cancelled: true })
      } else {
        return this.createError("Download not found")
      }
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

      const download = this.activeDownloads.get(downloadId)
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
  async handleGetAllDownloads(_event) {
    try {
      const downloads = Array.from(this.activeDownloads.entries()).map(
        ([id, data]) => ({
          id,
          ...data
        })
      )

      return this.createSuccess({ downloads })
    } catch (error) {
      console.error("Get all downloads failed:", error.message)
      return this.createError("Failed to get downloads")
    }
  }

  // import cookies from text
  async handleImportCookies(event, data) {
    try {
      this.validateRequest(data, ["cookies"])
      const { cookies } = data

      const success = await this.cookieManager.importCookies(cookies)

      return this.createSuccess({
        imported: success,
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Cookie import failed:", error.message)
      return this.createError("Failed to import cookies", error.message)
    }
  }

  // import cookies from file
  async handleImportCookieFile(_event) {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        title: "Select Cookie File",
        filters: [
          { name: "Cookie Files", extensions: ["txt"] },
          { name: "All Files", extensions: ["*"] }
        ],
        properties: ["openFile"]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return this.createError("No file selected")
      }

      const filePath = result.filePaths[0]
      const success = await this.cookieManager.importCookieFile(filePath)

      return this.createSuccess({
        imported: success,
        filePath,
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Cookie file import failed:", error.message)
      return this.createError("Failed to import cookie file", error.message)
    }
  }

  // test cookies
  async handleTestCookies(_event) {
    try {
      const working = await this.cookieManager.testCookies()
      const status = await this.cookieManager.getStatus()

      return this.createSuccess({
        working,
        status,
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Cookie test failed:", error.message)
      return this.createError("Cookie test failed", error.message)
    }
  }

  // get cookie status
  async handleGetCookieStatus(_event) {
    try {
      const status = await this.cookieManager.getStatus()
      const fileInfo = await this.cookieManager.getFileInfo()

      return this.createSuccess({
        status,
        fileInfo,
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Get cookie status failed:", error.message)
      return this.createError("Failed to get cookie status")
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
      return this.createError("Failed to clear cookies")
    }
  }

  // system health check
  async handleSystemHealth(_event) {
    try {
      const serverStatus = this.serverManager.getStatus()
      const cookieStatus = await this.cookieManager.getStatus()

      return this.createSuccess({
        timestamp: new Date().toISOString(),
        pythonServer: {
          isReady: serverStatus.isReady,
          serverUrl: serverStatus.serverUrl
        },
        cookies: {
          hasValid: this.cookieManager.hasValidCookies(),
          fileSize: cookieStatus?.fileSize || 0
        },
        downloads: {
          active: this.activeDownloads.size,
          total: this.auditLog.filter(
            (log) => log.operation === "download_success"
          ).length
        },
        performance: {
          uptime: Math.floor(process.uptime()),
          memory: process.memoryUsage().heapUsed
        },
        auditSummary: {
          totalEvents: this.auditLog.length,
          recentEvents: this.auditLog.slice(-3).map((event) => ({
            operation: event.operation,
            success: event.success,
            timestamp: event.timestamp
          }))
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

  // open downloads folder
  async handleOpenDownloadFolder(_event) {
    try {
      const { shell } = require("electron")
      await shell.openPath(APP_CONFIG.DOWNLOADS_DIR)
      return this.createSuccess({ opened: true })
    } catch (error) {
      console.error("Open download folder failed:", error.message)
      return this.createError("Failed to open downloads folder")
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

  // clean up expired downloads
  cleanupExpiredDownloads() {
    const now = Date.now()
    const maxAge = 5 * 60 * 1000 // 5 minutes

    for (const [downloadId, download] of this.activeDownloads.entries()) {
      if (now - download.started > maxAge) {
        this.activeDownloads.delete(downloadId)
      }
    }
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
    // clean up active downloads
    this.activeDownloads.clear()

    // remove all listeners
    const channels = [
      IPC_CHANNELS.VIDEO_GET_INFO,
      IPC_CHANNELS.VIDEO_DOWNLOAD_COMBINED,
      IPC_CHANNELS.AUDIO_DOWNLOAD,
      IPC_CHANNELS.DOWNLOAD_CANCEL,
      IPC_CHANNELS.COOKIES_IMPORT,
      IPC_CHANNELS.COOKIES_TEST,
      IPC_CHANNELS.COOKIES_STATUS,
      IPC_CHANNELS.UPDATE_CHECK,
      IPC_CHANNELS.UPDATE_DOWNLOAD,
      IPC_CHANNELS.UPDATE_INSTALL,
      "update:force-security-check",
      IPC_CHANNELS.SYSTEM_HEALTH,
      IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL,
      "cookies:import-file",
      "cookies:clear",
      "download:get-status",
      "download:get-all",
      "system:open-download-folder",
      "system:select-download-folder"
    ]

    channels.forEach((channel) => {
      ipcMain.removeAllListeners(channel)
    })
  }
}

module.exports = IPCHandlers
