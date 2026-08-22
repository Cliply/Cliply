// api client using electron ipc instead of http

import type { ReportEnvironment } from "@/lib/report"

/**
 * one row of the quality menu, derived from the video's own format list
 *
 * `height` and `fps` are yt-dlp's. `container` is the one a download at that
 * height really produces, and `filesize` is the video stream plus the audio it
 * will be merged with in that container - both worked out from the format list,
 * and `filesize` is `null` whenever either half is unknown, which renders a row
 * with no size rather than one claiming a number it cannot stand behind.
 */
export interface QualityTier {
  height: number
  container: "mp4" | "mkv"
  filesize: number | null
  fps: number | null
}

// what the audio menu offers: converted mp3, converted m4a, or the stream
// youtube served with no re-encode at all
export type AudioMode = "mp3" | "m4a" | "original"

/**
 * one dubbed audio language the video carries
 *
 * `code` is yt-dlp's own BCP-47 tag ("hi", "zh-Hans") and is what the download
 * request sends back; `is_original` marks the track youtube recorded in.
 */
export interface AudioTrack {
  code: string
  is_original: boolean
}

export interface DownloadProgress {
  downloadId: string
  status: "downloading" | "completed" | "failed" | "cancelled"
  progress: number
  speed?: string
  eta?: string
  filename?: string
  error?: string
  // failures now arrive as events rather than a rejected invoke, so the report
  // payload's technical detail rides along with them
  details?: string
  category?: string
  // trimmed downloads report one sweep at the end, so there is no meaningful
  // percentage to show while ffmpeg works
  indeterminate?: boolean
}

export interface DownloadStatus {
  downloadId: string
  status: "downloading" | "completed" | "failed" | "cancelled"
  progress: number
  filename?: string
  error?: string
  startTime?: number
  endTime?: number
}

export interface SystemHealth {
  timestamp: string
  engine: {
    binaryPath: string
    version: string | null
    ready: boolean
    ffmpeg: boolean
    deno: boolean
  }
  cookies: { hasValid: boolean; fileSize: number }
  downloads: { active: number; total: number }
  performance: { uptime: number; memory: number }
}

export interface DownloadPathInfo {
  path: string
  exists: boolean
  writable: boolean
}

export interface VideoInfoResponse {
  title: string
  duration: number
  duration_string: string
  thumbnail?: string | null
  uploader: string
  quality_tiers: QualityTier[]
  audio_tracks: AudioTrack[]
}

export interface PinterestVideoInfoResponse {
  title: string
  duration: number
  duration_string: string
  thumbnail: string | null
  uploader: string
}

export interface PinterestDownloadRequest {
  url: string
  format_id?: string
  // keeps the media title in the output filename
  title?: string
}

export interface PinterestDownloadResponse {
  success: boolean
  filename: string
  file_path: string
  file_size: number
  download_id: string
}

export interface TikTokVideoInfoResponse {
  title: string
  duration: number
  duration_string: string
  thumbnail: string | null
  uploader: string
}

export interface TikTokDownloadRequest {
  url: string
  format_id?: string
  // keeps the media title in the output filename
  title?: string
}

export interface TikTokDownloadResponse {
  success: boolean
  filename: string
  file_path: string
  file_size: number
  download_id: string
}

export type Platform = "youtube" | "pinterest" | "tiktok"

export type MediaInfo =
  | { platform: "youtube"; data: VideoInfoResponse }
  | { platform: "pinterest"; data: PinterestVideoInfoResponse }
  | { platform: "tiktok"; data: TikTokVideoInfoResponse }

export type DownloadRequest =
  | { platform: "youtube"; data: VideoDownloadRequest | AudioDownloadRequest }
  | { platform: "pinterest"; data: PinterestDownloadRequest }
  | { platform: "tiktok"; data: TikTokDownloadRequest }

export interface TimeRange {
  start: number // seconds
  end: number // seconds
}

export interface AudioDownloadRequest {
  url: string
  audio_mode: AudioMode
  // the dub the user picked, sent only by a video that offered a choice - its
  // absence is what leaves the download on the original track
  audio_language?: string
  // renderer-generated correlation id, so progress events can be filtered from
  // the moment the listener subscribes
  download_id?: string
  // omitted when the selection covers the whole video: yt-dlp only reports a
  // single progress sweep for a section download, and re-muxing the full video
  // through ffmpeg is slower than just downloading it
  time_range?: TimeRange
  precise_cut?: boolean
  title?: string
  output_path?: string
}

export interface VideoDownloadRequest {
  url: string
  height: number
  // the container of the row that was *displayed*, echoed back so the label the
  // user read can never disagree with the file they get
  container: "mp4" | "mkv"
  // see AudioDownloadRequest.audio_language
  audio_language?: string
  // see AudioDownloadRequest.download_id
  download_id?: string
  // see AudioDownloadRequest.time_range
  time_range?: TimeRange
  precise_cut?: boolean
  title?: string
  output_path?: string
}

