/**
 * preload script - bridge between main and renderer processes
 * exposes secure ipc communication to the frontend
 */

const { contextBridge, ipcRenderer } = require("electron")

// ipc channels for communication
const IPC_CHANNELS = {
  // video operations
  VIDEO_GET_INFO: "video:get-info",
  VIDEO_DOWNLOAD_COMBINED: "video:download-combined",
  AUDIO_DOWNLOAD: "audio:download",

  // playlist operations
  PLAYLIST_GET_INFO: "playlist:get-info",
  PLAYLIST_DOWNLOAD: "playlist:download",

  // download management
  DOWNLOAD_PROGRESS: "download:progress",
  // the whole list, pushed after every change to it
  DOWNLOADS_LIST: "downloads:list",
  SUPPORT_MILESTONE: "support:milestone",
  DOWNLOAD_COMPLETE: "download:complete",
  DOWNLOAD_ERROR: "download:error",
  DOWNLOAD_CANCEL: "download:cancel",

  // cookie management
  COOKIES_TEST: "cookies:test",
  COOKIES_STATUS: "cookies:status",


  // auto-updater
  UPDATE_CHECK: "update:check",
  UPDATE_DOWNLOAD: "update:download",
  UPDATE_INSTALL: "update:install",
  UPDATE_CHECKING: "update:checking",
  UPDATE_AVAILABLE: "update:available",
  UPDATE_NOT_AVAILABLE: "update:not-available",
  UPDATE_DOWNLOAD_PROGRESS: "update:download-progress",
  UPDATE_DOWNLOADED: "update:downloaded",
  UPDATE_ERROR: "update:error",
  UPDATE_SECURITY_CRITICAL: "update:security-critical",

  // system
  SYSTEM_HEALTH: "system:health",
  SYSTEM_OPEN_EXTERNAL: "system:open-external",
  SYSTEM_GET_DIAGNOSTICS: "system:get-diagnostics",

  // telemetry
  ANALYTICS_TRACK: "analytics:track"
}

// simple invoke wrapper
const invoke = async (channel, data) => {
  try {
    return await ipcRenderer.invoke(channel, data)
  } catch (error) {
    console.error(`IPC call failed for channel ${channel}:`, error)
    return {
      success: false,
      error: {
        message: "Communication error with main process",
        suggestion: "Please try again or restart the application"
      }
    }
  }
}

