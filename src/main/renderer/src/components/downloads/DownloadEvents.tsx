import { useEffect } from "react"
import { toast } from "sonner"

import { downloadApi, systemApi, type DownloadProgress } from "@/lib/api"
import { DOWNLOAD_WORDING } from "@/lib/downloadKinds"
import { localizeError, t } from "@/lib/i18n"
import {
  downloadsActions,
  isTerminalStatus,
  type DownloadRow
} from "@/lib/stores/downloadsStore"
import { reportActions } from "@/lib/stores/reportStore"
import { showDownloadErrorToast } from "@/lib/toast-utils"

/**
 * the one subscription to download:progress, and the only place a download's
 * outcome is announced
 *
 * mounted once, in `Providers`, so it outlives every screen. that is the whole
 * point of it: a listener that belonged to the video card died with the card,
 * which is how resetting to the hero mid-download lost the completion toast,
 * and how a second download drew its progress onto the first one's bar.
 *
 * playlists are the exception (see D9 in the tech plan): `usePlaylistDownload`
 * keeps its own listener, its own per-item badges and its own toasts, so this
 * updates a playlist's row and says nothing about it. both listeners receive
 * every event, so there is no routing here.
 */
export function DownloadEvents() {
  useEffect(() => {
    // subscribed before the two reads below, not after: an event arriving in
    // that window is lost otherwise, and nothing pushes a correction
    const stopListening = downloadApi.onProgress(handleProgress)

    let mounted = true

    Promise.all([downloadApi.getAllDownloads(), downloadApi.getHistory()])
      .then(([active, history]) => {
        if (mounted) downloadsActions.hydrate(active, history)
      })
      .catch((error: unknown) => {
        // a list we could not read is an empty panel, not a broken app: every
        // download started from here on still arrives on the subscription
        console.error("Failed to load the downloads list:", error)
      })

    return () => {
      mounted = false
      stopListening()
    }
  }, [])

  return null
}

/**
 * apply the event, then say what it means - once
 *
 * the row is read before the store is touched only to learn whose event this
 * is. an id the store does not have is dropped: `applyEvent` creates nothing,
 * and there is no row to announce the outcome of.
 */
function handleProgress(event: DownloadProgress): void {
  const row = downloadsActions.rowOf(event.downloadId)

  downloadsActions.applyEvent(event)

  if (!row || row.kind === "playlist") return
  if (!isTerminalStatus(event.status)) return

  if (event.status === "completed") {
    announceCompleted(row, event)
    return
  }

  if (event.status === "failed") {
    announceFailed(row, event)
  }

  // a cancel is not announced here: the user asked for it and the hook that
  // took the ask has already said so
}

function announceCompleted(row: DownloadRow, event: DownloadProgress): void {
  const filename = event.filename || row.filename

  toast.success(t(DOWNLOAD_WORDING[wordingKind(row)].completed), {
    description: filename ? t("download.saved", { filename }) : undefined,
    action: {
      label: t("toast.openFolder"),
      onClick: () => systemApi.openDownloadFolder()
    }
  })
}

function announceFailed(row: DownloadRow, event: DownloadProgress): void {
  reportActions.stage({
    // english on purpose, like every line of a report: the maintainer reading
    // the issue is not the user who filed it
    shortMessage: event.error || "Download failed",
    details: event.details,
    category: event.category,
    platform: row.platform,
    downloadType: row.kind === "audio" ? "audio" : "video",
    videoUrl: row.request?.url
  })

  showDownloadErrorToast(
    t(DOWNLOAD_WORDING[wordingKind(row)].failed),
    // the staged report above keeps main's english; only what is read here is
    // translated
    event.error
      ? localizeError({ message: event.error, category: event.category })
          .message
      : t("download.wentWrong"),
    event.category,
    row.platform
  )
}

/**
 * which set of sentences this row is announced with
 *
 * playlist rows never reach here, and the table has no entry for them, so the
 * narrowing is real rather than a formality.
 */
const wordingKind = (row: DownloadRow): keyof typeof DOWNLOAD_WORDING =>
  row.kind === "playlist" ? "video" : row.kind
