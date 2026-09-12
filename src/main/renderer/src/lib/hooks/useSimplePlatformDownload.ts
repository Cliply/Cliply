import { SIMPLE_QUALITY, track } from "@/lib/analytics"
import { DownloadError } from "@/lib/api"
import { stopIfRequested } from "@/lib/cancelIntent"
import { DOWNLOAD_WORDING } from "@/lib/downloadKinds"
import { localizeError, useT } from "@/lib/i18n"
import {
  downloadsActions,
  isLiveRow,
  useDownloadRow
} from "@/lib/stores/downloadsStore"
import { reportActions } from "@/lib/stores/reportStore"
import type { Platform } from "@/lib/stores/store"
import {
  showDownloadErrorToast,
  showServerOverwhelmedToast
} from "@/lib/toast-utils"
import { useEffect, useState } from "react"

/** the platforms whose whole download is one quality behind one button */
export type SimplePlatform = Extract<Platform, "pinterest" | "tiktok">

/**
 * the slice of a platform store a download of this kind touches
 *
 * deliberately narrow: the two stores keep the loaded media under names of
 * their own, and which name that is stays none of this hook's business.
 */
interface SimpleDownloadSlice {
  url: string
  isDownloading: boolean
  setIsDownloading: (downloading: boolean) => void
}

export interface SimplePlatformDownloadOptions {
  /** named in the start event, in a staged report and in the error toast */
  platform: SimplePlatform
  /** the platform's store hook, read for the url and the in-flight flag */
  store: () => SimpleDownloadSlice
  /** the platform's api; only the one-shot download is reached for */
  api: {
    download: (request: {
      url: string
      title?: string
      download_id?: string
    }) => Promise<unknown>
  }
  /** the loaded media's title, which keeps it in the output filename */
  title?: string
}

/**
 * the one download pinterest and tiktok both have
 *
 * neither platform offers a choice of quality, of format or of a range, so a
 * download is the stored url and a click.
 *
 * these two used to be the odd ones out: main awaited the whole download and
 * answered with the finished file, so this hook toasted "complete" on the
 * reply. with a queue in front of the engine that reply would have had to wait
 * out the queue as well, so they now start and report through
 * `download:progress` like every other kind - which means the outcome belongs
 * to `DownloadEvents`, and what is left here is the row and the click.
 */
export function useSimplePlatformDownload({
  platform,
  store,
  api,
  title
}: SimplePlatformDownloadOptions) {
  const { url, setIsDownloading } = store()
  const t = useT()

  const [lastId, setLastId] = useState<string | undefined>(undefined)
  const row = useDownloadRow(lastId)
  // the row this card started is queued, starting or downloading - which is
  // what the button has always meant by "busy", minus the await
  const isDownloading = isLiveRow(row)

  // the platform store's own flag keeps its meaning for anything that reads it,
  // and the row is now the thing that decides what that meaning is
  useEffect(() => {
    setIsDownloading(isDownloading)
  }, [isDownloading, setIsDownloading])

  const handleDownload = async () => {
    if (!url || isDownloading) return

    const label = platform
    const request = { url, ...(title ? { title } : {}) }

    /**
     * the same pin or clip, asked for twice. two processes writing one `.part`
     * file corrupt each other, so the second click opens the panel on the first
     * download instead of starting beside it.
     */
    const existing = downloadsActions.findLive({
      kind: "simple",
      label,
      request
    })

    if (existing) {
      setLastId(existing.downloadId)
      downloadsActions.setHighlighted(existing.downloadId)
      downloadsActions.setPanelOpen(true)
      return
    }

    // minted here, so the row exists under it before main has answered
    const downloadId = crypto.randomUUID()
    setLastId(downloadId)

    downloadsActions.add({
      downloadId,
      kind: "simple",
      platform,
      title: title || "",
      // the platform is the only thing there is to say about what this download
      // is, which is the same label main puts on its own reservation
      label,
      status: "starting",
      progress: 0,
      startedAt: Date.now(),
      request
    })

    try {
      // main reports this download's end, so it has to hear about its start:
      // completions with no starts is a funnel that shows the impossible
      track("download_started", {
        platform,
        media_type: "video",
        quality: SIMPLE_QUALITY,
        // there is no trimming here to report - no range is ever sent
        is_trimmed: false
      })

      // resolves at the acknowledgement; the download itself is followed on
      // download:progress, and its outcome is announced by DownloadEvents
      await api.download({ ...request, download_id: downloadId })

      // ...and the acknowledgement is also when main first has an id to
      // cancel, so a Stop pressed on this row before now goes out here (see
      // `lib/cancelIntent.ts`)
      stopIfRequested(downloadId)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to download video"

      // no event will ever come for a start main refused, so the row is settled
      // here rather than left waiting for one
      downloadsActions.applyEvent({
        downloadId,
        status: "failed",
        progress: 0,
        error: message,
        category: error instanceof DownloadError ? error.category : undefined
      })

      if (message.includes("network") || message.includes("fetch")) {
        showServerOverwhelmedToast()
        return
      }

      reportActions.stage({
        shortMessage: message,
        details: error instanceof DownloadError ? error.details : undefined,
        category: error instanceof DownloadError ? error.category : undefined,
        platform,
        downloadType: "video",
        videoUrl: url
      })
      showDownloadErrorToast(
        t(DOWNLOAD_WORDING.simple.failed),
        // the staged report above keeps main's english; the toast is read
        localizeError({
          message,
          category: error instanceof DownloadError ? error.category : undefined
        }).message,
        error instanceof DownloadError ? error.category : undefined,
        platform
      )
    }
  }

  return { isDownloading, handleDownload }
}
