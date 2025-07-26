// api client using electron ipc instead of http

export interface VideoFormat {
  format_id: string
  quality: string
  ext: string
  filesize?: number | null
  type: string // "combined" | "video" | "audio"
  height?: number
  width?: number
  fps?: number
  vcodec?: string
  acodec?: string
  abr?: number
  vbr?: number
  tbr?: number
  protocol?: string
  format_note?: string
}

export interface RecommendedFormats {
  best_video?: VideoFormat
  best_audio?: VideoFormat
  best_combined?: VideoFormat
}

export interface DownloadProgress {
  downloadId: string
  status: "downloading" | "completed" | "failed" | "cancelled"
  progress: number
  speed?: string
  eta?: string
  filename?: string
  error?: string
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
  ytDlpVersion?: string
  ffmpegVersion?: string
  downloadFolder: string
  diskSpace?: number
  activeDownloads: number
}

export interface VideoInfoResponse {
  title: string
  duration: number
  duration_string: string
  thumbnail?: string | null
  uploader: string
  view_count?: number
  upload_date?: string
  video_formats: VideoFormat[]
  audio_formats: VideoFormat[]
  recommendations?: RecommendedFormats
  description?: string
  tags?: string[]
  categories?: string[]
}

export interface TimeRange {
  start: number // seconds
  end: number // seconds
}

export interface AudioDownloadRequest {
  url: string
  format_id: string
  time_range: TimeRange
  precise_cut?: boolean
  title?: string
  output_path?: string
}

export interface VideoDownloadRequest {
  url: string
  video_format_id: string
  audio_format_id: string
  time_range: TimeRange
  precise_cut?: boolean
  title?: string
  output_path?: string
}

export interface ApiError {
  type?: string
  message: string
  suggestion?: string
}

export interface VideoQualityOption {
  label: string // "1080p", "720p", etc.
  format: VideoFormat
  type: "video-only" | "combined"
}

// Auto-updater types
export interface UpdateInfo {
  version: string
  releaseNotes?: string
  releaseDate?: string
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
        getInfo: (url: string) => Promise<IPCResponse<VideoInfoResponse>>
        downloadCombined: (options: VideoDownloadRequest) => Promise<
          IPCResponse<{
            filename: string
            file_path: string
            file_size: number
            download_id: string
            type: string
          }>
        >
        downloadAudio: (options: AudioDownloadRequest) => Promise<
          IPCResponse<{
            filename: string
            file_path: string
            file_size: number
            download_id: string
            type: string
          }>
        >
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
        selectDownloadFolder: () => Promise<IPCResponse<{ path: string }>>
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
        onSecurityUpdate: (
          callback: (
            info: UpdateInfo & { isSecurity: boolean; message: string }
          ) => void
        ) => () => void
      }
      server: {
        onStarting: (callback: () => void) => () => void
        onReady: (callback: () => void) => () => void
        onError: (callback: (error: { message: string }) => void) => () => void
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
      throw new Error(errorMessage)
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
      throw new Error(errorMessage)
    }

    // Map the response to match expected format
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
   * Select download folder via file dialog
   * @returns Promise<string | null>
   */
  async selectDownloadFolder(): Promise<string | null> {
    const electronAPI = getElectronAPI()
    const response = await electronAPI.system.selectDownloadFolder()

    if (!response.success || !response.data) {
      return null
    }

    return response.data.path
  }
}

// Utility functions (unchanged from original)
export const extractVideoId = (url: string): string | null => {
  const regex =
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/
  const match = url.match(regex)
  return match ? match[1] : null
}

