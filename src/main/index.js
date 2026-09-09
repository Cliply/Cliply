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
const { PotInstaller } = require("./services/pot-installer")
const { SettingsStore } = require("./services/settings-store")
const { Analytics } = require("./services/analytics")
const IPCHandlers = require("./ipc-handlers")
const { APP_CONFIG } = require("./utils/constants")
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

/**
 * what the native menu says, in the two languages the app speaks
 *
 * this one surface follows app.getLocale() - the OS - rather than the in-app
 * language toggle. the menu bar is the system's, it is built before a renderer
 * exists to ask, and the alternative is an ipc round trip on every startup.
 *
 * sentence case here, unlike the lowercase in-app voice: these labels sit in
 * the OS's own menu bar next to the OS's own words. product names stay latin.
 */
const MENU_TEXT = {
  en: {
    file: "File",
    newDownload: "New Download",
    openDownloads: "Open Downloads Folder",
    quit: "Quit",

    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",

    tools: "Tools",
    checkUpdates: "Check for Updates",
    videoEngine: "Video engine",
    versionUnknown: "version unknown",
    sendUsageData: "Send usage data",

    view: "View",
    reload: "Reload",
    forceReload: "Force Reload",
    devTools: "Toggle Developer Tools",
    actualSize: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    fullscreen: "Toggle Fullscreen",

    window: "Window",
    minimize: "Minimize",
    close: "Close",
    zoom: "Zoom",
    bringAllToFront: "Bring All to Front",

    help: "Help",
    aboutCliply: "About Cliply",
    systemHealth: "System Health",
    reportIssue: "Report Issue",

    // the macos app menu builds two of its labels around the app's own name
    about: "About",
    services: "Services",
    hide: "Hide",
    hideOthers: "Hide Others",
    showAll: "Show All",

    version: "Version",
    aboutBlurb:
      "Your fave little desktop app; powered by open source tools (>ᴗ•)",

    // the boxes these menu items put up when something goes wrong
    error: "Error",
    updateCheckFailed: "Update Check Failed",
    updateCheckFailedMessage: "Failed to check for updates.",
    updateCheckFailedDetail: "Please try again later.",
    updateUnavailable: "Update Check Unavailable",
    updateUnavailableMessage: "Update checking is not available.",
    updateUnavailableDetail:
      "Updates are only available in production builds.",
    prefNotSaved: "Couldn't save that preference",
    prefNotSavedMessage: "Your analytics preference could not be saved.",
    prefNotSavedDetail: "Please try again.",
    healthCheckFailed: "Failed to check system health.",

    healthHealthy: "System Status: Healthy",
    healthError: "System Status: Error",
    healthDownloader: "Downloader",
    healthUnknown: "Unknown",
    healthFound: "Found",
    healthMissing: "Missing",
    healthValid: "Valid",
    healthInvalid: "Invalid",
    healthActive: "Active downloads",
    healthUptime: "Uptime",
    healthMinutes: "minutes"
  },
  ru: {
    file: "Файл",
    newDownload: "Новая загрузка",
    openDownloads: "Открыть папку загрузок",
    quit: "Выход",

    edit: "Правка",
    undo: "Отменить",
    redo: "Повторить",
    cut: "Вырезать",
    copy: "Копировать",
    paste: "Вставить",

    tools: "Инструменты",
    checkUpdates: "Проверить обновления",
    videoEngine: "Движок видео",
    versionUnknown: "версия неизвестна",
    sendUsageData: "Отправлять данные об использовании",

    view: "Вид",
    reload: "Перезагрузить",
    forceReload: "Перезагрузить принудительно",
    devTools: "Инструменты разработчика",
    actualSize: "Исходный размер",
    zoomIn: "Увеличить",
    zoomOut: "Уменьшить",
    fullscreen: "Полноэкранный режим",

    window: "Окно",
    minimize: "Свернуть",
    close: "Закрыть",
    zoom: "Масштаб",
    bringAllToFront: "Все окна на передний план",

    help: "Справка",
    aboutCliply: "О Cliply",
    systemHealth: "Состояние системы",
    reportIssue: "Сообщить о проблеме",

    about: "О",
    services: "Службы",
    hide: "Скрыть",
    hideOthers: "Скрыть остальные",
    showAll: "Показать все",

    version: "Версия",
    aboutBlurb:
      "Ваше любимое маленькое приложение; работает на инструментах с открытым кодом (>ᴗ•)",

    error: "Ошибка",
    updateCheckFailed: "Не удалось проверить обновления",
    updateCheckFailedMessage: "Не удалось проверить наличие обновлений.",
    updateCheckFailedDetail: "Попробуйте позже.",
    updateUnavailable: "Проверка обновлений недоступна",
    updateUnavailableMessage: "Проверка обновлений здесь не работает.",
    updateUnavailableDetail:
      "Обновления доступны только в установленной версии.",
    prefNotSaved: "Не удалось сохранить настройку",
    prefNotSavedMessage: "Настройку аналитики не удалось сохранить.",
    prefNotSavedDetail: "Попробуйте ещё раз.",
    healthCheckFailed: "Не удалось проверить состояние системы.",

    healthHealthy: "Состояние системы: в порядке",
    healthError: "Состояние системы: ошибка",
    healthDownloader: "Загрузчик",
    healthUnknown: "неизвестно",
    healthFound: "найден",
    healthMissing: "отсутствует",
    healthValid: "рабочие",
    healthInvalid: "нерабочие",
    healthActive: "Активные загрузки",
    healthUptime: "Время работы",
    healthMinutes: "мин."
  }
}

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
        this.updateState.isCheckingForUpdates = false

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

    // the OS's language, not the in-app toggle. both callers run after ready,
    // where getLocale() has settled - and a locale we cannot read leaves an
    // english menu, which is better than an initialisation that aborts here
    let locale = ""
    try {
      locale = app.getLocale()
    } catch (error) {
      console.error("Could not read the OS locale:", error)
    }

    const T =
      MENU_TEXT[
        typeof locale === "string" && locale.toLowerCase().startsWith("ru")
          ? "ru"
          : "en"
      ]

    const template = [
      {
        label: T.file,
        submenu: [
          {
            label: T.newDownload,
            accelerator: "CmdOrCtrl+N",
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send("menu:new-download")
              }
            }
          },
          { type: "separator" },
          {
            label: T.openDownloads,
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
            label: T.quit,
            accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
            click: () => {
              app.quit()
            }
          }
        ]
      },
      {
        label: T.edit,
        submenu: [
          { label: T.undo, accelerator: "CmdOrCtrl+Z", role: "undo" },
          { label: T.redo, accelerator: "Shift+CmdOrCtrl+Z", role: "redo" },
          { type: "separator" },
          { label: T.cut, accelerator: "CmdOrCtrl+X", role: "cut" },
          { label: T.copy, accelerator: "CmdOrCtrl+C", role: "copy" },
          { label: T.paste, accelerator: "CmdOrCtrl+V", role: "paste" }
        ]
      },
      {
        label: T.tools,
        submenu: [
          {
            label: T.checkUpdates,
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
                      title: T.updateCheckFailed,
                      message: T.updateCheckFailedMessage,
                      detail:
                        result.error?.message || T.updateCheckFailedDetail,
                      buttons: ["OK"]
                    })
                  }
                } else {
                  dialog.showMessageBox(this.mainWindow, {
                    type: "warning",
                    title: T.updateUnavailable,
                    message: T.updateUnavailableMessage,
                    detail: T.updateUnavailableDetail,
                    buttons: ["OK"]
                  })
                }
              } catch (error) {
                console.error("Manual update check failed:", error)
                dialog.showErrorBox(T.error, T.updateCheckFailedMessage)
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
              ? `${T.videoEngine}: yt-dlp ${engineVersion}`
              : `${T.videoEngine}: ${T.versionUnknown}`,
            enabled: false
          },
          { type: "separator" },
          {
            // deliberately not "anonymous". every event carries a persistent
            // install id and a city derived from the ip, which is pseudonymous
            // - and this label is read far more often than PRIVACY.md, so it
            // is where the word would do its damage
            label: T.sendUsageData,
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
                  title: T.prefNotSaved,
                  message: T.prefNotSavedMessage,
                  detail: result.error || T.prefNotSavedDetail,
                  buttons: ["OK"]
                })
              }
            }
          }
        ]
      },
      {
        label: T.view,
        submenu: [
          { label: T.reload, accelerator: "CmdOrCtrl+R", role: "reload" },
          {
            label: T.forceReload,
            accelerator: "CmdOrCtrl+Shift+R",
            role: "forceReload"
          },
          {
            label: T.devTools,
            accelerator: "F12",
            role: "toggleDevTools"
          },
          { type: "separator" },
          {
            label: T.actualSize,
            accelerator: "CmdOrCtrl+0",
            role: "resetZoom"
          },
          { label: T.zoomIn, accelerator: "CmdOrCtrl+Plus", role: "zoomIn" },
          { label: T.zoomOut, accelerator: "CmdOrCtrl+-", role: "zoomOut" },
          { type: "separator" },
          {
            label: T.fullscreen,
            accelerator: "F11",
            role: "togglefullscreen"
          }
        ]
      },
      {
        label: T.window,
        submenu: [
          { label: T.minimize, accelerator: "CmdOrCtrl+M", role: "minimize" },
          { label: T.close, accelerator: "CmdOrCtrl+W", role: "close" }
        ]
      },
      {
        label: T.help,
        submenu: [
          {
            label: T.aboutCliply,
            click: () => {
              dialog.showMessageBox(this.mainWindow, {
                type: "info",
                title: T.aboutCliply,
                message: "Cliply Desktop",
                detail: `${T.version}: ${getAppVersion()}\n\n${T.aboutBlurb}`,
                buttons: ["OK"]
              })
            }
          },
          {
            label: T.systemHealth,
            click: async () => {
              try {
                if (this.ipcHandlers) {
                  const health = await this.ipcHandlers.handleSystemHealth()

                  const message = health.success
                    ? `${T.healthHealthy}\n\n${T.healthDownloader}: ${
                        health.data.engine.version || T.healthUnknown
                      }\nFFmpeg: ${
                        health.data.engine.ffmpeg
                          ? T.healthFound
                          : T.healthMissing
                      }\nCookies: ${
                        health.data.cookies.hasValid
                          ? T.healthValid
                          : T.healthInvalid
                      }\n${T.healthActive}: ${
                        health.data.downloads.active
                      }\n${T.healthUptime}: ${Math.floor(
                        health.data.performance.uptime / 60
                      )} ${T.healthMinutes}`
                    : `${T.healthError}\n\n${health.error.message}`

                  dialog.showMessageBox(this.mainWindow, {
                    type: health.success ? "info" : "error",
                    title: T.systemHealth,
                    message,
                    buttons: ["OK"]
                  })
                }
              } catch (error) {
                console.error("System health check failed:", error)
                dialog.showErrorBox(T.error, T.healthCheckFailed)
              }
            }
          },
          { type: "separator" },
          {
            label: T.reportIssue,
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
          { label: T.about + " " + app.getName(), role: "about" },
          { type: "separator" },
          { label: T.services, role: "services", submenu: [] },
          { type: "separator" },
          {
            label: T.hide + " " + app.getName(),
            accelerator: "Command+H",
            role: "hide"
          },
          {
            label: T.hideOthers,
            accelerator: "Command+Shift+H",
            role: "hideothers"
          },
          { label: T.showAll, role: "unhide" },
          { type: "separator" },
          { label: T.quit, accelerator: "Command+Q", click: () => app.quit() }
        ]
      })

      // window menu
      template[5].submenu = [
        { label: T.close, accelerator: "CmdOrCtrl+W", role: "close" },
        { label: T.minimize, accelerator: "CmdOrCtrl+M", role: "minimize" },
        { label: T.zoom, role: "zoom" },
        { type: "separator" },
        { label: T.bringAllToFront, role: "front" }
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
