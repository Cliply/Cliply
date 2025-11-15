import { useEffect, useState } from "react"
import { systemApi } from "@/lib/api"

export type ServerStatus = "unknown" | "starting" | "ready" | "error"

export const useServerStatus = () => {
  const [status, setStatus] = useState<ServerStatus>("unknown")

  useEffect(() => {
    if (!window.electronAPI?.server) {
      return
    }

    // check current server status on mount (fixes reload issue)
    const checkCurrentStatus = async () => {
      try {
        await systemApi.getHealth()
        setStatus("ready")
      } catch {
        setStatus("starting")
      }
    }

    // check immediately
    checkCurrentStatus()

    // listen for server events
    const unsubscribeStarting = window.electronAPI.server.onStarting(() => {
      setStatus("starting")
    })

    const unsubscribeReady = window.electronAPI.server.onReady(() => {
      setStatus("ready")
    })

    const unsubscribeError = window.electronAPI.server.onError(
      (error: { message: string }) => {
        console.error("server error:", error)
        setStatus("error")
      }
    )

    return () => {
      unsubscribeStarting()
      unsubscribeReady()
      unsubscribeError()
    }
  }, [])

  return {
    status,
    isStarting: status === "starting",
    isReady: status === "ready",
    hasError: status === "error",
    isUnknown: status === "unknown"
  }
}
