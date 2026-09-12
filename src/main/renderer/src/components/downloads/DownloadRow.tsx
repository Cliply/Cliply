import { FolderOpen, RotateCcw, X } from "lucide-react"

import {
  ProgressBar,
  ProgressBarLabel,
  ProgressBarMeta,
  ProgressBarTrack,
  ProgressBarValue
} from "@/components/ui/progress-bar"
import { systemApi } from "@/lib/api"
import { requestStop } from "@/lib/cancelIntent"
import { canRetry, retryDownload } from "@/lib/downloadRetry"
import { localizeError, useT, type Key } from "@/lib/i18n"
import { type DownloadRow as Row } from "@/lib/stores/downloadsStore"
import { cn } from "@/lib/utils"

interface DownloadRowProps {
  row: Row
  /** the row a duplicate click sent the user here to find */
  highlighted?: boolean
}

/**
 * one download in the panel: what it is called, and the one thing to do with it
 *
 * the second pass cut the row to those two lines (the owner's decisions, in the
 * downloads-panel-v2 spec). A finished download is a name and "open folder"; a
 * running one adds its bar; a queued one says so and offers the stop that drops
 * it; one that did not make it says why in a line and offers Retry. No chip, no
 * size, no Remove: a list of forty rows is read by its titles, and everything
 * else on the row was competing with them.
 *
 * the quality, the mode and the platform that used to ride in the chip are the
 * words `chipOf` built from the request. they are gone rather than moved: the
 * title already names the media, and the panel is a list of what was downloaded
 * rather than a record of how.
 */
