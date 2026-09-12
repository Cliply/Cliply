import { useEffect } from "react"
import { toast } from "sonner"

import {
  downloadApi,
  settingsApi,
  systemApi,
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
    let buffered: DownloadProgress[] | null = []
    let mounted = true

    /**
     * every event for a download this window has no row for, in arrival order
     *
     * not the first one: a download admitted after this window read its list
     * sends progress and then finishes, and keeping only the event that
     * provoked the lookup meant replaying "downloading, 1%" over a row main had
     * just described as completed. Whatever arrives while the answer is coming
     * belongs to the same download and is replayed in the order it arrived.
     */
    const pending = new Map<string, PendingEvents>()

    /**
     * the ids main does not know either
     *
     * dropped for good, because there is nothing to draw and every later event
     * for the same id would ask again: a dead id reported four times a second
     * is four reads a second. An id only lands here after a read that began
     * *after* we first heard of it came back without it, twice - see
     * `reconcile`.
     */
    const concluded = new Set<string>()

    /**
     * the downloads whose ending has already been announced
     *
     * a terminal event is replayed - over hydration, and over a row a re-read
     * has just brought in - and a toast is owed once per download, not once per
     * time its event is applied. A row that arrives from a snapshot already
     * finished is not announced at all: nobody was waiting on this window for
     * it.
     */
    const announced = new Set<string>()

    let reading = false
    let failures = 0

    /** apply an event, and say the outcome if this is where it lands */
    const take = (event: DownloadProgress) => {
      downloadsActions.applyEvent(event)
      announceOnce(event)
    }

    const announceOnce = (event: DownloadProgress) => {
      if (!isTerminalStatus(event.status)) return
      if (announced.has(event.downloadId)) return

      const row = downloadsActions.rowOf(event.downloadId)
      if (!row) return

      announced.add(event.downloadId)
      announce(row, event)
    }

    const handleProgress = (event: DownloadProgress) => {
      // read before the store is touched, only to learn whose event this is. an
      // id nothing knows yet is not a row we could invent: it would have no
      // title, no label and no request, which is a row that can be neither read
      // nor retried
      const known = downloadsActions.rowOf(event.downloadId)

      downloadsActions.applyEvent(event)

      if (buffered) buffered.push(event)

      reconcileCancelIntent(event)

      if (known) {
        announceOnce(event)
        return
      }

      // ...and an id we do not have, once the startup window has closed, is
      // main's to explain: it admitted a download this window never saw
      if (!buffered) remember(event)
    }

    /**
     * keep an event for a download we have no row for, and ask main about it
     *
     * the case is a start whose acknowledgement never reached a renderer: main
     * was still preparing the download folder when the window reloaded, so
     * neither snapshot mentioned it, and then it was reserved and run. Without
     * this the panel has no row for a download holding a slot - no Stop, no
     * outcome - until the next launch reads it out of the history.
     */
    const remember = (event: DownloadProgress) => {
      if (concluded.has(event.downloadId)) return

      const held = pending.get(event.downloadId)

      if (held) held.events.push(event)
      else pending.set(event.downloadId, { events: [event], misses: 0 })

      read()
    }

    /**
     * ask main for its snapshot, once at a time
     *
     * one read for every id waiting on one: a run reports four times a second
     * and two unknown downloads are still one question. Which ids this read can
     * answer for is decided here, when it is issued: an id discovered while it
     * was in flight is not one of them, because main built that answer before
     * it had ever heard of it.
     */
    const read = () => {
      if (reading || pending.size === 0) return

      reading = true

      const covered = new Set(pending.keys())
      // the generation the read is issued under: a "clear history" between the
      // question and the answer makes the history half of the answer describe a
      // list that no longer exists
      const generation = downloadsActions.generation()

      Promise.all([downloadApi.getAllDownloads(), downloadApi.getHistory()])
        .then(([active, history]) => {
          if (!mounted) return

          failures = 0
          reconcile(covered, () =>
            downloadsActions.adopt(active, history, generation)
          )
        })
        .catch((error: unknown) => {
          if (!mounted) return

          failures += 1

          // one retry, and then these ids are let go: a bridge that is refusing
          // reads is not something to ask a third time on every progress line
          console.error("Failed to re-read the downloads list:", error)

          reconcile(covered, null, failures > 1)
        })
    }

    /**
     * merge what main sent, replay what was waiting, and decide what to ask next
     *
     * an id this read covered and answered for gets its events replayed in
     * arrival order and is done with. An id it covered and did not mention is
     * one main may not know at all - but a snapshot can be built a moment before
     * a reservation, so it takes two such answers to conclude that, and one
     * more read to get them.
     *
     * an id the read did not cover is not answered either way: it was admitted
     * after the answer was built, which is precisely the case this whole
     * mechanism exists for, and it waits for the next read.
     */
    const reconcile = (
      covered: Set<string>,
      merge: (() => void) | null,
      giveUp = false
    ) => {
      reading = false

      merge?.()

      for (const downloadId of covered) {
        const held = pending.get(downloadId)

        if (!held) continue

        if (downloadsActions.rowOf(downloadId)) {
          pending.delete(downloadId)

          for (const event of held.events) take(event)

          continue
        }

        // a read that began after we heard of this id came back without it
        if (merge) held.misses += 1

        if (giveUp || held.misses > 1) {
          pending.delete(downloadId)
          concluded.add(downloadId)
        }
      }

      // whatever is still waiting - an id admitted after this read was issued,
      // or one answer short of being let go - asks again, in one more read
      read()
    }

    /**
     * close the window: the rows main knows, then everything that happened
     * while we were asking
     *
     * the replay comes after hydration and in arrival order, so the newest
     * state wins whatever the snapshot said, and the announcements come after
     * the replay so a row is described as it finally stands. an event whose id
     * neither hydration nor the store knows goes to `remember`, the same path
     * every later event takes: main may have admitted that download while this
     * window was reading.
     */
    const settle = (hydrate: () => void) => {
      const replay = buffered ?? []
      buffered = null

      hydrate()

      for (const event of replay) downloadsActions.applyEvent(event)

      for (const event of replay) {
        if (downloadsActions.rowOf(event.downloadId)) {
          announceOnce(event)
          continue
        }

        remember(event)
      }
    }

    // subscribed before the two reads below, not after: an event arriving in
    // that window would otherwise be lost, and nothing pushes a correction
    const stopListening = downloadApi.onProgress(handleProgress)

    // three reads, one window: the rows main has in flight, the rows it
    // remembers, and the lifetime count the panel shows above them. the count
    // is its own channel because the history reply is the rows array itself
    // (see handleGetHistory in ipc-handlers.js)
    const generation = downloadsActions.generation()

    Promise.all([
      downloadApi.getAllDownloads(),
      downloadApi.getHistory(),
      settingsApi.getDownloadCount()
    ])
      .then(([active, history, lifetime]) => {
        if (mounted) {
          settle(() =>
            downloadsActions.hydrate(active, history, lifetime, generation)
          )
        }
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

/** what is waiting on main's answer about one download */
interface PendingEvents {
  events: DownloadProgress[]
  /** how many reads that knew to ask about this id came back without it */
  misses: number
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