// expose ipc api to renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  // video operations
  video: {
    getInfo: (options) => {
      const payload = typeof options === "string" ? { url: options } : options
      return invoke(IPC_CHANNELS.VIDEO_GET_INFO, payload)
    },
    downloadCombined: (options) =>
      invoke(IPC_CHANNELS.VIDEO_DOWNLOAD_COMBINED, options),
    downloadAudio: (options) => invoke(IPC_CHANNELS.AUDIO_DOWNLOAD, options)
  },

  // playlist operations. a playlist is one download covering n videos, so it
  // reports through the same download:progress channel the single-video flows
  // use - there is nothing extra to subscribe to
  playlist: {
    getInfo: (options) => {
      const payload = typeof options === "string" ? { url: options } : options
      return invoke(IPC_CHANNELS.PLAYLIST_GET_INFO, payload)
    },
    download: (options) => invoke(IPC_CHANNELS.PLAYLIST_DOWNLOAD, options)
  },

  // pinterest operations
  pinterest: {
    getInfo: (url) =>
      invoke(IPC_CHANNELS.VIDEO_GET_INFO, { url, platform: "pinterest" }),
    download: (options) =>
      invoke(IPC_CHANNELS.VIDEO_DOWNLOAD_COMBINED, {
        ...options,
        platform: "pinterest"
      })
  },

  // tiktok operations
  tiktok: {
    getInfo: (url) =>
      invoke(IPC_CHANNELS.VIDEO_GET_INFO, { url, platform: "tiktok" }),
    download: (options) =>
      invoke(IPC_CHANNELS.VIDEO_DOWNLOAD_COMBINED, {
        ...options,
        platform: "tiktok"
      })
  },

  // download management
  download: {
    cancel: (downloadId) =>
      invoke(IPC_CHANNELS.DOWNLOAD_CANCEL, { downloadId }),
    getStatus: (downloadId) => invoke("download:get-status", { downloadId }),
    // the whole list, read once at startup and after that only if something
    // needs a re-sync: main pushes it on downloads:list whenever it changes
    getList: () => invoke("download:get-list"),
    clearHistory: () => invoke("download:clear-history"),
    removeHistory: (downloadId) =>
      invoke("download:remove-history", { downloadId }),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.DOWNLOAD_PROGRESS, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.DOWNLOAD_PROGRESS, handler)
    },
    // the list itself, pushed after every change to it: a reservation, a slot
    // taken, a settle, a clear, a removal. never for progress
    onList: (callback) => {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.DOWNLOADS_LIST, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.DOWNLOADS_LIST, handler)
    }
  },

  // the coffee ask, on the rare download that reaches a milestone
  support: {
    onMilestone: (callback) => {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.SUPPORT_MILESTONE, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.SUPPORT_MILESTONE, handler)
    }
  },

  // cookie management
  cookies: {
    importFile: () => invoke("cookies:import-file"),
    test: () => invoke(IPC_CHANNELS.COOKIES_TEST),
    getStatus: () => invoke(IPC_CHANNELS.COOKIES_STATUS),
    clear: () => invoke("cookies:clear")
  },


  // system operations
  system: {
    getHealth: () => invoke(IPC_CHANNELS.SYSTEM_HEALTH),
    openExternal: (url) => invoke(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url }),
    getDiagnostics: () => invoke(IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS),
    openDownloadFolder: () => invoke("system:open-download-folder"),
    // the folder a file landed in, with the file selected. main refuses any
    // path outside the download folder (see handleShowInFolder in
    // ipc-handlers.js), so a row whose file has moved falls back to
    // openDownloadFolder rather than revealing something else
    showInFolder: (path) => invoke("system:show-in-folder", { path }),
    selectDownloadFolder: () => invoke("system:select-download-folder")
  },

  // telemetry. main owns the opt-out gate, the event allowlist and the
  // redaction, so this is a pipe and nothing more
  analytics: {
    track: (event, properties) =>
      invoke(IPC_CHANNELS.ANALYTICS_TRACK, { event, properties })
  },

  // settings operations
  settings: {
    getDownloadPath: () => invoke("settings:get-download-path"),
    // how many downloads this install has ever finished, for the number at the
    // top of the panel. the same counter the support milestones are counted by
    getDownloadCount: () => invoke("settings:get-download-count"),
    setDownloadPath: (path) => invoke("settings:set-download-path", { path })
  },

  // menu event listeners
  menu: {
    onEvent: (event, callback) => {
      const channel = `menu:${event}`
      const handler = (_, data) => callback(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },

  // auto-updater
  updater: {
    checkForUpdates: () => invoke(IPC_CHANNELS.UPDATE_CHECK),
    downloadUpdate: () => invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),
    installUpdate: () => invoke(IPC_CHANNELS.UPDATE_INSTALL),
    forceSecurityCheck: () => invoke("update:force-security-check"),

    onUpdateChecking: (callback) => {
      const handler = () => callback()
      ipcRenderer.on(IPC_CHANNELS.UPDATE_CHECKING, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_CHECKING, handler)
    },

    onUpdateAvailable: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.UPDATE_AVAILABLE, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_AVAILABLE, handler)
    },

    onUpdateNotAvailable: (callback) => {
      const handler = () => callback()
      ipcRenderer.on(IPC_CHANNELS.UPDATE_NOT_AVAILABLE, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_NOT_AVAILABLE, handler)
    },

    onDownloadProgress: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, handler)
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS,
          handler
        )
    },

    onUpdateDownloaded: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOADED, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_DOWNLOADED, handler)
    },

    onUpdateError: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.UPDATE_ERROR, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_ERROR, handler)
    },

    onSecurityUpdate: (callback) => {
      const handler = (_, data) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.UPDATE_SECURITY_CRITICAL, handler)
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_SECURITY_CRITICAL, handler)
    }
  },

  // platform info
  platform: {
    isWindows: process.platform === "win32",
    isMacOS: process.platform === "darwin",
    isLinux: process.platform === "linux",
    platform: process.platform,
    arch: process.arch,
    versions: process.versions
  }
})

