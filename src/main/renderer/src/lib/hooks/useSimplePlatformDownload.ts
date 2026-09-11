import { SIMPLE_QUALITY, track } from "@/lib/analytics"
import { DownloadError, systemApi } from "@/lib/api"
import { localizeError, useT } from "@/lib/i18n"
import { reportActions } from "@/lib/stores/reportStore"
import type { Platform } from "@/lib/stores/store"
import {
  showDownloadErrorToast,
  showServerOverwhelmedToast
} from "@/lib/toast-utils"
import { toast } from "sonner"

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
    download: (request: { url: string; title?: string }) => Promise<unknown>
  }
  /** the loaded media's title, which keeps it in the output filename */
  title?: string
}

/**
 * the one download pinterest and tiktok both have
 *
 * neither platform offers a choice of quality, of format or of a range, so a
 * download is the stored url and a click. The two differ only in the four
 * things the caller passes: everything that happens to the url afterwards -
 * the start event, the success toast, which failures are the server being
 * overwhelmed rather than this download, the report staged for the rest - is
 * one behaviour.
 */
export function useSimplePlatformDownload({
  platform,
  store,
  api,
  title
}: SimplePlatformDownloadOptions) {
  const { url, isDownloading, setIsDownloading } = store()
  const t = useT()

  const handleDownload = async () => {
    if (!url || isDownloading) return
    try {
      setIsDownloading(true)

      // main reports this download's end, so it has to hear about its start:
      // completions with no starts is a funnel that shows the impossible
      track("download_started", {
        platform,
        media_type: "video",
        quality: SIMPLE_QUALITY,
        // there is no trimming here to report - no range is ever sent
        is_trimmed: false
      })

      await api.download({ url, title })
      toast.success(t("download.complete"), {
        action: {
          label: t("toast.openFolder"),
          onClick: () => systemApi.openDownloadFolder()
        }
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to download video"
      if (message.includes("network") || message.includes("fetch")) {
        showServerOverwhelmedToast()
      } else {
        reportActions.stage({
          shortMessage: message,
          details: error instanceof DownloadError ? error.details : undefined,
          category: error instanceof DownloadError ? error.category : undefined,
          platform,
          downloadType: "video",
          videoUrl: url
        })
        showDownloadErrorToast(
          t("download.failed"),
          // the staged report above keeps main's english; the toast is read
          localizeError({
            message,
            category:
              error instanceof DownloadError ? error.category : undefined
          }).message,
          error instanceof DownloadError ? error.category : undefined,
          platform
        )
      }
    } finally {
      setIsDownloading(false)
    }
  }

  return { isDownloading, handleDownload }
}
