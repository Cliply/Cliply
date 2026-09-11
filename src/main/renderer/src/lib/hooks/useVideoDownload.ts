import { useMediaDownload, type MediaDownloadState } from "./useMediaDownload"

export type VideoDownloadState = MediaDownloadState

export const useVideoDownload = () => useMediaDownload("video")
