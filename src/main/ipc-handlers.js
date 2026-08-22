// ipc handlers

const { ipcMain, dialog, app } = require("electron")
const os = require("os")
const { IPC_CHANNELS } = require("./utils/constants")
const { extractQuality } = require("./utils/analytics-helpers")
const { ERROR_STAGES, classify } = require("./utils/error-taxonomy")
const {
  mapVideoInfo,
  mapSimpleInfo,
  hasPlayableVideo,
  buildVideoOutputTemplate,
  buildAudioOutputTemplate,
  buildSimpleOutputTemplate
} = require("./utils/ytdlp-mappers")
const { getSimplePlatformOptions } = require("./utils/ytdlp-formats")
const { resolveDownloadId } = require("./utils/download-id")

const { DownloadRunner } = require("./services/download-runner")
const { SettingsStore } = require("./services/settings-store")
const { ERROR_CODES } = require("./services/ytdlp-engine")

/**
 * urls the cookie test probes, tried in order
 *
 * a probe target can die upstream - yt-dlp's own long-standing test video
 * (BaW_jenozKc) is gone - and a dead target must never be read as "your
 * cookies failed". so an unavailable video moves on to the next url instead of
 * deciding anything, and only a real extraction result ends the probe.
 */
const COOKIE_TEST_URLS = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  // the oldest video on youtube - about as unlikely to vanish as they come
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "https://www.youtube.com/watch?v=9bZkp7q19f0"
]

// platforms served by the binary engine's single-video flows
const SUPPORTED_DOWNLOAD_PLATFORMS = ["youtube", "pinterest", "tiktok"]

/**
 * treat an empty or zero-length selection as "no time range"
 *
 * the renderer only sends a range for a real segment now, but a stale client
 * (or the {start:0,end:0} the store starts with) must not turn a full download
 * into an ffmpeg section download, which costs granular progress and speed.
 *
 * @param {Object} range - {start, end} in seconds, or nothing
 * @returns {Object|undefined} the range, or undefined when it is not a segment
 */
function normalizeTimeRange(range) {
  if (!range) return undefined

  const start = Number(range.start) || 0
  const end = Number(range.end) || 0

  if (end <= start) return undefined

  return { start, end }
}

// say which way the jar is unusable, so "not working" is actionable
function cookieJarProblem({ total, youtube, expired }) {
  if (total === 0) {
    return "No cookies imported"
  }

  if (youtube === 0) {
    return "This file has no YouTube cookies in it"
  }

  if (expired >= youtube) {
    return "Your YouTube cookies have expired - export them again"
  }

  return "No usable YouTube cookies"
}

/**
 * what the runner calls a download, in the words the taxonomy answers in.
 *
 * the runner says "combined" for a merged video+audio download and never
 * "video" - an ffmpeg detail about how the file was assembled, where analytics
 * answers what the user took away. anything else is left out rather than
 * guessed at: absence is silent, and a value outside the vocabulary is not.
 */
const MEDIA_TYPES = { combined: "video", video: "video", audio: "audio" }

