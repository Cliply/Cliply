// api client using electron ipc instead of http

import type { ReportEnvironment } from "@/lib/report"

import {
  CookieError,
  DownloadError,
  type ApiError,
  type AudioDownloadRequest,
  type CookieImportResult,
  type CookieStatus,
  type CookieTestResult,
  type DownloadHistoryRow,
  type DownloadPathInfo,
  type DownloadProgress,
  type DownloadStatus,
  type PinterestDownloadRequest,
  type PinterestVideoInfoResponse,
  type PlaylistDownloadRequest,
  type PlaylistInfoResponse,
  type SystemHealth,
  type TikTokDownloadRequest,
  type TikTokVideoInfoResponse,
  type UpdateInfo,
  type UpdateProgress,
  type VideoDownloadRequest,
  type VideoInfoResponse
} from "./api-types"
import type { IPCResponse } from "./electron-api"

// the types and the pure helpers used to live here, so they are re-exported
// under this name: every importer of this module still reads them here
export * from "./api-types"
export * from "./format"

// Helper function to get electronAPI
const getElectronAPI = () => {
  if (typeof window === "undefined" || !window.electronAPI) {
    throw new Error("Electron API not available")
  }
  return window.electronAPI
}

// Helper function to check if running in Electron
const isElectron = () => {
  return typeof window !== "undefined" && window.electronAPI
}

/** builds the failure a call site throws out of what main sent back */
type ErrorFactory = (message: string, error?: ApiError) => Error

const downloadError: ErrorFactory = (message, error) =>
  new DownloadError(message, error)
const plainError: ErrorFactory = (message) => new Error(message)
const cookieError: ErrorFactory = (message, error) =>
  new CookieError(message, error?.code)

interface UnwrapOptions {
  /** what to throw. the default is what most of these calls throw */
  makeError?: ErrorFactory
  /** logged with the resolved message before throwing, for the calls that log */
  log?: string
}

/**
 * the payload of an IPC response, or the failure the call site would throw
 *
 * every request below answers the same shape, so every request below used to
 * repeat the same check: is it a success, did a payload come with it, and if
 * not, throw main's message or a fallback of our own. this is that check, once.
 *
 * the error comes from a factory rather than a class because the three
 * failures thrown here do not share a constructor: `DownloadError` reads
 * `details` and `category` off the payload, `CookieError` reads `code`, and a
 * bare `Error` reads nothing at all.
 *
 * that last one is the asymmetry worth naming here: 12 of these calls throw a
 * plain `Error` and so drop `.category` on the floor, which leaves the UI on
 * its generic wording even when main said precisely what went wrong. it is
 * kept that way on purpose - which calls should carry a category is a decision
 * for the download queue to make, not a refactor.
 *
 * `requireData: false` is for the handful that only need to know the call went
 * through: they read the payload themselves, and a missing one is not a
 * failure to them.
 */
function unwrap<T>(
  response: IPCResponse<T>,
  fallbackMessage: string,
  options?: UnwrapOptions & { requireData?: true }
): T
function unwrap<T>(
  response: IPCResponse<T>,
  fallbackMessage: string,
  options: UnwrapOptions & { requireData: false }
): T | undefined
function unwrap<T>(
  response: IPCResponse<T>,
  fallbackMessage: string,
  options: UnwrapOptions & { requireData?: boolean } = {}
): T | undefined {
  const { makeError = downloadError, log, requireData = true } = options

  if (!response.success || (requireData && !response.data)) {
    const message = response.error?.message || fallbackMessage
    if (log) console.error(log, message)
    throw makeError(message, response.error)
  }

  return response.data
}

