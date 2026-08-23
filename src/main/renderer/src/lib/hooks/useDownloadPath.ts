import { useCallback } from "react"
import { settingsApi, systemApi } from "@/lib/api"
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
      toast.error("failed to update download folder")
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