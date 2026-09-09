import { updaterApi, type UpdateInfo, type UpdateProgress } from "@/lib/api"
import { useT } from "@/lib/i18n"
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
  const t = useT()
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloadProgress, setDownloadProgress] =
    useState<UpdateProgress | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDownloaded, setIsDownloaded] = useState(false)
  const [showUpdateDialog, setShowUpdateDialog] = useState(false)
  const [showInstallDialog, setShowInstallDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Set up update event listeners
    const cleanupFunctions: (() => void)[] = []

    // Update available
    const unsubscribeAvailable = updaterApi.events.onUpdateAvailable((info) => {
      console.log("🔔 Update available:", info.version)
      setUpdateInfo(info)

      toast.dismiss("update-check") // Dismiss the checking toast

      if (info.requiresManualDownload) {
        // macOS: Show manual download dialog
        setShowUpdateDialog(true)
        toast.success(t("update.available"), {
          description: t("update.macManual", { version: info.version }),
          action: {
            label: t("update.download"),
            onClick: () =>
              window.open(
                `https://github.com/Cliply/Cliply/releases/latest`,
                "_blank"
              )
          },
          duration: 10000
        })
      } else if (info.autoDownloading) {
        // Auto-downloading - only show toast, no dialog
        toast.success(t("update.downloadingTitle"), {
          description: t("update.autoDownloading", { version: info.version }),
          duration: 5000
        })
      } else {
        // Manual download - show dialog and toast
        setShowUpdateDialog(true)
        toast.success(t("update.available"), {
          description: t("update.readyToDownload", { version: info.version }),
          action: {
            label: t("update.download"),
            onClick: () => handleDownloadUpdate()
          },
          duration: 10000
        })
      }

      onUpdateAvailable?.(info)
    })
    cleanupFunctions.push(unsubscribeAvailable)

    // Update not available
    const unsubscribeNotAvailable = updaterApi.events.onUpdateNotAvailable(
      () => {
        console.log("App is up to date")
        toast.dismiss("update-check") // Dismiss the checking toast
        toast.success(t("update.upToDate"), {
          description: t("update.upToDateDesc"),
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
          toast.loading(
            t("update.progress", { percent: Math.round(progress.percent) }),
            {
              id: "update-progress",
              description: progress.bytesPerSecond
                ? `${Math.round(progress.bytesPerSecond / 1024)} KB/s`
                : t("update.inBackground")
            }
          )
        }
      }
    )
    cleanupFunctions.push(unsubscribeProgress)

    // Update downloaded
    const unsubscribeDownloaded = updaterApi.events.onUpdateDownloaded(
      (info: UpdateInfo) => {
        console.log("Update downloaded:", info.version)
        setIsDownloading(false)
        setIsDownloaded(true)
        setDownloadProgress(null)

        // Dismiss the progress toast
        toast.dismiss("update-progress")

        // All updates now use simple auto-install on quit
        setShowInstallDialog(true)

        toast.success(t("update.readyToInstallToast"), {
          description: t("update.downloadedDesc", { version: info.version }),
          action: {
            label: t("update.installNow"),
            onClick: () => handleInstallUpdate()
          },
          duration: 0 // Keep open until dismissed
        })

        onUpdateDownloaded?.(info)
      }
    )
    cleanupFunctions.push(unsubscribeDownloaded)

    // Update checking
    const unsubscribeChecking = updaterApi.events.onUpdateChecking(() => {
      console.log("Checking for updates...")
      toast.loading(t("update.checking"), {
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
      toast.error(t("update.error"), {
        description: error.message,
        duration: 5000
      })
    })
    cleanupFunctions.push(unsubscribeError)

    return () => {
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [onUpdateAvailable, onUpdateDownloaded])

  const handleDownloadUpdate = async () => {
    try {
      setShowUpdateDialog(false)
      setError(null)

      toast.loading(t("update.preparing"), {
        id: "update-download",
        description: t("update.preparingDesc")
      })

      await updaterApi.downloadUpdate()

      toast.dismiss("update-download")
      toast.success(t("update.started"), {
        description: t("update.startedDesc"),
        duration: 4000
      })
    } catch (error) {
      console.error("Failed to download update:", error)
      setError(
        error instanceof Error ? error.message : t("update.downloadFailedDesc")
      )

      toast.dismiss("update-download")
      toast.error(t("update.downloadFailed"), {
        description:
          error instanceof Error ? error.message : t("update.checkConnection")
      })
    }
  }

  const handleInstallUpdate = async () => {
    try {
      setShowInstallDialog(false)

      toast.loading(t("update.installing"), {
        description: t("update.installingDesc"),
        duration: 0
      })

      await updaterApi.installUpdate()
    } catch (error) {
      console.error("Failed to install update:", error)
      toast.error(t("update.installFailed"), {
        description:
          error instanceof Error
            ? error.message
            : t("update.installFailedDesc"),
        duration: 6000
      })
    }
  }

  const handleCheckForUpdates = async () => {
    try {
      await updaterApi.checkForUpdates()
    } catch (error) {
      console.error("Failed to check for updates:", error)
      // the same failure the hero's own check reports, in the same words
      toast.error(t("hero.updateCheckFailed"), {
        description:
          error instanceof Error
            ? error.message
            : t("hero.updateCheckFailedBody")
      })
    }
  }

  const handleForceSecurityCheck = async () => {
    try {
      toast.loading(t("update.checking"), {
        id: "update-check"
      })

      await updaterApi.forceSecurityCheck()

      setTimeout(() => {
        toast.dismiss("update-check")
      }, 3000)
    } catch (error) {
      console.error("Failed to check for updates:", error)
      toast.dismiss("update-check")
      toast.error(t("hero.updateCheckFailed"), {
        description:
          error instanceof Error
            ? error.message
            : t("hero.updateCheckFailedBody")
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
                  <span className="text-cyan-600 dark:text-cyan-400 font-bold text-lg">
                    *
                  </span>
                </div>
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">
                    {t("update.cardDownloading")}
                  </div>
                  <CardDescription className="text-xs text-slate-600 dark:text-slate-400">
                    {t("update.cardProgress", {
                      version: updateInfo?.version ?? "",
                      percent: downloadProgress.percent
                    })}
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
                  <span className="text-cyan-600 dark:text-cyan-400 font-bold text-lg">
                    *
                  </span>
                </div>
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">
                    {t("update.cardReady")}
                  </div>
                  <CardDescription className="text-xs text-slate-600 dark:text-slate-400">
                    {t("update.cardReadyDesc", {
                      version: updateInfo?.version ?? ""
                    })}
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
                {t("update.installRestart")}
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
                  <span className="text-red-600 dark:text-red-400 font-bold text-lg">
                    !
                  </span>
                </div>
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">
                    {t("update.error")}
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
                {t("update.tryAgain")}
              </Button>
              <Button
                onClick={handleForceSecurityCheck}
                size="sm"
                variant="outline"
                className="w-full"
              >
                {t("update.importantUpdates")}
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
                  <span className="text-cyan-600 dark:text-cyan-400 font-bold text-2xl">
                    *
                  </span>
                </div>
                <div>
                  <DialogTitle className="text-left">
                    {t("update.available")}
                  </DialogTitle>
                  <DialogDescription className="text-left">
                    {updateInfo?.requiresManualDownload
                      ? t("update.macDesc")
                      : t("update.newVersion")}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {updateInfo && (
              <div className="text-center py-6">
                <div className="rounded-lg bg-slate-100/80 dark:bg-slate-700/50 p-4">
                  <h4 className="font-medium text-slate-900 dark:text-white">
                    {t("update.version", { version: updateInfo.version })}
                  </h4>
                  {updateInfo.releaseDate && (
                    <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                      {t("update.released", {
                        date: new Date(
                          updateInfo.releaseDate
                        ).toLocaleDateString()
                      })}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-3 pt-4">
            {updateInfo?.requiresManualDownload ? (
              // macOS manual download buttons
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowUpdateDialog(false)}
                  className="w-full sm:w-auto"
                >
                  {t("update.later")}
                </Button>
                <Button
                  onClick={() =>
                    window.open(
                      "https://www.cliply.space/download/macos/autoupdates",
                      "_blank"
                    )
                  }
                  variant="outline"
                  className="w-full sm:w-auto"
                >
                  {t("update.learnWhy")}
                </Button>
                <Button
                  onClick={() =>
                    window.open(
                      `https://github.com/Cliply/Cliply/releases/latest`,
                      "_blank"
                    )
                  }
                  className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700 transition-all duration-200"
                >
                  {t("update.downloadFromGithub")}
                </Button>
              </>
            ) : (
              // Regular download buttons
              <>
                <Button
                  variant="outline"
                  onClick={() => setShowUpdateDialog(false)}
                  className="w-full sm:w-auto"
                >
                  {t("update.later")}
                </Button>
                <Button
                  onClick={handleDownloadUpdate}
                  className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700 transition-all duration-200"
                >
                  {t("update.downloadUpdate")}
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
                  <span className="text-cyan-600 dark:text-cyan-400 font-bold text-2xl">
                    *
                  </span>
                </div>
                <div>
                  <DialogTitle className="text-left">
                    {t("update.readyToInstall")}
                  </DialogTitle>
                  <DialogDescription className="text-left">
                    {t("update.readyToInstallDesc")}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {updateInfo && (
              <div className="text-center py-6">
                <div className="rounded-lg bg-slate-100/80 dark:bg-slate-700/50 p-4">
                  <h4 className="font-medium text-slate-900 dark:text-white">
                    {t("update.version", { version: updateInfo.version })}
                  </h4>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    {t("update.whenReady")}
                  </p>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-3 pt-4">
            <Button
              variant="outline"
              onClick={() => setShowInstallDialog(false)}
              className="w-full sm:w-auto"
            >
              {t("update.later")}
            </Button>
            <Button
              onClick={handleInstallUpdate}
              className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700 transition-all duration-200"
            >
              {t("update.installRestart")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default UpdateNotification