// Video API functions
export const videoApi = {
  /**
   * Get video information and formats
   * @param url Video URL
   * @returns Promise<VideoInfoResponse>
   */
  async getVideoInfo(url: string): Promise<VideoInfoResponse> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.video.getInfo(url)

    return unwrap(response, "Failed to get video info", {
      log: "Video info failed:"
    })
  },

  /**
   * Download audio segment
   * @param request Audio download request
   * @returns Promise<{downloadId: string}>
   */
  async downloadAudio(
    request: AudioDownloadRequest
  ): Promise<{ downloadId: string }> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.video.downloadAudio(request)

    const data = unwrap(response, "Failed to download audio", {
      log: "Audio download failed:"
    })

    // Map the response to match expected format
    return {
      downloadId: data.download_id
    }
  },

  /**
   * Download combined video + audio segment
   * @param request Video download request
   * @returns Promise<{downloadId: string}>
   */
  async downloadVideo(
    request: VideoDownloadRequest
  ): Promise<{ downloadId: string }> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.video.downloadCombined(request)

    const data = unwrap(response, "Failed to download video", {
      log: "Video download failed:"
    })

    // Map the response to match expected format
    return {
      downloadId: data.download_id
    }
  }
}

/**
 * playlists: list one, then download the rows the user ticked
 *
 * mirrors videoApi. the download resolves as soon as the process is running -
 * everything after that arrives on `downloadApi.onProgress`, under the one id
 * this returns, because a playlist is one download covering n files.
 */
export const playlistApi = {
  /**
   * List the videos a playlist link holds
   * @param url Playlist URL
   * @returns Promise<PlaylistInfoResponse>
   */
  async getPlaylistInfo(url: string): Promise<PlaylistInfoResponse> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.playlist.getInfo(url)

    return unwrap(response, "Failed to get playlist info", {
      log: "Playlist info failed:"
    })
  },

  /**
   * Download the selected videos of a playlist
   * @param request Playlist download request
   * @returns Promise<{downloadId: string, itemsTotal: number}>
   */
  async download(
    request: PlaylistDownloadRequest
  ): Promise<{ downloadId: string; itemsTotal: number }> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.playlist.download(request)

    const data = unwrap(response, "Failed to download playlist", {
      log: "Playlist download failed:"
    })

    return {
      downloadId: data.download_id,
      // what main accepted, which is the selection it validated rather than
      // the one that was sent
      itemsTotal: data.items_total
    }
  }
}

export const pinterestApi = {
  /**
   * Get Pinterest video information
   * @param url Pinterest URL
   * @returns Promise<PinterestVideoInfoResponse>
   */
  async getInfo(url: string): Promise<PinterestVideoInfoResponse> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.pinterest.getInfo(url)

    return unwrap(response, "Failed to get Pinterest video info", {
      log: "Pinterest info failed:"
    })
  },

  /**
   * Download Pinterest video
   * @param request Pinterest download request
   * @returns Promise<{downloadId: string}>
   */
  async download(
    request: PinterestDownloadRequest
  ): Promise<{ downloadId: string }> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.pinterest.download(request)

    const data = unwrap(response, "Failed to download Pinterest video", {
      log: "Pinterest download failed:"
    })

    return {
      downloadId: data.download_id
    }
  }
}

export const tiktokApi = {
  async getInfo(url: string): Promise<TikTokVideoInfoResponse> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.tiktok.getInfo(url)

    return unwrap(response, "Failed to get TikTok video info", {
      log: "TikTok info failed:"
    })
  },

  async download(
    request: TikTokDownloadRequest
  ): Promise<{ downloadId: string }> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.tiktok.download(request)

    const data = unwrap(response, "Failed to download TikTok video", {
      log: "TikTok download failed:"
    })

    return {
      downloadId: data.download_id
    }
  }
}

