// the native menu bar: what it says, and what its items do.
//
// built once startup is ready and again whenever the engine version on it
// goes stale, so it is handed the running app rather than reading anything
// of its own: the window it raises its boxes over, the ipc handlers its
// items call into, and the analytics service its checkbox writes through.

const { app, Menu, shell, dialog } = require("electron")
const { getAppVersion } = require("./utils/analytics-helpers")

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

// create application menu
function createMenu(cliplyApp) {
  // synchronous on purpose: the menu is built during startup and again after
  // an update lands, and neither moment can wait on a --version probe
  const engineVersion = cliplyApp.services.ytdlpEngine.getKnownVersion()

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
            if (cliplyApp.mainWindow) {
              cliplyApp.mainWindow.webContents.send("menu:new-download")
            }
          }
        },
        { type: "separator" },
        {
          label: T.openDownloads,
          accelerator: "CmdOrCtrl+D",
          click: async () => {
            try {
              if (cliplyApp.ipcHandlers) {
                await cliplyApp.ipcHandlers.handleOpenDownloadFolder()
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
              if (cliplyApp.ipcHandlers) {
                const result = await cliplyApp.ipcHandlers.handleCheckForUpdates()

                if (result.success) {
                  // update notification component handles ui feedback
                } else {
                  console.error("Update check failed:", result.error?.message)
                  dialog.showMessageBox(cliplyApp.mainWindow, {
                    type: "error",
                    title: T.updateCheckFailed,
                    message: T.updateCheckFailedMessage,
                    detail:
                      result.error?.message || T.updateCheckFailedDetail,
                    buttons: ["OK"]
                  })
                }
              } else {
                dialog.showMessageBox(cliplyApp.mainWindow, {
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
          checked: cliplyApp.services.analytics.isEnabled(),
          click: async (menuItem) => {
            // through the service, never the store: the opt-out gate is only
            // re-read at init(), so writing the preference behind its back
            // leaves this session sending for the rest of its life
            const result = await cliplyApp.services.analytics.setEnabled(
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
              menuItem.checked = cliplyApp.services.analytics.isEnabled()
              dialog.showMessageBox(cliplyApp.mainWindow, {
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
            dialog.showMessageBox(cliplyApp.mainWindow, {
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
              if (cliplyApp.ipcHandlers) {
                const health = await cliplyApp.ipcHandlers.handleSystemHealth()

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

                dialog.showMessageBox(cliplyApp.mainWindow, {
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
  cliplyApp.menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(cliplyApp.menu)
}

module.exports = {
  MENU_TEXT,
  createMenu
}
