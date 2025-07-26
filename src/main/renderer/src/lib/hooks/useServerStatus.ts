import { useEffect, useState } from "react"

export type ServerStatus = "unknown" | "starting" | "ready" | "error"

export const useServerStatus = () => {
  const [status, setStatus] = useState<ServerStatus>("unknown")

  useEffect(() => {
    if (!window.electronAPI?.server) {
      return
    }

    // Listen for server events
    const unsubscribeStarting = window.electronAPI.server.onStarting(() => {
      setStatus("starting")
    })

    const unsubscribeReady = window.electronAPI.server.onReady(() => {
      setStatus("ready")
    })

    const unsubscribeError = window.electronAPI.server.onError(
      (error: { message: string }) => {
        console.error("Server error:", error)
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