// Download management functions
export const downloadApi = {
  /**
   * Cancel a download
   * @param downloadId Download ID
   * @returns Promise<boolean>
   */
  async cancelDownload(downloadId: string): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.download.cancel(downloadId)
    return response.success && response.data?.cancelled === true
  },

  /**
   * Get download status
   * @param downloadId Download ID
   * @returns Promise<DownloadStatus>
   */
  async getDownloadStatus(downloadId: string): Promise<DownloadStatus> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.download.getStatus(downloadId)

    return unwrap(response, "Failed to get download status", {
      makeError: plainError
    })
  },

  /**
   * Get all downloads
   * @returns Promise<DownloadStatus[]>
   */
  async getAllDownloads(): Promise<DownloadStatus[]> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.download.getAll()

    return (
      unwrap(response, "Failed to get downloads", {
        makeError: plainError,
        requireData: false
      }) || []
    )
  },

  /**
   * The downloads this install remembers, newest first. Read once, at startup:
   * every later change to a live row arrives on `onProgress` instead.
   * @returns Promise<DownloadHistoryRow[]>
   */
  async getHistory(): Promise<DownloadHistoryRow[]> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.download.getHistory()

    return (
      unwrap(response, "Failed to get the download history", {
        makeError: plainError,
        requireData: false
      }) || []
    )
  },

  /**
   * Forget every finished row. A download still queued or running keeps its
   * row, because it has events still to come.
   * @returns Promise<DownloadHistoryRow[]> what is left
   */
  async clearHistory(): Promise<DownloadHistoryRow[]> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.download.clearHistory()

    return (
      unwrap(response, "Failed to clear the download history", {
        makeError: plainError,
        requireData: false
      }) || []
    )
  },

  /**
   * Forget one finished row. It says nothing about the download itself, and
   * main ignores it for a row that is still live: cancelling one is what
   * `cancelDownload` is for.
   * @param downloadId Download ID
   * @returns Promise<DownloadHistoryRow[]> what is left
   */
  async removeHistory(downloadId: string): Promise<DownloadHistoryRow[]> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.download.removeHistory(downloadId)

    return (
      unwrap(response, "Failed to remove that download", {
        makeError: plainError,
        requireData: false
      }) || []
    )
  },

  /**
   * Listen for download progress updates
   * @param callback Progress callback function
   * @returns Cleanup function
   */
  onProgress(callback: (data: DownloadProgress) => void): () => void {
    const electronAPI = getElectronAPI()
    return electronAPI.download.onProgress(callback)
  }
}

// System functions
export const systemApi = {
  /**
   * Get system health information
   * @returns Promise<SystemHealth>
   */
  async getHealth(): Promise<SystemHealth> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.system.getHealth()

    return unwrap(response, "Failed to get system health", {
      makeError: plainError
    })
  },

  /**
   * Open downloads folder in system file manager
   * @returns Promise<boolean>
   */
  async openDownloadFolder(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.system.openDownloadFolder()
    return response.success === true
  },

  /**
   * Open external URL in system browser
   * @param url External URL
   * @returns Promise<boolean>
   */
  async openExternal(url: string): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.system.openExternal(url)
    return response.success === true
  },

  /**
   * Environment info for issue reports (null when unavailable)
   */
  async getDiagnostics(): Promise<ReportEnvironment | null> {
    try {
      const electronAPI = getElectronAPI()
      const response = await electronAPI.system.getDiagnostics()
      return response.success && response.data ? response.data : null
    } catch {
      return null
    }
  },

  /**
   * Select download folder via file dialog
   * @returns Promise<string | null>
   */
  async selectDownloadFolder(): Promise<string | null> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.system.selectDownloadFolder()

    // the one response here that is not unwrapped: cancelling the picker is a
    // failed response and must read as "no folder chosen", never as a throw
    if (!response.success || !response.data) {
      return null
    }

    return response.data.folderPath
  }
}

// Settings API functions
export const settingsApi = {
  /**
   * Get current download path information
   * @returns Promise<DownloadPathInfo>
   */
  async getDownloadPath(): Promise<DownloadPathInfo> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.settings.getDownloadPath()

    return unwrap(response, "Failed to get download path", {
      makeError: plainError
    })
  },

  /**
   * Set new download path
   * @param path New download path
   * @returns Promise<DownloadPathInfo>
   */
  async setDownloadPath(path: string): Promise<DownloadPathInfo> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.settings.setDownloadPath(path)

    return unwrap(response, "Failed to set download path", {
      makeError: plainError
    })
  }
}

