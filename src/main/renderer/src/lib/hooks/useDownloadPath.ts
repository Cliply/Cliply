import { useEffect } from "react"
import { settingsApi } from "@/lib/api"
import { useAppStore } from "@/lib/store"

export function useDownloadPath() {
  const {
    downloadPath,
    setDownloadPath,
    setIsLoadingDownloadPath
  } = useAppStore()

  useEffect(() => {
    const loadDownloadPath = async () => {
      // skip if we already have the path
      if (downloadPath) return

      try {
        setIsLoadingDownloadPath(true)
        const pathInfo = await settingsApi.getDownloadPath()
        setDownloadPath(pathInfo)
      } catch (error) {
        console.error("Failed to load download path:", error)
        // just log errors on initial load, don't spam user with toasts
      } finally {
        setIsLoadingDownloadPath(false)
      }
    }

    // give server time to start up
    const timer = setTimeout(loadDownloadPath, 2000)
    return () => clearTimeout(timer)
  }, [downloadPath, setDownloadPath, setIsLoadingDownloadPath])

  return {
    downloadPath,
    isLoading: useAppStore(state => state.isLoadingDownloadPath)
  }
}