export const formatFileSize = (bytes?: number | null): string => {
  if (!bytes) return "Unknown size"
  const sizes = ["Bytes", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i]
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

export const selectBestAudioFormat = (
  formats: VideoFormat[]
): VideoFormat | null => {
  // first try to find high quality audio
  const highQuality = formats.find((format) => 
    format.type === "audio" && format.quality === "High Quality"
  )
  if (highQuality) return highQuality

  // fallback to medium quality
  const mediumQuality = formats.find((format) => 
    format.type === "audio" && format.quality === "Medium Quality"
  )
  if (mediumQuality) return mediumQuality

  // last resort - any audio format
  return (
    formats.find((format) => {
      if (format.type === "audio") {
        return true
      }

      if (
        format.ext &&
        ["m4a", "webm", "mp3", "aac", "opus"].includes(format.ext.toLowerCase())
      ) {
        if (!format.height && !format.width && !format.fps) {
          return true
        }
      }

      if (
        format.format_note &&
        format.format_note.toLowerCase().includes("audio only")
      ) {
        return true
      }

      if (format.acodec && format.acodec !== "none" && format.acodec !== null) {
        if (
          !format.vcodec ||
          format.vcodec === "none" ||
          format.vcodec === null
        ) {
          return true
        }
      }

      return false
    }) || null
  )
}

export const selectBestVideoFormat = (
  formats: VideoFormat[],
  maxHeight?: number
): VideoFormat | null => {
  // Robust video format detection
  let filtered = formats.filter((format) => {
    // Check format type first
    if (format.type === "video" || format.type === "combined") {
      return true
    }

    // Check for video indicators
    if (format.height && format.height > 0) {
      return true
    }

    // Check video codec (fallback)
    if (format.vcodec && format.vcodec !== "none" && format.vcodec !== null) {
      return true
    }

    return false
  })

  if (maxHeight) {
    filtered = filtered.filter((f) => !f.height || f.height <= maxHeight)
  }

  return filtered.sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null
}

export const filterFormatsByQuality = (
  formats: VideoFormat[],
  targetHeight: number
): VideoFormat[] => {
  return formats.filter((f) => f.height === targetHeight)
}

export const getVideoQualityOptions = (
  videoFormats: VideoFormat[]
): VideoQualityOption[] => {
  const qualityMap = new Map<string, VideoQualityOption>()

  videoFormats.forEach((format) => {
    // Extract quality from the quality field
    const quality = extractQualityLabel(format.quality)

    // Include both video-only and combined formats
    if (quality && (format.type === "video" || format.type === "combined")) {
      const existing = qualityMap.get(quality)

      // Prefer better formats (higher file size, better type)
      if (!existing || isFormatBetter(format, existing.format)) {
        qualityMap.set(quality, {
          label: quality,
          format,
          type: format.type === "combined" ? "combined" : "video-only"
        })
      }
    }
  })

  // Sort by quality (highest first)
  return Array.from(qualityMap.values()).sort((a, b) => {
    const aNum = parseInt(a.label.replace(/\D/g, ""))
    const bNum = parseInt(b.label.replace(/\D/g, ""))
    return bNum - aNum
  })
}

const extractQualityLabel = (quality: string): string | null => {
  // Common quality patterns
  const patterns = [
    /(\d{3,4}p)/, // 1080p, 720p, 480p, etc.
    /(\d{3,4})/ // Just numbers
  ]

  for (const pattern of patterns) {
    const match = quality.match(pattern)
    if (match) {
      return match[1].includes("p") ? match[1] : `${match[1]}p`
    }
  }

  return null
}

const isFormatBetter = (
  formatA: VideoFormat,
  formatB: VideoFormat
): boolean => {
  // Prefer combined formats over video-only
  if (formatA.type !== formatB.type) {
    return formatA.type === "combined"
  }

  // Prefer larger file size (usually better quality)
  const sizeA = formatA.filesize || 0
  const sizeB = formatB.filesize || 0

  return sizeA > sizeB
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
    },

    onSecurityUpdate: (
      callback: (
        info: UpdateInfo & { isSecurity: boolean; message: string }
      ) => void
    ) => {
      if (!isElectron()) return () => {}
      return window.electronAPI!.updater.onSecurityUpdate(callback)
    }
  }
}