export function DownloadRow({ row, highlighted = false }: DownloadRowProps) {
  const t = useT()

  const live = row.status === "starting" || row.status === "downloading"
  const title = row.title || t("downloads.untitled")
  const standing = live ? "" : standingOf(row, t)

  return (
    <div
      data-download-id={row.downloadId}
      className={cn(
        // the app's card, in the panel's width: the same radius, the same
        // two-pixel slate border and blur as `PlaylistHeader`
        "flex flex-col gap-2 rounded-xl border-2 px-3.5 py-3",
        "border-slate-300/50 bg-white/70 backdrop-blur-sm",
        "dark:border-slate-700/50 dark:bg-slate-800/50",
        "transition-shadow duration-200",
        // the ring is the answer to "you already asked for this one": it says
        // which row, and then stops, because a permanent marker on a row the
        // user is now looking at is just decoration
        highlighted && "ring-2 ring-cyan-500/60 ring-offset-0"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className="min-w-0 flex-1 truncate text-[13px] text-slate-900 dark:text-white"
          title={row.title || undefined}
        >
          {title}
        </span>

        <RowAction row={row} live={live} />
      </div>

      {live && <LiveProgress row={row} label={title} />}

      {/* one line, whatever it was: the word for a state that has no bar, or
          main's reason for a failure in the reader's language */}
      {standing && (
        <p
          className={cn(
            "truncate font-mono text-[11px] leading-4",
            row.status === "failed"
              ? "text-red-600 dark:text-red-400"
              : "text-slate-500 dark:text-slate-400"
          )}
        >
          {standing}
        </p>
      )}
    </div>
  )
}

/**
 * the one control on a row, whichever one this row's state earns
 *
 * they are all the same small outline button (`StopButton` in
 * `DownloadProgressBar` is the same control on the inline card), and the tone
 * is what separates them: the app's error red under a Stop, its cyan under the
 * Retry that is the only thing to do with a download that failed.
 */
function RowAction({ row, live }: { row: Row; live: boolean }) {
  const t = useT()

  if (row.status === "queued" || live) {
    // nothing has spawned for a queued row, so "stopping" it is dropping the
    // reservation. main answers the same cancel either way and the `cancelled`
    // event it sends is what settles the row
    return (
      <ActionButton
        icon={<X className="h-3 w-3" />}
        label={t("progress.stop")}
        tone="danger"
        title={t("progress.stopTitle")}
        onClick={() => void requestStop(row.downloadId)}
      />
    )
  }

  if (row.status === "completed") {
    return (
      <ActionButton
        icon={<FolderOpen className="h-3 w-3" />}
        label={t("toast.openFolder")}
        onClick={() => void revealDownload(row)}
      />
    )
  }

  return (
    <ActionButton
      icon={<RotateCcw className="h-3 w-3" />}
      label={t("downloads.retry")}
      tone="accent"
      disabled={!canRetry(row)}
      title={canRetry(row) ? undefined : t("downloads.retryUnavailable")}
      onClick={() => void retryDownload(row)}
    />
  )
}

/**
 * show the file where it landed, or failing that the folder it landed in
 *
 * `showInFolder` answers false rather than throwing for a file that has been
 * moved, deleted or was never on the row (a history file an older version
 * wrote keeps no path), and main refuses any path outside the download folder.
 * every one of those ends at the folder itself, which is what the completion
 * toast offers too, so the two agree.
 */
async function revealDownload(row: Row): Promise<void> {
  try {
    if (row.filePath && (await systemApi.showInFolder(row.filePath))) return

    await systemApi.openDownloadFolder()
  } catch (error: unknown) {
    console.error("Failed to open the download folder:", error)
  }
}

/**
 * the bar, for the two states that have one
 *
 * the label is the title again, hidden: `ProgressBarTrack` names itself through
 * whatever `ProgressBarLabel` rendered, so leaving it out would point the
 * progressbar's `aria-labelledby` at an id nothing has. showing it twice in
 * 340px would be worse.
 */
function LiveProgress({ row, label }: { row: Row; label: string }) {
  const t = useT()
  const starting = row.status === "starting"
  const indeterminate = Boolean(row.indeterminate) || starting

  const meta = liveMeta(row, t, indeterminate, starting)

  return (
    <ProgressBar value={row.progress} isIndeterminate={indeterminate}>
      <ProgressBarLabel className="sr-only">{label}</ProgressBarLabel>
      <ProgressBarTrack />
      <div className="flex items-baseline justify-between gap-2">
        <ProgressBarMeta className="truncate">{meta}</ProgressBarMeta>
        <ProgressBarValue />
      </div>
    </ProgressBar>
  )
}

interface ActionButtonProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
  tone?: "neutral" | "danger" | "accent"
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled = false,
  title,
  tone = "neutral"
}: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-0.5",
        "font-mono text-[11px] leading-4 transition-colors duration-200 ease-out",
        tone === "accent"
          ? "border-cyan-300/80 text-cyan-700 hover:bg-cyan-100/70 dark:border-cyan-500/40 dark:text-cyan-300 dark:hover:bg-cyan-950/50"
          : "border-slate-200/70 text-slate-500 dark:border-slate-700/60 dark:text-slate-400",
        tone === "danger" &&
          "hover:border-red-300/80 hover:text-red-600 dark:hover:border-red-500/40 dark:hover:text-red-400",
        tone === "neutral" &&
          "hover:border-cyan-300/80 hover:text-cyan-700 dark:hover:border-cyan-500/40 dark:hover:text-cyan-300",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
      )}
    >
      {icon}
      {label}
    </button>
  )
}

type Translate = (key: Key, params?: Record<string, string | number>) => string

/**
 * what the bar says underneath itself while the download runs
 *
 * a playlist counts videos rather than bytes: the percentage beside it is the
 * item in flight, and how far through the run it is is the one thing the bar
 * cannot show.
 */
function liveMeta(
  row: Row,
  t: Translate,
  indeterminate: boolean,
  starting: boolean
): string {
  if (row.kind === "playlist" && typeof row.itemsTotal === "number") {
    return t("downloads.itemsProgress", {
      done: row.itemsCompleted ?? 0,
      total: row.itemsTotal
    })
  }

  if (indeterminate) {
    return starting ? t("progress.startingUp") : t("progress.trimming")
  }

  return [row.speed, row.eta && `ETA ${row.eta}`].filter(Boolean).join("  ·  ")
}

/**
 * the one line under a row that is not running
 *
 * a completed row says nothing: its name and "open folder" are the whole row,
 * which is what the second pass was for. the three that stopped early say which
 * of the three it was, and a failure says what main said, in the reader's
 * language, cut to the line it has room for.
 */
function standingOf(row: Row, t: Translate): string {
  switch (row.status) {
    case "queued":
      return t("downloads.queued")

    case "cancelled":
      return t("downloads.cancelled")

    case "interrupted":
      return t("downloads.interrupted")

    case "failed":
      return localizeError({
        message: row.error || t("download.wentWrong"),
        category: row.category
      }).message

    default:
      return ""
  }
}
