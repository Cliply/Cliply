import { useCallback } from "react"
import { settingsApi, systemApi } from "@/lib/api"
import { useAppStore } from "@/lib/store"
import { showFolderSelectedToast } from "@/lib/toast-utils"
import { useServerStatus } from "./useServerStatus"
import { toast } from "sonner"

export function useDownloadPath() {
  const {
    downloadPath,
    setDownloadPath,
    setIsLoadingDownloadPath,
    isLoadingDownloadPath
  } = useAppStore()
  const { isReady: serverReady } = useServerStatus()

  // folder selection logic
  const selectFolder = useCallback(async () => {
    if (!serverReady) {
      toast.error("download engine starting, please wait...")
      return
    }

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
  }, [serverReady, setDownloadPath, setIsLoadingDownloadPath])

  return {
    downloadPath,
    isLoading: isLoadingDownloadPath,
    selectFolder,
    serverReady
  }
}