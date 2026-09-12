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
 * one event that arrived while the list was still being read
 *
 * `handled` records whether it has already been through `announce`, which is
 * the same question as whether the store had its row at the time: an event for
 * a row that was already there was applied and announced on arrival, and is
 * replayed only so that hydration's older snapshot cannot undo it.
 */
interface BufferedEvent {
  event: DownloadProgress
  handled: boolean
}

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
    /**
     * the events that land between subscribing and the list arriving
     *
     * subscribing first is not enough on its own. an event for a download the
     * store has not heard of yet is dropped by `applyEvent` - after a reload
     * that is every download in flight - and hydration then writes main's
     * snapshot of it, which the event has already made out of date. a download
     * that failed in that window would sit at "downloading" for the rest of the
     * session, in the active count, with its failure never reported.
     *
     * so every event in the window is kept, in arrival order, and replayed over
     * the rows hydration builds. `null` once that has happened, which is what
     * makes this a window rather than a queue: from then on events apply
     * straight through.
     */
    let buffered: BufferedEvent[] | null = []
    let mounted = true

    const handleProgress = (event: DownloadProgress) => {
      // read before the store is touched, only to learn whose event this is. an
      // id nothing knows yet is not a row we could invent: it would have no
      // title, no label and no request, which is a row that can be neither read
      // nor retried
      const known = downloadsActions.rowOf(event.downloadId)

      downloadsActions.applyEvent(event)

      if (buffered) buffered.push({ event, handled: Boolean(known) })

      reconcileCancelIntent(event)

      if (known) announce(known, event)
    }

    /**
     * close the window: the rows main knows, then everything that happened
     * while we were asking
     *
     * the replay comes after hydration and in arrival order, so the newest
     * state wins whatever the snapshot said, and the announcements come after
     * the replay so a row is described as it finally stands. an event whose id
     * neither hydration nor the store knows is still dropped - it belongs to a
     * download nothing can say anything about.
     */
    const settle = (hydrate: () => void) => {
      const replay = buffered ?? []
      buffered = null

      hydrate()

      for (const { event } of replay) downloadsActions.applyEvent(event)

      for (const { event, handled } of replay) {
        if (handled) continue

        const row = downloadsActions.rowOf(event.downloadId)
        if (row) announce(row, event)
      }
    }

    // subscribed before the two reads below, not after: an event arriving in
    // that window would otherwise be lost, and nothing pushes a correction
    const stopListening = downloadApi.onProgress(handleProgress)

    Promise.all([downloadApi.getAllDownloads(), downloadApi.getHistory()])
      .then(([active, history]) => {
        if (mounted) settle(() => downloadsActions.hydrate(active, history))
      })
      .catch((error: unknown) => {
        // a list we could not read is an empty panel, not a broken app: every
        // download started from here on still arrives on the subscription
        console.error("Failed to load the downloads list:", error)

        // ...and the window still has to close, or an event that arrived inside
        // it would wait in the buffer for the life of the session
        if (mounted) settle(() => {})
      })

    return () => {
      mounted = false
      stopListening()
    }
  }, [])

  return null
}

/**
 * ask again for a Stop main was not yet in a position to take
 *
 * the panel's Stop can reach main before it has reserved the id - it reserves
 * only after preparing the download folder - and the answer is `false` against
 * nothing at all. the intent is kept by the row (see `stopDownload` in
 * `DownloadRow`), and this is the moment it becomes askable: an event from main
 * means the id exists there now.
 *
 * here rather than in the row, because the row is not the thing that has to be
 * on screen for a Stop to stick: the panel can be closed, or the app looking at
 * another screen entirely, and the download the user stopped should still stop.
 *
 * a terminal event drops the intent instead. the download is over, and asking
 * main to cancel a finished one only earns another `false`.
 */
function reconcileCancelIntent(event: DownloadProgress): void {
  if (isTerminalStatus(event.status)) {
    downloadsActions.takeCancelIntent(event.downloadId)
    return
  }

  if (event.status !== "queued" && event.status !== "downloading") return
  if (!downloadsActions.takeCancelIntent(event.downloadId)) return

  downloadApi.cancelDownload(event.downloadId).catch((error: unknown) => {
    console.error("Failed to cancel download:", error)
  })
}

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
