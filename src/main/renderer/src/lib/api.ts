// api client using electron ipc instead of http

import type { Key } from "@/lib/i18n"
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
  /**
   * the stable name of a wording main chose over its category's own.
   *
   * a playlist run that cannot write its record of the download fails as a
   * PERMISSION_ERROR, exactly like a download folder we cannot write to, and
   * the two want opposite advice: one is Cliply's app data folder and the
   * other is the folder the user picked. only this tells them apart.
   */
  wordingCode?: string
  // trimmed downloads report one sweep at the end, so there is no meaningful
  // percentage to show while ffmpeg works
  indeterminate?: boolean
  // a failure that carries its own advice, rather than the generic retry
  // prompt: a playlist run refuses to start when Cliply cannot write its own
  // record of the download, which no amount of retrying fixes
  suggestion?: string

  /**
   * the second level, sent only by a playlist download.
   *
   * `progress` above is still the single 0-100 bar for the whole run, so a
   * consumer that only reads that keeps working. these say where inside it we
   * are: `item_index` is the video's place in this run's queue and
   * `playlist_index` its true position in the playlist, which differ for any
   * selection with a gap in it. there is no title here - main never sees one -
   * so the row is matched by index or by `video_id` against the listing.
   */
  item_progress?: number
  item_index?: number
  items_completed?: number
  items_total?: number
  playlist_index?: number | null
  video_id?: string | null

  /**
   * what a finished playlist run actually did, on its terminal event.
   *
   * a partial playlist is `completed`, not a fourth status: "some items were
   * skipped" is a property of a finished job. `items_reused` is the archive's
   * doing - videos this destination already has, which read as "already
   * downloaded" and are **never** a save this run made.
   */
  files?: string[]
  items_saved?: number
  items_reused?: number
  items_skipped?: number

  /**
   * which positions the archive accounted for.
   *
   * yt-dlp never announces an archive-skipped item: no stream marker, no
   * progress line, no file. so these rows are indistinguishable from rows the
   * run never reached unless the run says which they were, and the engine
   * knows because it works reuse out from the archive before spawning.
   */
  reused_indices?: number[]
}

export interface DownloadStatus {
  downloadId: string
  status: "downloading" | "completed" | "failed" | "cancelled"
  progress: number
  filename?: string
  error?: string
  startTime?: number
  endTime?: number
  // a playlist is one row covering n videos, downloaded one after another; a
  // single video is one row and nothing else. `type` says what is being
  // fetched, which is the same answer for both, so this is what tells a
  // downloads list which of the two shapes to draw
  playlist?: boolean
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

/**
 * what the cookie jar on disk holds
 *
 * `signedIn` is yt-dlp's own authentication test - LOGIN_INFO alongside a
 * SAPISID cookie - not "there are youtube cookies in the file". The two differ
 * for a jar exported without signing in, and for one youtube has since rotated
 * out, which is why both fields are here rather than one.
 */
export interface CookieFileInfo {
  exists: boolean
  size: number
  modified: string | null
  cookieCount: number
  youtubeCookieCount?: number
  expiredCookieCount?: number
  /** a SAPISID cookie is present - signed in, or signed out and not yet re-exported */
  hasSid: boolean
  signedIn: boolean
  /** set when yt-dlp would refuse the whole file, which reads as an empty jar otherwise */
  loadError?: string | null
  valid: boolean
}

export interface CookieStatus {
  fileInfo: CookieFileInfo
  hasValidCookies: boolean
  /** why the jar is unusable, written by main. null when it works */
  problem: string | null
  /** the same verdict as a stable `JAR_*` code, so it can be said in russian */
  problemCode?: string | null
  status: { lastImport?: string | null; lastTest?: string | null }
}

export interface CookieImportResult {
  /**
   * whether what landed is a jar yt-dlp would authenticate with, which is the
   * only thing the dialog asks. `imported` and `signedIn` used to sit here too:
   * the first was never false, since a refusal throws, and the second said the
   * same thing as this one
   */
  hasValidCookies: boolean
}

/**
 * deliberately two facts rather than a verdict: extracting a public video with
 * the jar attached proves extraction worked, not that youtube honoured the
 * cookies - the same probe passes with none at all.
 */
export interface CookieTestResult {
  cookiesLoaded: boolean
  extractionCheck: string
  /** youtube turned the cookies down while they were being sent - the one strong negative */
  rejected?: boolean
  note: string
  /** the note as a stable `JAR_*` or `PROBE_*` code, for the same reason */
  noteCode?: string | null
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

/**
 * one row of a playlist listing
 *
 * `index` is the video's 1-based position in the playlist and is what a
 * download selection sends back. `duration` is null for a row that has none -
 * a live stream, or a video that is gone - rather than a zero that would read
 * as a video of no length.
 *
 * `unavailable` marks a deleted or private video. it cannot be downloaded, and
 * each attempt spends one of yt-dlp's five allowed failures before it gives up
 * on the rest of the playlist, so these rows must not be selectable.
 */
export interface PlaylistEntry {
  index: number
  id: string | null
  title: string
  duration: number | null
  duration_string: string | null
  thumbnail: string | null
  unavailable: boolean
}

/**
 * what a playlist link holds
 *
 * `count` is the playlist's true size and is null when the platform does not
 * report one (a channel feed paginates lazily and never says). `listed` is how
 * many rows came back, capped at 100, and `truncated` is the only honest way
 * to say "there is more of this than we are showing you".
 *
 * there are no quality tiers and no file sizes here, and there cannot be: the
 * listing is flat, so it carries no formats. that is why a playlist's quality
 * menu is a fixed ceiling rather than one derived from the video.
 */
export interface PlaylistInfoResponse {
  playlist_id: string | null
  title: string
  uploader: string
  count: number | null
  listed: number
  truncated: boolean
  entries: PlaylistEntry[]
}

/**
 * a playlist download request
 *
 * `entries` are the ticked rows, sent as the {index, id} pairs the listing
 * gave: main derives yt-dlp's selection from the indices and decides what the
 * resume archive already holds from the ids. `height` is a ceiling ("best
 * available up to this"), never a filter, so nothing is skipped for lacking it.
 *
 * `ignore_archive` is the "download everything again" affordance for a user
 * who deleted the files: it drops the archive for one run, and only a literal
 * true does it.
 */
export interface PlaylistDownloadRequest {
  url: string
  playlist_id: string
  entries: { index: number; id: string }[]
  type?: "video" | "audio"
  height?: number
  audio_mode?: AudioMode
  ignore_archive?: boolean
  // see AudioDownloadRequest.download_id - one id covers the whole playlist
  download_id?: string
  title?: string
}

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
  /** main's own code for the failure, "GENERAL_ERROR" when it has none */
  code?: string
  /** see `DownloadProgress.wordingCode`: a refusal that named itself */
  wordingCode?: string
}

/**
 * a failure carrying what main knew about it
 *
 * `details` is the technical text issue reports quote, and `category` is main's
 * own taxonomy answer - the field to read, because `code` beside it in the same
 * payload is either the engine's code or the "GENERAL_ERROR" placeholder, which
 * is not a taxonomy value.
 *
 * named for downloads because that is where it started; the info requests throw
 * it too, since a failure that arrives as a bare Error has thrown both fields
 * away before any caller can see them.
 */
export class DownloadError extends Error {
  details?: string
  category?: string
  /** see `DownloadProgress.wordingCode`: a refusal that named itself */
  wordingCode?: string

