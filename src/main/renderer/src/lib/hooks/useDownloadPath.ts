import { useCallback, useEffect } from "react"
import { settingsApi, systemApi } from "@/lib/api"
import { t } from "@/lib/i18n"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { showFolderSelectedToast } from "@/lib/toast-utils"
import { toast } from "sonner"

export function useDownloadPath() {
  const {
    downloadPath,
    setDownloadPath,
    setIsLoadingDownloadPath,
    isLoadingDownloadPath
  } = useYouTubeStore()

  /**
   * where files land right now, read once
   *
   * the store only ever learned this from `selectFolder`, so it was null for
   * everybody who had not changed the folder in this session - which is why
   * the screens that name the folder used to print `~/Downloads/Cliply` as a
   * literal and were wrong for anyone who had.
   *
   * a failure is swallowed rather than toasted: nothing was asked for, and a
   * screen with no path to show says nothing instead of guessing at one.
   */
  useEffect(() => {
    if (downloadPath) return

    let cancelled = false

    settingsApi
      .getDownloadPath()
      .then((info) => {
        if (!cancelled) setDownloadPath(info)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [downloadPath, setDownloadPath])

  // folder selection logic
  // no engine gate: the download folder is stored by the main process, so
  // picking one never depended on the download engine being ready
  const selectFolder = useCallback(async () => {
    try {
      const selectedPath = await systemApi.selectDownloadFolder()
      if (selectedPath) {
        setIsLoadingDownloadPath(true)
        const updatedPathInfo = await settingsApi.setDownloadPath(selectedPath)
        setDownloadPath(updatedPathInfo)
        showFolderSelectedToast()
      }
    } catch (error) {
      console.error("failed to update download folder:", error)
      toast.error(t("folder.updateFailed"))
    } finally {
      setIsLoadingDownloadPath(false)
    }
  }, [setDownloadPath, setIsLoadingDownloadPath])

  return {
    downloadPath,
    isLoading: isLoadingDownloadPath,
    selectFolder
  }
}