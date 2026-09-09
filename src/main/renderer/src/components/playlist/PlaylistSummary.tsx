import { Button } from "@/components/ui/button"
import { systemApi } from "@/lib/api"
import {
  summarizePlaylistItems,
  type PlaylistDownloadState
} from "@/lib/hooks/usePlaylistDownload"
import { usePlaylistStore } from "@/lib/playlistStore"
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
 */
export function PlaylistSummary({
  state,
  onRun,
  onRetry,
  onPickAgain,
  className
}: PlaylistSummaryProps) {
  const { playlistInfo, selectedIndices, itemStatus } = usePlaylistStore()

  const unsaved = unsavedEntries(
    playlistInfo?.entries ?? [],
    selectedIndices,
    itemStatus
  )

  const failed = state.status === "failed"
  const cancelled = state.status === "cancelled"

  const headline = failed
    ? "Playlist download failed"
    : summarizePlaylistItems({
        saved: state.itemsSaved,
        reused: state.itemsReused,
        skipped: state.itemsSkipped,
        total: state.itemsTotal
      }) ||
      (cancelled ? "Playlist download cancelled" : "Playlist download finished")

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn(
        "rounded-2xl border-2 p-5 space-y-4 font-space-grotesk",
        "backdrop-blur-sm shadow-xl",
        failed
          ? "bg-red-50/80 border-red-200 dark:bg-red-950/20 dark:border-red-900/50"
          : "bg-emerald-50/70 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-900/50",
        className
      )}
    >
      <div className="space-y-1.5">
        <p
          className={cn(
            "text-base font-semibold",
            failed
              ? "text-red-700 dark:text-red-300"
              : "text-emerald-700 dark:text-emerald-300"
          )}
        >
          {headline}
        </p>

        {failed && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {[state.error, state.suggestion].filter(Boolean).join(" ") ||
              "Something went wrong. You can send us the details."}
          </p>
        )}

        {cancelled && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Videos already saved are kept. Running it again picks up where this
            one stopped.
          </p>
        )}

        {!failed && unsaved.length > 0 && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {unsaved.length === 1 ? "Not saved: " : `${unsaved.length} not saved: `}
            {nameList(unsaved)}.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => systemApi.openDownloadFolder()}
          className="bg-cyan-600 hover:bg-cyan-700 text-white"
        >
          Open folder
        </Button>

        {unsaved.length > 0 && (
          <Button
            variant="outline"
            onClick={() => onRetry(unsaved.map((entry) => entry.index))}
          >
            {unsaved.length === 1
              ? "Retry the 1 that failed"
              : `Retry the ${unsaved.length} that failed`}
          </Button>
        )}

        {/*
          the archive records that a download once succeeded, not that the file
          is there now. a user who deleted the files gets "5 already
          downloaded" over an empty folder, and this is the way out of it
        */}
        {(state.itemsReused ?? 0) > 0 && (
          <Button variant="outline" onClick={() => onRun({ ignoreArchive: true })}>
            Download everything again
          </Button>
        )}

        <Button variant="ghost" onClick={onPickAgain}>
          Pick videos again
        </Button>
      </div>
    </motion.div>
  )
}