// an error message may arrive as "<short user message>\n\n<full technical>".
// the first paragraph is what the user is shown; the rest travels as details.
// analytics no longer reads this path at all - it takes the runner's payload.
const shortErrorMessage = (message) =>
  (message || "").split(/\n\s*\n/, 1)[0].trim() || "Download failed"

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

    // one source of truth for the download folder, shared with the settings ipc
    this.settings = services.settingsStore || new SettingsStore()

    // drives engine downloads and forwards their progress to the renderer
    this.runner = new DownloadRunner({
      engine: this.engine,
      updater: this.updater,
      sendEvent: (downloadId, payload) =>
        this.sendDownloadEvent(downloadId, payload),
      trackEvent: (name, payload) => this.trackDownloadEvent(name, payload),
      logAudit: (operation, success, data) =>
        this.logAudit(operation, success, data)
    })

    this.registerHandlers()
  }

  // send one download:progress event - the channel the renderer hooks listen on
  sendDownloadEvent(downloadId, payload) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }

    this.mainWindow.webContents.send(IPC_CHANNELS.DOWNLOAD_PROGRESS, {
      downloadId,
      ...payload
    })
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
      this.analytics.capture("download_cancelled", {
        platform: payload.platform,
        media_type: MEDIA_TYPES[payload.type],
        progress_at_cancel: Math.round(payload.progress || 0)
      })
      return
    }

    const base = {
      platform: payload.platform,
      media_type: MEDIA_TYPES[payload.type],
      quality: extractQuality(payload.formatId),
      is_trimmed: Boolean(payload.trimmed)
    }

    if (name === "download_completed") {
      this.analytics.capture("download_completed", {
        ...base,
        file_size_mb: Math.round((payload.fileSize || 0) / (1024 * 1024))
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

    this.analytics.capture("download_failed", {
      ...base,
      error_category: category,
      error_stage: stage,
      error_message: payload.errorMessage,
      progress_at_failure: Math.round(payload.progress || 0)
    })
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

    this.analytics.capture("cookies_imported", {
      success: Boolean(imported),
      has_youtube_cookies: Boolean(this.cookieManager.hasValidCookies())
    })
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
      IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS,
      this.handleGetDiagnostics.bind(this)
    )
    ipcMain.handle(
      "system:open-download-folder",
      this.handleOpenDownloadFolder.bind(this)
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
        return this.createError("Unsupported platform", "Please use YouTube, Pinterest, or TikTok")
      }

      // one spawn, no server to wait for
      const info = await this.engine.getInfo(url)

      // the python pinterest service refused image pins by inspecting formats
      if (targetPlatform === "pinterest" && !hasPlayableVideo(info)) {
        return this.createError(
          "This Pinterest pin contains an image, not a video.",
          "The Pinterest downloader only works with video pins.",
          "NOT_A_VIDEO"
        )
      }

      const videoInfo =
        targetPlatform === "youtube"
          ? mapVideoInfo(info)
          : mapSimpleInfo(info, `${targetPlatform}_video`)

      return this.createSuccess(videoInfo)
    } catch (error) {
      console.error("Info extraction failed:", error.message)
      return this.createError(
        error.message || "Failed to get media information",
        error.suggestion || "Please check the URL and try again",
        error.code || "GENERAL_ERROR",
        {
          details: error.details || undefined,
          category: classify(error, ERROR_STAGES.FETCH_INFO).category
        }
      )
    }
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
            title
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

      // tiktok / pinterest have no progress ui and their components still await
      // completion, so these keep resolving when the file is on disk
      const outputTemplate = buildSimpleOutputTemplate({
        title,
        platform: targetPlatform
      })

      // each platform keeps the options its python service used
      const preset = getSimplePlatformOptions(targetPlatform)

      const createHandle = () =>
        this.engine.downloadSimple({
          url,
          outputDir,
          outputTemplate,
          formatSelector: simpleFormatId || preset.formatSelector,
          extraArgs: preset.extraArgs
        })

      if (
        !this.runner.reserve(downloadId, {
          type: "combined",
          platform: targetPlatform,
          title
        })
      ) {
        return this.duplicateDownloadError(downloadId)
      }

      const result = await this.runner.run({
        downloadId,
        type: "combined",
        platform: targetPlatform,
        title,
        formatId: simpleFormatId || targetPlatform,
        createHandle
      })

      if (!result.success) {
        return this.createError(
          result.message || "Download failed",
          "Please try again or check your connection",
          "DOWNLOAD_FAILED",
          {
            details: result.details,
            category: classify(result.message, ERROR_STAGES.DOWNLOAD).category
          }
        )
      }

      return this.createSuccess(result)
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
          title
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
      this.runner.run(options).catch((error) => {
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
        .find((entry) => entry.id === downloadId)
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
      const downloads = this.runner.list()

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
      this.trackCookieImport(success)

      return this.createSuccess({
        imported: success,
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Cookie import failed:", error.message)
      this.trackCookieImport(false)
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
      this.trackCookieImport(success)

      return this.createSuccess({
        imported: success,
        filePath,
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Cookie file import failed:", error.message)
      this.trackCookieImport(false)
      return this.createError("Failed to import cookie file", error.message)
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
      // the jar may have changed (or expired) since it was imported
      await this.cookieManager.refresh()
      const inspection = await this.cookieManager.inspectCookieFile()

      if (!inspection.usable) {
        const note = cookieJarProblem(inspection)

        await this.cookieManager.updateStatus({
          lastTest: new Date().toISOString(),
          cookiesLoaded: false,
          extractionCheck: "skipped",
          note
        })

        return this.createSuccess({
          cookiesLoaded: false,
          extractionCheck: "skipped",
          note,
          status: await this.cookieManager.getStatus(),
          hasValidCookies: false
        })
      }

      // probe with the cookie file forced on, so the result depends on it
      const { extractionCheck, note } = await this.probeCookies(
        this.cookieManager.getCookieFilePath()
      )

      await this.cookieManager.updateStatus({
        lastTest: new Date().toISOString(),
        cookiesLoaded: true,
        extractionCheck,
        note
      })

      return this.createSuccess({
        cookiesLoaded: true,
        extractionCheck,
        note,
        status: await this.cookieManager.getStatus(),
        hasValidCookies: this.cookieManager.hasValidCookies()
      })
    } catch (error) {
      console.error("Cookie test failed:", error.message)
      return this.createError("Cookie test failed", error.message)
    }
  }

  /**
   * run a real extraction with the jar attached and report what happened
   *
   * walks COOKIE_TEST_URLS, treating an unavailable target as "this probe told
   * us nothing" rather than a verdict. anything else - a success, bot
   * detection, a network failure - is about the cookies, so it ends the walk.
   *
   * @param {string|null} cookieFile - the jar to force on for the probe
   * @returns {Promise<Object>} {extractionCheck, note}
   */
  async probeCookies(cookieFile) {
    let deadTargets = 0

    for (const url of COOKIE_TEST_URLS) {
      try {
        const info = await this.engine.getInfo(url, { cookieFile })

        if (info && info.title) {
          return {
            extractionCheck: "passed",
            note: "Extraction worked with your cookies attached. This does not by itself prove YouTube accepted them."
          }
        }

        return {
          extractionCheck: "unknown",
          note: "The test video returned no details."
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
            note: "YouTube still asked us to confirm you're not a bot while sending your cookies - they are expired or not being accepted."
          }
        }

        if (probeError.code === ERROR_CODES.NETWORK_ERROR) {
          return {
            extractionCheck: "unknown",
            note: "Couldn't reach YouTube, so the cookies weren't tested."
          }
        }

        return {
          extractionCheck: "unknown",
          note: `The test couldn't complete: ${probeError.message}`
        }
      }
    }

    return {
      extractionCheck: "unknown",
      note: `All ${deadTargets} of our test videos are unavailable right now, so this test says nothing about your cookies.`
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
      IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS,
      "cookies:import-file",
      "cookies:clear",
      "download:get-status",
      "download:get-all",
      "system:open-download-folder",
      "system:select-download-folder",
      "settings:get-download-path",
      "settings:set-download-path"
    ]

    channels.forEach((channel) => {
      ipcMain.removeAllListeners(channel)
    })
  }
}

module.exports = IPCHandlers
