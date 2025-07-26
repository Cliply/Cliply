import { updaterApi, type UpdateInfo, type UpdateProgress } from "@/lib/api"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import React, { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "./button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "./card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "./dialog"
import { Progress } from "./progress"

interface UpdateNotificationProps {
  onUpdateAvailable?: (info: UpdateInfo) => void
  onUpdateDownloaded?: (info: UpdateInfo) => void
  showInlineCard?: boolean
}

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({
  onUpdateAvailable,
  onUpdateDownloaded,
  showInlineCard = false
}) => {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloadProgress, setDownloadProgress] =
    useState<UpdateProgress | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDownloaded, setIsDownloaded] = useState(false)
  const [showUpdateDialog, setShowUpdateDialog] = useState(false)
  const [showInstallDialog, setShowInstallDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSecurityUpdate, setIsSecurityUpdate] = useState(false)
  const [autoInstallCountdown, setAutoInstallCountdown] = useState<number | null>(null)

  useEffect(() => {
    // Set up update event listeners
    const cleanupFunctions: (() => void)[] = []

    // Update available
    const unsubscribeAvailable = updaterApi.events.onUpdateAvailable((info) => {
      console.log("🔔 Update available:", info.version)
      setUpdateInfo(info)
      setShowUpdateDialog(true)

      toast.dismiss("update-check") // Dismiss the checking toast
      toast.success("Update Available", {
        description: `Version ${info.version} is ready to download`,
        action: {
          label: "Download",
          onClick: () => handleDownloadUpdate()
        },
        duration: 10000
      })

      onUpdateAvailable?.(info)
    })
    cleanupFunctions.push(unsubscribeAvailable)

    // Update not available
    const unsubscribeNotAvailable = updaterApi.events.onUpdateNotAvailable(
      () => {
        console.log("App is up to date")
        toast.dismiss("update-check") // Dismiss the checking toast
        toast.success("App is up to date", {
          description: "You're running the latest version",
          duration: 3000
        })
      }
    )
    cleanupFunctions.push(unsubscribeNotAvailable)

    // Download progress
    const unsubscribeProgress = updaterApi.events.onDownloadProgress(
      (progress) => {
        console.log(`Update download progress: ${progress.percent}%`)
        setDownloadProgress(progress)
        setIsDownloading(true)
        
        // Show progress toast every 10% or if it's the first progress update
        if (progress.percent % 10 === 0 || progress.percent < 5) {
          toast.loading(`Downloading Update: ${Math.round(progress.percent)}%`, {
            id: "update-progress",
            description: progress.bytesPerSecond 
              ? `${Math.round(progress.bytesPerSecond / 1024)} KB/s`
              : "Downloading in background..."
          })
        }
      }
    )
    cleanupFunctions.push(unsubscribeProgress)

    // Update downloaded
    const unsubscribeDownloaded = updaterApi.events.onUpdateDownloaded(
      (info: any) => {
        console.log("Update downloaded:", info.version)
        setIsDownloading(false)
        setIsDownloaded(true)
        setDownloadProgress(null)

        // Dismiss the progress toast
        toast.dismiss("update-progress")

        if (info.isSecurity && info.autoInstallIn) {
          // Security update with auto-install countdown
          const countdownSeconds = Math.ceil(info.autoInstallIn / 1000)
          setAutoInstallCountdown(countdownSeconds)
          setShowInstallDialog(true)

          toast.success("Update Installing Automatically", {
            description: `Version ${info.version} will install in ${countdownSeconds} seconds`,
            duration: info.autoInstallIn
          })

          // Start countdown timer
          const countdownInterval = setInterval(() => {
            setAutoInstallCountdown((prev) => {
              if (prev && prev > 1) {
                return prev - 1
              } else {
                clearInterval(countdownInterval)
                return null
              }
            })
          }, 1000)

        } else {
          // Normal update
          setShowInstallDialog(true)
          
          toast.success("Update Ready to Install!", {
            description: `Version ${info.version} has been downloaded successfully. Click to install and restart.`,
            action: {
              label: "Install & Restart",
              onClick: () => handleInstallUpdate()
            },
            duration: 0 // Keep open until dismissed
          })
        }

        onUpdateDownloaded?.(info)
      }
    )
    cleanupFunctions.push(unsubscribeDownloaded)

    // Update checking
    const unsubscribeChecking = updaterApi.events.onUpdateChecking(() => {
      console.log("Checking for updates...")
      toast.loading("Checking for updates...", {
        id: "update-check"
      })
    })
    cleanupFunctions.push(unsubscribeChecking)

    // Update error
    const unsubscribeError = updaterApi.events.onUpdateError((error) => {
      console.error("Update error:", error.message)
      setError(error.message)
      setIsDownloading(false)

      toast.dismiss("update-check")
      toast.error("Update Error", {
        description: error.message,
        duration: 5000
      })
    })
    cleanupFunctions.push(unsubscribeError)

    // Security update available
    const unsubscribeSecurityUpdate = updaterApi.events.onSecurityUpdate((info) => {
      console.log("Important update available:", info.version)
      setUpdateInfo(info)
      setIsSecurityUpdate(true)
      setShowUpdateDialog(true)

      toast.dismiss("update-check")
      toast.success("Update Available", {
        description: `Version ${info.version} is downloading automatically`,
        action: {
          label: "Downloading...",
          onClick: () => {} // Auto-downloading, no action needed
        },
        duration: 5000 // Normal duration
      })

      onUpdateAvailable?.(info)
    })
    cleanupFunctions.push(unsubscribeSecurityUpdate)

    return () => {
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [onUpdateAvailable, onUpdateDownloaded])

  const handleDownloadUpdate = async () => {
    try {
      setShowUpdateDialog(false)
      setError(null)

      toast.loading("Preparing download...", {
        id: "update-download",
        description: "Initializing update download"
      })

      await updaterApi.downloadUpdate()

      toast.dismiss("update-download")
      toast.success("Download Started", {
        description: "Update is downloading in the background. You can continue using the app.",
        duration: 4000
      })
    } catch (error) {
      console.error("Failed to download update:", error)
      setError(
        error instanceof Error ? error.message : "Failed to download update"
      )

      toast.dismiss("update-download")
      toast.error("Download Failed", {
        description:
          error instanceof Error ? error.message : "Please try again or check your internet connection"
      })
    }
  }

  const handleInstallUpdate = async () => {
    try {
      setShowInstallDialog(false)

      toast.loading("Installing Update", {
        description: "The app will close and reopen with the new version",
        duration: 0
      })

      await updaterApi.installUpdate()
    } catch (error) {
      console.error("Failed to install update:", error)
      toast.error("Installation Failed", {
        description:
          error instanceof Error ? error.message : "Please try downloading the update again",
        duration: 6000
      })
    }
  }

  const handleCheckForUpdates = async () => {
    try {
      await updaterApi.checkForUpdates()
    } catch (error) {
      console.error("Failed to check for updates:", error)
      toast.error("Check Failed", {
        description:
          error instanceof Error ? error.message : "Failed to check for updates"
      })
    }
  }

  const handleForceSecurityCheck = async () => {
    try {
      toast.loading("Checking for updates...", {
        id: "update-check"
      })
      
      await updaterApi.forceSecurityCheck()
      
      setTimeout(() => {
        toast.dismiss("update-check")
      }, 3000)
    } catch (error) {
      console.error("Failed to check for updates:", error)
      toast.dismiss("update-check")
      toast.error("Check Failed", {
        description:
          error instanceof Error ? error.message : "Failed to check for updates"
      })
    }
  }

  // Inline card component for displaying update status
  const UpdateCard = () => {
    if (!showInlineCard) return null

    if (isDownloading && downloadProgress) {
      return (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-4"
        >
          <Card
            className={cn(
              "border-2 transition-all duration-200",
              "bg-white/80 dark:bg-slate-800/60 border-slate-300/50 dark:border-slate-700/50",
              "backdrop-blur-sm shadow-lg font-space-grotesk"
            )}
          >
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-100 dark:bg-cyan-900/50">
                  <span className="text-cyan-600 dark:text-cyan-400 font-bold text-lg">*</span>
                </div>
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">
                    Downloading Update
                  </div>
                  <CardDescription className="text-xs text-slate-600 dark:text-slate-400">
                    Version {updateInfo?.version} • {downloadProgress.percent}%
                    complete
                  </CardDescription>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Progress value={downloadProgress.percent} className="h-2" />
              {downloadProgress.bytesPerSecond && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {Math.round(downloadProgress.bytesPerSecond / 1024)} KB/s
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )
    }

    if (isDownloaded) {
      return (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-4"
        >
          <Card
            className={cn(
              "border-2 transition-all duration-200",
              "bg-white/80 dark:bg-slate-800/60 border-slate-300/50 dark:border-slate-700/50",
              "backdrop-blur-sm shadow-lg font-space-grotesk"
            )}
          >
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-100 dark:bg-cyan-900/50">
                  <span className="text-cyan-600 dark:text-cyan-400 font-bold text-lg">*</span>
                </div>
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">
                    Update Ready
                  </div>
                  <CardDescription className="text-xs text-slate-600 dark:text-slate-400">
                    Version {updateInfo?.version} is ready to install
                  </CardDescription>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleInstallUpdate}
                size="sm"
                className="w-full bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700 transition-all duration-200"
              >
                Install & Restart
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      )
    }

    if (error) {
      return (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-4"
        >
          <Card
            className={cn(
              "border-2 transition-all duration-200",
              "bg-white/80 dark:bg-slate-800/60 border-slate-300/50 dark:border-slate-700/50",
              "backdrop-blur-sm shadow-lg font-space-grotesk"
            )}
          >
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/50">
                  <span className="text-red-600 dark:text-red-400 font-bold text-lg">!</span>
                </div>
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">
                    Update Error
                  </div>
                  <CardDescription className="text-xs text-slate-600 dark:text-slate-400">
                    {error}
                  </CardDescription>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                onClick={handleCheckForUpdates}
                size="sm"
                variant="outline"
                className="w-full"
              >
                Try Again
              </Button>
              <Button
                onClick={handleForceSecurityCheck}
                size="sm"
                variant="outline"
                className="w-full"
              >
                Check for Important Updates
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      )
    }

    return null
  }

  return (
    <>
      <UpdateCard />

      {/* Update Available Dialog */}
      <Dialog open={showUpdateDialog} onOpenChange={setShowUpdateDialog}>
        <DialogContent
          className={cn(
            "w-full max-w-md border rounded-xl",
            "bg-white dark:bg-slate-800 border-slate-300/50 dark:border-slate-700/50",
            "shadow-xl font-space-grotesk min-h-[280px] flex flex-col justify-between"
          )}
        >
          <div className="flex-1">
            <DialogHeader className="space-y-4 pb-6">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-cyan-100 dark:bg-cyan-900/50">
                  <span className="text-cyan-600 dark:text-cyan-400 font-bold text-2xl">*</span>
                </div>
                <div>
                  <DialogTitle className="text-left">
                    Update Available
                  </DialogTitle>
                  <DialogDescription className="text-left">
                    {isSecurityUpdate 
                      ? "An important update is being downloaded automatically." 
                      : "A new version of Cliply is available."
                    }
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {updateInfo && (
              <div className="text-center py-6">
                <div className="rounded-lg bg-slate-100/80 dark:bg-slate-700/50 p-4">
                  <h4 className="font-medium text-slate-900 dark:text-white">
                    Version {updateInfo.version}
                  </h4>
                  {updateInfo.releaseDate && (
                    <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                      Released {new Date(updateInfo.releaseDate).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-3 pt-4">
            {isSecurityUpdate ? (
              <div className="w-full text-center">
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
                  Update is downloading automatically in the background
                </p>
                <Button
                  variant="outline"
                  onClick={() => setShowUpdateDialog(false)}
                  className="w-full sm:w-auto"
                >
                  OK
                </Button>
              </div>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowUpdateDialog(false)}
                  className="w-full sm:w-auto"
                >
                  Later
                </Button>
                <Button
                  onClick={handleDownloadUpdate}
                  className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700 transition-all duration-200"
                >
                  Download Update
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Install Update Dialog */}
      <Dialog open={showInstallDialog} onOpenChange={setShowInstallDialog}>
        <DialogContent
          className={cn(
            "w-full max-w-md border rounded-xl",
            "bg-white dark:bg-slate-800 border-slate-300/50 dark:border-slate-700/50",
            "shadow-xl font-space-grotesk min-h-[280px] flex flex-col justify-between"
          )}
        >
          <div className="flex-1">
            <DialogHeader className="space-y-4 pb-6">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-cyan-100 dark:bg-cyan-900/50">
                  <span className="text-cyan-600 dark:text-cyan-400 font-bold text-2xl">*</span>
                </div>
                <div>
                  <DialogTitle className="text-left">
                    {autoInstallCountdown ? "Installing Automatically" : "Update Ready to Install"}
                  </DialogTitle>
                  <DialogDescription className="text-left">
                    {autoInstallCountdown 
                      ? `Update will install automatically in ${autoInstallCountdown} seconds. The app will restart.`
                      : "The update has been downloaded and is ready to install. The app will restart automatically."
                    }
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {updateInfo && (
              <div className="text-center py-6">
                <div className="rounded-lg bg-slate-100/80 dark:bg-slate-700/50 p-4">
                  <h4 className="font-medium text-slate-900 dark:text-white">
                    Version {updateInfo.version}
                  </h4>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    {autoInstallCountdown 
                      ? "Ready to install automatically" 
                      : "Ready to install when you're ready"
                    }
                  </p>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-3 pt-4">
            {autoInstallCountdown ? (
              <div className="w-full text-center">
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
                  Installing automatically in {autoInstallCountdown} seconds...
                </p>
                <Button
                  onClick={handleInstallUpdate}
                  className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700 transition-all duration-200"
                >
                  Install Now
                </Button>
              </div>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowInstallDialog(false)}
                  className="w-full sm:w-auto"
                >
                  Later
                </Button>
                <Button
                  onClick={handleInstallUpdate}
                  className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700 transition-all duration-200"
                >
                  Install & Restart
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default UpdateNotification
