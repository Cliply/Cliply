import { Button } from "@/components/ui/button"
import { systemApi } from "@/lib/api"
import {
  failureSentence,
  summarizePlaylistItems,
  type PlaylistDownloadState
} from "@/lib/hooks/usePlaylistDownload"
import { useT } from "@/lib/i18n"
import { usePlaylistStore } from "@/lib/stores/playlistStore"
import { nameList, unsavedEntries } from "@/lib/playlistView"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"

interface PlaylistSummaryProps {
  state: PlaylistDownloadState
  /** re-run whatever is ticked now; `ignoreArchive` drops the resume archive */
  onRun: (options?: { ignoreArchive?: boolean }) => void
  /** tick exactly these positions, then run */
  onRetry: (indices: number[]) => void
  /** put the checkboxes back so a different selection can be made */
  onPickAgain: () => void
  className?: string
}

/**
 * how a playlist run ends
 *
 * a partial run is a **normal outcome**, not an error: eight of nine videos
 * saved is eight videos the user now has, and an error card over it would hide
 * that. so the headline is always what the run did, and what it did not do is
 * named underneath with something to do about it.
 *
 * which is why every outcome lands on the same card the picker and the
 * progress screen are drawn on. a coloured card is a verdict, and there is no
 * one verdict to give: nine of nine is not a banner, eight of nine is not an
 * error, and the run that failed outright says so in the headline.
 */
export function PlaylistSummary({
  state,
  onRun,
  onRetry,
  onPickAgain,
  className
}: PlaylistSummaryProps) {
  const { playlistInfo, selectedIndices, itemStatus } = usePlaylistStore()
  const t = useT()

  const unsaved = unsavedEntries(
    playlistInfo?.entries ?? [],
    selectedIndices,
    itemStatus
  )

  const failed = state.status === "failed"
  const cancelled = state.status === "cancelled"

  const headline = failed
    ? t("playlist.failed")
    : summarizePlaylistItems({
        saved: state.itemsSaved,
        reused: state.itemsReused,
        skipped: state.itemsSkipped,
        total: state.itemsTotal
      }) || t(cancelled ? "playlist.cancelled" : "playlist.finished")

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn(
        "rounded-2xl border-2 p-5 space-y-4 font-space-grotesk",
        "dark:bg-slate-800/40 dark:border-slate-700/50 dark:backdrop-blur-sm",
        "bg-white/60 border-slate-300/50 backdrop-blur-sm shadow-xl",
        className
      )}
    >
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-slate-900 dark:text-white">
          {headline}
        </p>

        {failed && (
          // the same sentence the failure toast said, built by the same
          // function: main's wording, in the reader's language where the
          // category names a russian one, and ours when it sent none
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {failureSentence(state)}
          </p>
        )}

        {cancelled && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t("playlist.cancelledHint")}
          </p>
        )}

        {/*
          one miss is named without a count, and it is the sentence that says
          so rather than a plural form: russian's `one` covers 21 and 101 too
        */}
        {!failed && unsaved.length > 0 && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t(
              unsaved.length === 1
                ? "playlist.notSavedOne"
                : "playlist.notSavedMany",
              { n: unsaved.length, names: nameList(unsaved) }
            )}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => systemApi.openDownloadFolder()}
          className="bg-cyan-600 hover:bg-cyan-700 text-white"
        >
          {t("toast.openFolder")}
        </Button>

        {unsaved.length > 0 && (
          <Button
            variant="outline"
            onClick={() => onRetry(unsaved.map((entry) => entry.index))}
          >
            {t("playlist.retryFailed", { n: unsaved.length })}
          </Button>
        )}

        {/*
          the archive records that a download once succeeded, not that the file
          is there now. a user who deleted the files gets "5 already
          downloaded" over an empty folder, and this is the way out of it
        */}
        {(state.itemsReused ?? 0) > 0 && (
          <Button
            variant="outline"
            onClick={() => onRun({ ignoreArchive: true })}
          >
            {t("playlist.downloadAgain")}
          </Button>
        )}

        <Button variant="ghost" onClick={onPickAgain}>
          {t("playlist.pickAgain")}
        </Button>
      </div>
    </motion.div>
  )
}
