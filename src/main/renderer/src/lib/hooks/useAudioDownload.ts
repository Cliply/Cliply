import { useMediaDownload, type MediaDownloadState } from "./useMediaDownload"

export type AudioDownloadState = MediaDownloadState

export const useAudioDownload = () => useMediaDownload("audio")