  constructor(message: string, error?: ApiError) {
    super(message)
    this.name = "DownloadError"
    this.details = error?.details
    this.category = error?.category
    this.wordingCode = error?.wordingCode
  }
}

/**
 * an import main refused, carrying the code it refused it under
 *
 * a bare Error threw the code away, and the dialog would have had to match
 * main's english sentence to know which refusal it was holding.
 */
export class CookieError extends Error {
  code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = "CookieError"
    this.code = code
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
      playlist: {
        getInfo: (
          options: { url: string; platform?: string } | string
        ) => Promise<IPCResponse<PlaylistInfoResponse>>
        download: (
          options: PlaylistDownloadRequest & { platform?: string }
        ) => Promise<
          IPCResponse<{
            download_id: string
            status: string
            type: string
            items_total: number
          }>
        >
      }
      pinterest: {
        getInfo: (
          url: string
        ) => Promise<IPCResponse<PinterestVideoInfoResponse>>
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
      // optional: an older preload has no support bridge, and the dialog has
      // to be able to mount against one
      support?: {
        onMilestone: (callback: (data: { count: number }) => void) => () => void
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
        setDownloadPath: (
          path: string
        ) => Promise<IPCResponse<DownloadPathInfo>>
      }
      cookies: {
        importFile: () => Promise<IPCResponse<CookieImportResult>>
        test: () => Promise<IPCResponse<CookieTestResult>>
        getStatus: () => Promise<IPCResponse<CookieStatus>>
        clear: () => Promise<IPCResponse<{ cleared: boolean }>>
      }
      // telemetry. optional because the browser dev server has no preload at
      // all, and because lib/analytics.ts must survive an older one
      analytics?: {
        track: (
          event: string,
          properties: Record<string, string | number | boolean>
        ) => Promise<{ success: boolean }>
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

export const extractVideoId = (url: string): string | null => {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([^"&?/\s]{11})/
  )
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

// the reason is a translation key rather than a sentence: whoever renders it
// calls `t()` there, the same way the zod schemas carry their messages
export const validateTimeRange = (
  start: number,
  end: number,
  duration: number
): { isValid: boolean; error?: Key } => {
  if (start < 0) {
    return { isValid: false, error: "time.startNegative" }
  }

  if (end > duration) {
    return { isValid: false, error: "time.endExceeds" }
  }

  if (start >= end) {
    return { isValid: false, error: "time.endBeforeStart" }
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