export const cookiesApi = {
  /**
   * What the jar on disk holds. Read fresh on every call - main re-reads the
   * file rather than caching, because expiry is a function of the clock and
   * yt-dlp rewrites the jar after every download.
   */
  async getStatus(): Promise<CookieStatus> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.cookies.getStatus()

    return unwrap(response, "couldn't read the cookie status", {
      makeError: plainError
    })
  },

  /**
   * Opens the native file picker in main and imports what comes back.
   * Cancelling is a failed response, not a throw, so it reads as "nothing
   * happened" rather than an error.
   */
  async importFile(): Promise<CookieImportResult | null> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.cookies.importFile()

    if (!response.success && response.error?.message === "No file selected") {
      return null
    }

    return (
      unwrap(response, "couldn't import those cookies", {
        makeError: cookieError,
        requireData: false
      }) ?? null
    )
  },

  async test(): Promise<CookieTestResult> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.cookies.test()

    return unwrap(response, "Failed to test cookies", { makeError: plainError })
  },

  /**
   * Removing a login is the one thing that must not fail quietly - a swallowed
   * error left the credentials on disk behind a screen reporting them gone.
   */
  async clear(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.cookies.clear()

    unwrap(response, "couldn't remove the cookies", {
      makeError: plainError,
      requireData: false
    })

    return true
  }
}

// Auto-updater API
export const updaterApi = {
  /**
   * Check for updates
   * @returns Promise<boolean> Whether checking started successfully
   */
  async checkForUpdates(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.updater.checkForUpdates()

    const data = unwrap(response, "Failed to check for updates", {
      makeError: plainError,
      log: "Update check failed:",
      requireData: false
    })
    return data?.checking === true
  },

  /**
   * Download available update
   * @returns Promise<boolean> Whether download started successfully
   */
  async downloadUpdate(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.updater.downloadUpdate()

    const data = unwrap(response, "Failed to download update", {
      makeError: plainError,
      log: "Update download failed:",
      requireData: false
    })
    return data?.downloading === true
  },

  /**
   * Install downloaded update (quits and restarts app)
   * @returns Promise<boolean> Whether install started successfully
   */
  async installUpdate(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.updater.installUpdate()

    const data = unwrap(response, "Failed to install update", {
      makeError: plainError,
      log: "Update install failed:",
      requireData: false
    })
    return data?.installing === true
  },

  /**
   * Force check for security updates (for emergency API key rotation)
   * @returns Promise<boolean> Whether check started successfully
   */
  async forceSecurityCheck(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.updater.forceSecurityCheck()

    const data = unwrap(response, "Failed to check for security updates", {
      makeError: plainError,
      log: "Force security check failed:",
      requireData: false
    })
    return data?.checking === true
  },

  /**
   * Subscribe to update events
   */
  events: {
    onUpdateAvailable: (callback: (info: UpdateInfo) => void) => {
      if (!isElectron()) return () => {}
      return window.electronAPI!.updater.onUpdateAvailable(callback)
    },

    onUpdateNotAvailable: (callback: () => void) => {
      if (!isElectron()) return () => {}
      return window.electronAPI!.updater.onUpdateNotAvailable(callback)
    },

    onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => {
      if (!isElectron()) return () => {}
      return window.electronAPI!.updater.onUpdateDownloaded(callback)
    },

    onDownloadProgress: (callback: (progress: UpdateProgress) => void) => {
      if (!isElectron()) return () => {}
      return window.electronAPI!.updater.onDownloadProgress(callback)
    },

    onUpdateError: (callback: (error: { message: string }) => void) => {
      if (!isElectron()) return () => {}
      return window.electronAPI!.updater.onUpdateError(callback)
    },

    onUpdateChecking: (callback: () => void) => {
      if (!isElectron()) return () => {}
      return window.electronAPI!.updater.onUpdateChecking(callback)
    }
  }
}
