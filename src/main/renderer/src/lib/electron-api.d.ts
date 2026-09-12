// the preload bridge as the renderer sees it

import type { ReportEnvironment } from "@/lib/report"

import type {
  ActiveSnapshot,
  ApiError,
  AudioDownloadRequest,
  CookieImportResult,
  CookieStatus,
  CookieTestResult,
  DownloadPathInfo,
  DownloadProgress,
  DownloadStatus,
  HistorySnapshot,
  PinterestDownloadRequest,
  PinterestVideoInfoResponse,
  PlaylistDownloadRequest,
  PlaylistInfoResponse,
  SimpleDownloadResponse,
  SystemHealth,
  TikTokDownloadRequest,
  TikTokVideoInfoResponse,
  UpdateInfo,
  UpdateProgress,
  VideoDownloadRequest,
  VideoInfoResponse
} from "./api-types"

// IPC Response wrapper
export interface IPCResponse<T> {
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
        ) => Promise<IPCResponse<SimpleDownloadResponse>>
      }
      tiktok: {
        getInfo: (url: string) => Promise<IPCResponse<TikTokVideoInfoResponse>>
        download: (
          options: TikTokDownloadRequest
        ) => Promise<IPCResponse<SimpleDownloadResponse>>
      }
      download: {
        cancel: (
          downloadId: string
        ) => Promise<IPCResponse<{ cancelled: boolean }>>
        getStatus: (downloadId: string) => Promise<IPCResponse<DownloadStatus>>
        getAll: () => Promise<IPCResponse<ActiveSnapshot>>
        /**
         * the rows this install remembers, read once at startup.
         *
         * all three answer with the history as it stands afterwards, so the
         * panel never has to guess which of its rows survived a clear.
         */
        getHistory: () => Promise<IPCResponse<HistorySnapshot>>
        clearHistory: () => Promise<IPCResponse<HistorySnapshot>>
        removeHistory: (
          downloadId: string
        ) => Promise<IPCResponse<HistorySnapshot>>
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
        /**
         * reveal one downloaded file in its folder.
         *
         * main refuses a path outside the download folder, so this can fail
         * for a file that has been moved: the caller falls back to
         * `openDownloadFolder`. optional, because an older preload has no such
         * bridge and the panel still has to open a folder there.
         */
        showInFolder?: (
          path: string
        ) => Promise<IPCResponse<{ shown: boolean; path: string }>>
        selectDownloadFolder: () => Promise<IPCResponse<{ folderPath: string }>>
        getDiagnostics: () => Promise<IPCResponse<ReportEnvironment>>
      }
      settings: {
        getDownloadPath: () => Promise<IPCResponse<DownloadPathInfo>>
        /**
         * how many downloads this install has finished, ever. optional for the
         * same reason as `showInFolder`: an older preload does not have it, and
         * a panel with no number is better than a panel that throws.
         */
        getDownloadCount?: () => Promise<IPCResponse<{ count: number }>>
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