export interface ApiError {
  type?: string
  message: string
  suggestion?: string
  details?: string
  category?: string
}

// download failure carrying the technical detail for issue reports
export class DownloadError extends Error {
  details?: string
  category?: string

  constructor(message: string, error?: ApiError) {
    super(message)
    this.name = "DownloadError"
    this.details = error?.details
    this.category = error?.category
  }
}

// Auto-updater types
export interface UpdateInfo {
  version: string
  releaseNotes?: string
  releaseDate?: string
  autoDownloading?: boolean
  autoInstallOnQuit?: boolean
  requiresManualDownload?: boolean
  platform?: string
}

export interface UpdateProgress {
  percent: number
  bytesPerSecond?: number
  total?: number
  transferred?: number
}

export interface UpdateStatus {
  checking?: boolean
  available?: boolean
  version?: string
  downloading?: boolean
  downloaded?: boolean
  error?: string
}

// IPC Response wrapper
interface IPCResponse<T> {
  success: boolean
  data?: T
  error?: ApiError
}

// Type for window.electronAPI
declare global {
  interface Window {
    electronAPI?: {
      video: {
        getInfo: (
          options: { url: string; platform?: string } | string
        ) => Promise<IPCResponse<VideoInfoResponse>>
        downloadCombined: (
          options: VideoDownloadRequest & { platform?: string }
        ) => Promise<
          IPCResponse<{
            filename: string
            file_path: string
            file_size: number
            download_id: string
            type: string
          }>
        >
        downloadAudio: (
          options: AudioDownloadRequest & { platform?: string }
        ) => Promise<
          IPCResponse<{
            filename: string
            file_path: string
            file_size: number
            download_id: string
            type: string
          }>
        >
      }
      pinterest: {
        getInfo: (url: string) => Promise<IPCResponse<PinterestVideoInfoResponse>>
        download: (
          options: PinterestDownloadRequest
        ) => Promise<IPCResponse<PinterestDownloadResponse>>
      }
      tiktok: {
        getInfo: (url: string) => Promise<IPCResponse<TikTokVideoInfoResponse>>
        download: (
          options: TikTokDownloadRequest
        ) => Promise<IPCResponse<TikTokDownloadResponse>>
      }
      download: {
        cancel: (
          downloadId: string
        ) => Promise<IPCResponse<{ cancelled: boolean }>>
        getStatus: (downloadId: string) => Promise<IPCResponse<DownloadStatus>>
        getAll: () => Promise<IPCResponse<DownloadStatus[]>>
        onProgress: (callback: (data: DownloadProgress) => void) => () => void
      }
      system: {
        getHealth: () => Promise<IPCResponse<SystemHealth>>
        openExternal: (
          url: string
        ) => Promise<IPCResponse<{ opened: boolean; url: string }>>
        openDownloadFolder: () => Promise<IPCResponse<{ success: boolean }>>
        selectDownloadFolder: () => Promise<IPCResponse<{ folderPath: string }>>
        getDiagnostics: () => Promise<IPCResponse<ReportEnvironment>>
      }
      settings: {
        getDownloadPath: () => Promise<IPCResponse<DownloadPathInfo>>
        setDownloadPath: (path: string) => Promise<IPCResponse<DownloadPathInfo>>
      }
      updater: {
        checkForUpdates: () => Promise<IPCResponse<{ checking: boolean }>>
        downloadUpdate: () => Promise<IPCResponse<{ downloading: boolean }>>
        installUpdate: () => Promise<IPCResponse<{ installing: boolean }>>
        forceSecurityCheck: () => Promise<IPCResponse<{ checking: boolean }>>
        onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void
        onUpdateNotAvailable: (callback: () => void) => () => void
        onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => () => void
        onDownloadProgress: (
          callback: (progress: UpdateProgress) => void
        ) => () => void
        onUpdateError: (
          callback: (error: { message: string }) => void
        ) => () => void
        onUpdateChecking: (callback: () => void) => () => void
      }
    }
  }
}

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

    if (!response.success || !response.data) {
      const errorMessage = response.error?.message || "Failed to get video info"
      console.error("Video info failed:", errorMessage)
      throw new Error(errorMessage)
    }

    return response.data
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

    if (!response.success || !response.data) {
      const errorMessage = response.error?.message || "Failed to download audio"
      console.error("Audio download failed:", errorMessage)
      throw new DownloadError(errorMessage, response.error)
    }

    // Map the response to match expected format
    return {
      downloadId: response.data.download_id
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

    if (!response.success || !response.data) {
      const errorMessage = response.error?.message || "Failed to download video"
      console.error("Video download failed:", errorMessage)
      throw new DownloadError(errorMessage, response.error)
    }

    // Map the response to match expected format
    return {
      downloadId: response.data.download_id
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

    if (!response.success || !response.data) {
      const errorMessage =
        response.error?.message || "Failed to get Pinterest video info"
      console.error("Pinterest info failed:", errorMessage)
      throw new Error(errorMessage)
    }

    return response.data
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

    if (!response.success || !response.data) {
      const errorMessage =
        response.error?.message || "Failed to download Pinterest video"
      console.error("Pinterest download failed:", errorMessage)
      throw new DownloadError(errorMessage, response.error)
    }

    return {
      downloadId: response.data.download_id
    }
  }
}

