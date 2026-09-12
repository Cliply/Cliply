import { useEffect } from "react"
import { toast } from "sonner"

import {
  downloadApi,
  systemApi,
  type DownloadListSnapshot,
  type DownloadProgress
} from "@/lib/api"
import { reconcileCancelIntent } from "@/lib/cancelIntent"
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
 * the two subscriptions every download is watched through, and the one read
 * that starts them
 *
 * mounted once, in `Providers`, so it outlives every screen. that is the whole
 * point of it: a listener that belonged to the video card died with the card,
 * which is how resetting to the hero mid-download lost the completion toast,
 * and how a second download drew its progress onto the first one's bar.
 *
 * main pushes the whole list whenever it changes and this replaces what the
 * store holds with it (`applySnapshot`), so there is nothing here that merges,
 * reconciles, re-reads or gives up on an id: the list is main's, and the
 * progress events are a layer over it. Rounds three to six of this panel's
 * review were all one defect, which was that this file used to decide what the
 * list was.
 *
 * playlists are the exception (see D9 in the tech plan): `usePlaylistDownload`
 * keeps its own listener, its own per-item badges and its own toasts, so this
 * updates a playlist's row and says nothing about it. both listeners receive
 * every event, so there is no routing here.
 */
export function DownloadEvents() {
  useEffect(() => {
    let mounted = true

    /**
     * the downloads whose ending has already been announced
     *
     * a toast is owed once per download, and only ever for an event: a row that
     * arrives from a snapshot already finished is one nobody in this window was
     * waiting on. The id is enough - they are never reused.
     */
    const announced = new Set<string>()

    /**
     * the endings that arrived before there was a row to attach them to
     *
     * a download this window never had a row for is usually somebody else's -
     * another window's, or one that ended before this one opened - and the
     * snapshot that names it says nothing about who was waiting. But a
     * completion can also overtake the push that lists its download, and that
     * one is this window's news: it is kept here and said when the row appears.
     *
     * bounded for the same reason the store's overlay is: a window that hears
     * about a great many downloads it has no rows for must not grow an entry
     * for each of them for ever.
     */
    const unannounced = new Map<string, DownloadProgress>()

    const handleProgress = (event: DownloadProgress) => {
      downloadsActions.applyEvent(event)
      reconcileCancelIntent(event)

      if (!isTerminalStatus(event.status)) return
      if (announced.has(event.downloadId)) return

      const row = downloadsActions.rowOf(event.downloadId)

      if (!row) {
        if (unannounced.size >= PENDING_LIMIT) {
          unannounced.delete(unannounced.keys().next().value as string)
        }

        unannounced.set(event.downloadId, event)
        return
      }

      announced.add(event.downloadId)
      announce(row, event)
    }

    /**
     * take main's list, and say what the events could not say yet
     *
     * an ending kept above belongs to a row that has just arrived, and the
     * announcement is owed once: the snapshot itself never announces anything,
     * because a row that arrives already finished is a download nobody in this
     * window was waiting on.
     */
    const applyList = (snapshot: DownloadListSnapshot) => {
      downloadsActions.applySnapshot(snapshot)

      if (unannounced.size === 0) return

      for (const entry of snapshot.rows) {
        const event = unannounced.get(entry.download_id)

        if (!event) continue

        unannounced.delete(entry.download_id)

        if (announced.has(entry.download_id)) continue

        const row = downloadsActions.rowOf(entry.download_id)
        if (!row) continue

        announced.add(entry.download_id)
        announce(row, event)
      }
    }

    // subscribed before the read below, not after: a push that lands in that
    // window is the newer list, and `applySnapshot` keeps whichever of the two
    // arrives with the higher number
    const stopListening = downloadApi.onProgress(handleProgress)
    const stopWatching = downloadApi.onList((snapshot) => {
      if (mounted) applyList(snapshot)
    })

    downloadApi
      .getList()
      .then((snapshot) => {
        if (mounted) applyList(snapshot)
      })
      .catch((error: unknown) => {
        // a list we could not read is an empty panel, not a broken app: the
        // next change to it arrives on the push channel anyway
        console.error("Failed to load the downloads list:", error)
      })

    return () => {
      mounted = false
      stopListening()
      stopWatching()
    }
  }, [])

  return null
}

/**
 * how many endings may wait for a row that has not arrived
 *
 * the same bound, and the same reason, as the store's overlay: an ending with
 * no row is either about to have one or was never this window's business.
 */
const PENDING_LIMIT = 200

/**
 * say what this event means for this row, if it means anything
 *
 * only the end of a download is announced, and only once. a playlist says its
 * own piece (see D9), and a cancel was asked for by somebody who has already
 * been told.
 */
function announce(row: DownloadRow, event: DownloadProgress): void {
  if (row.kind === "playlist") return
  if (!isTerminalStatus(event.status)) return

  if (event.status === "completed") {
    announceCompleted(row, event)
    return
  }

  if (event.status === "failed") {
    announceFailed(row, event)
  }
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