export const tiktokApi = {
  async getInfo(url: string): Promise<TikTokVideoInfoResponse> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.tiktok.getInfo(url)

    if (!response.success || !response.data) {
      const errorMessage =
        response.error?.message || "Failed to get TikTok video info"
      console.error("TikTok info failed:", errorMessage)
      throw new Error(errorMessage)
    }

    return response.data
  },

  async download(
    request: TikTokDownloadRequest
  ): Promise<{ downloadId: string }> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.tiktok.download(request)

    if (!response.success || !response.data) {
      const errorMessage =
        response.error?.message || "Failed to download TikTok video"
      console.error("TikTok download failed:", errorMessage)
      throw new DownloadError(errorMessage, response.error)
    }

    return {
      downloadId: response.data.download_id
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

    if (!response.success || !response.data) {
      throw new Error(
        response.error?.message || "Failed to get download status"
      )
    }

    return response.data
  },

  /**
   * Get all downloads
   * @returns Promise<DownloadStatus[]>
   */
  async getAllDownloads(): Promise<DownloadStatus[]> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.download.getAll()

    if (!response.success) {
      throw new Error(response.error?.message || "Failed to get downloads")
    }

    return response.data || []
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

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || "Failed to get system health")
    }

    return response.data
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

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || "Failed to get download path")
    }

    return response.data
  },

  /**
   * Set new download path
   * @param path New download path
   * @returns Promise<DownloadPathInfo>
   */
  async setDownloadPath(path: string): Promise<DownloadPathInfo> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.settings.setDownloadPath(path)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || "Failed to set download path")
    }

    return response.data
  }
}

export const extractVideoId = (url: string): string | null => {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([^"&?/\s]{11})/)
  return match ? match[1] : null
}

export const isYouTubeShorts = (url: string): boolean => {
  return /\/shorts\//.test(url.toLowerCase())
}

export const formatFileSize = (bytes?: number | null): string => {
  if (!bytes) return "Unknown size"
  const sizes = ["Bytes", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i]
}

/**
 * a language code as a name a person reads: "hi" -> "Hindi", "zh-Hans" ->
 * "Simplified Chinese"
 *
 * `Intl.DisplayNames` is the browser's own CLDR data, which is the whole point:
 * a hand-written table of 22 languages would be exactly the invented vocabulary
 * this revamp deleted, and it would go stale the moment youtube adds a dub.
 * A tag it cannot name (or one malformed enough to throw) falls back to the
 * code itself, which is still something the user can act on.
 */
export const languageName = (code: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code
  } catch {
    return code
  }
}

export const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`
}

export const secondsToTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`
}

export const timeToSeconds = (time: string): number => {
  const parts = time.split(":").map(Number)
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  return parts[0] || 0
}

export const validateTimeRange = (
  start: number,
  end: number,
  duration: number
): { isValid: boolean; error?: string } => {
  if (start < 0) {
    return { isValid: false, error: "Start time cannot be negative" }
  }

  if (end > duration) {
    return { isValid: false, error: "End time exceeds video duration" }
  }

  if (start >= end) {
    return { isValid: false, error: "End time must be greater than start time" }
  }

  return { isValid: true }
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

    if (!response.success) {
      console.error("Update check failed:", response.error?.message)
      throw new Error(response.error?.message || "Failed to check for updates")
    }
    return response.data?.checking === true
  },

  /**
   * Download available update
   * @returns Promise<boolean> Whether download started successfully
   */
  async downloadUpdate(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.updater.downloadUpdate()

    if (!response.success) {
      console.error("Update download failed:", response.error?.message)
      throw new Error(response.error?.message || "Failed to download update")
    }
    return response.data?.downloading === true
  },

  /**
   * Install downloaded update (quits and restarts app)
   * @returns Promise<boolean> Whether install started successfully
   */
  async installUpdate(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.updater.installUpdate()

    if (!response.success) {
      console.error("Update install failed:", response.error?.message)
      throw new Error(response.error?.message || "Failed to install update")
    }
    return response.data?.installing === true
  },

  /**
   * Force check for security updates (for emergency API key rotation)
   * @returns Promise<boolean> Whether check started successfully
   */
  async forceSecurityCheck(): Promise<boolean> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.updater.forceSecurityCheck()

    if (!response.success) {
      console.error("Force security check failed:", response.error?.message)
      throw new Error(
        response.error?.message || "Failed to check for security updates"
      )
    }
    return response.data?.checking === true
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
