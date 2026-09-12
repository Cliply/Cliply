import { FolderOpen, RotateCcw, Trash2, X } from "lucide-react"

import {
  ProgressBar,
  ProgressBarLabel,
  ProgressBarMeta,
  ProgressBarTrack,
  ProgressBarValue
} from "@/components/ui/progress-bar"
import {
  systemApi,
  type AudioDownloadRequest,
  type AudioMode,
  type PlaylistDownloadRequest,
  type VideoDownloadRequest
} from "@/lib/api"
import { requestStop } from "@/lib/cancelIntent"
import { canRetry, retryDownload } from "@/lib/downloadRetry"
import { videoLabel } from "@/lib/downloadKinds"
import { formatFileSize } from "@/lib/format"
import { localizeError, useT, type Key } from "@/lib/i18n"
import {
  useDownloadsStore,
  type DownloadRow as Row
} from "@/lib/stores/downloadsStore"
import { cn } from "@/lib/utils"

interface DownloadRowProps {
  row: Row
  /** the row a duplicate click sent the user here to find */
  highlighted?: boolean
}

/**
 * one download in the panel, whatever state it is in
 *
 * three lines at most: the title, then the chip and where the download stands,
 * then the actions. a running download puts the bar between the second and the
 * third, and a failed one its sentence.
 *
 * the chip is assembled here rather than read off `row.label`, which main wrote
 * in english at reserve. the row has the request main built that label from, so
 * the panel can say the same thing in the reader's language - and falls back to
 * main's when the request is missing, which is any row read from a history file
 * an older version wrote.
 */
export function DownloadRow({ row, highlighted = false }: DownloadRowProps) {
  const t = useT()
  const remove = useDownloadsStore((state) => state.remove)

  const live = row.status === "starting" || row.status === "downloading"
  const title = row.title || t("downloads.untitled")

  return (
    <div
      data-download-id={row.downloadId}
      className={cn(
        "flex flex-col gap-2 rounded-xl border px-3 py-2.5",
        "border-slate-200/70 bg-white/60 dark:border-slate-700/50 dark:bg-slate-800/40",
        "transition-shadow duration-200",
        // the ring is the answer to "you already asked for this one": it says
        // which row, and then stops, because a permanent marker on a row the
        // user is now looking at is just decoration
        highlighted && "ring-2 ring-cyan-500/60 ring-offset-0"
      )}
    >
      <span
        className="truncate text-[13px] font-medium text-slate-800 dark:text-slate-100"
        title={row.title || undefined}
      >
        {title}
      </span>

      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10.5px] leading-4",
            "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/60 dark:text-cyan-300"
          )}
        >
          {chipOf(row, t)}
        </span>

        <span className="truncate font-mono text-[11px] leading-4 tabular-nums text-slate-500 dark:text-slate-400">
          {standingOf(row, t)}
        </span>
      </div>

      {live && <LiveProgress row={row} label={title} />}

      {row.status === "failed" && (
        <p className="text-[11px] leading-4 text-red-600 dark:text-red-400">
          {
            localizeError({
              message: row.error || t("download.wentWrong"),
              category: row.category
            }).message
          }
        </p>
      )}

      <div className="flex items-center justify-end gap-1.5">
        {row.status === "queued" && (
          // nothing has spawned yet, so "stopping" it is dropping the
          // reservation. main answers the same cancel either way and the
          // `cancelled` event it sends is what settles the row
          <RowAction
            icon={<X className="h-3 w-3" />}
            label={t("downloads.remove")}
            tone="danger"
            onClick={() => stopDownload(row.downloadId)}
          />
        )}

        {live && (
          <RowAction
            icon={<X className="h-3 w-3" />}
            label={t("progress.stop")}
            tone="danger"
            title={t("progress.stopTitle")}
            onClick={() => stopDownload(row.downloadId)}
          />
        )}

        {row.status === "completed" && (
          // the row keeps a size, not a path (see the Q4 notes), so this is the
          // download folder rather than the file. it is also the one action the
          // completion toast offers, so the two agree
          <RowAction
            icon={<FolderOpen className="h-3 w-3" />}
            label={t("toast.openFolder")}
            onClick={() => {
              systemApi.openDownloadFolder().catch((error: unknown) => {
                console.error("Failed to open the download folder:", error)
              })
            }}
          />
        )}

        {(row.status === "failed" ||
          row.status === "cancelled" ||
          row.status === "interrupted") && (
          <RowAction
            icon={<RotateCcw className="h-3 w-3" />}
            label={t("downloads.retry")}
            disabled={!canRetry(row)}
            title={canRetry(row) ? undefined : t("downloads.retryUnavailable")}
            onClick={() => void retryDownload(row)}
          />
        )}

        {isFinished(row) && (
          <RowAction
            icon={<Trash2 className="h-3 w-3" />}
            label={t("downloads.remove")}
            onClick={() => remove(row.downloadId)}
          />
        )}
      </div>
    </div>
  )
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

  const meta = indeterminate
    ? starting
      ? t("progress.startingUp")
      : t("progress.trimming")
    : [row.speed, row.eta && `ETA ${row.eta}`].filter(Boolean).join("  ·  ")

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

interface RowActionProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
  tone?: "neutral" | "danger"
}

/**
 * one of the small pill buttons along the bottom of a row
 *
 * the same shape as the stop control on the inline card (`StopButton` in
 * `DownloadProgressBar`), because it is the same control in a narrower place:
 * neutral until you reach for it, then either the app's error red or its slate.
 */
function RowAction({
  icon,
  label,
  onClick,
  disabled = false,
  title,
  tone = "neutral"
}: RowActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-0.5",
        "font-mono text-[11px] leading-4 transition-colors duration-200 ease-out",
        "border-slate-200/70 text-slate-500 dark:border-slate-700/60 dark:text-slate-400",
        tone === "danger"
          ? "hover:border-red-300/80 hover:text-red-600 dark:hover:border-red-500/40 dark:hover:text-red-400"
          : "hover:border-cyan-300/80 hover:text-cyan-700 dark:hover:border-cyan-500/40 dark:hover:text-cyan-300",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/** whether there is nothing left to happen to this row */
const isFinished = (row: Row): boolean =>
  row.status === "completed" ||
  row.status === "failed" ||
  row.status === "cancelled" ||
  row.status === "interrupted"

// stopping a download is more than one ipc call - main may not have the id yet
// - so the whole of it lives in `lib/cancelIntent.ts`, where the start paths
// and the event listener can reach the other half of it
const stopDownload = (downloadId: string) => {
  void requestStop(downloadId)
}

/** the mode an audio download was asked for, in the dropdown's own words */
const AUDIO_MODE_KEYS: Record<AudioMode, Key> = {
  mp3: "format.mp3",
  m4a: "format.m4a",
  original: "dropdown.original"
}

const SIMPLE_PLATFORM_KEYS: Record<"tiktok" | "pinterest", Key> = {
  tiktok: "downloads.platformTiktok",
  pinterest: "downloads.platformPinterest"
}

type Translate = (key: Key, params?: Record<string, string | number>) => string

/**
 * the words beside the title: "1080p mp4", "MP3", "12 videos", "TikTok"
 *
 * read from the request, which is what main built its own english label from,
 * so the two say the same thing in two languages. a row with no request keeps
 * main's, which is the only thing there is to show.
 */
function chipOf(row: Row, t: Translate): string {
  if (row.kind === "playlist") {
    const playlist = row.request as PlaylistDownloadRequest | undefined
    const count = row.itemsTotal ?? playlist?.entries?.length

    return typeof count === "number"
      ? t("playlist.videoCount", { n: count })
      : row.label
  }

  if (row.kind === "audio") {
    const mode = (row.request as AudioDownloadRequest | undefined)?.audio_mode
    const key = mode && AUDIO_MODE_KEYS[mode]

    return key ? t(key) : row.label
  }

  if (row.kind === "simple") {
    const key =
      row.platform === "tiktok" || row.platform === "pinterest"
        ? SIMPLE_PLATFORM_KEYS[row.platform]
        : undefined

    return key ? t(key) : row.label
  }

  const video = row.request as VideoDownloadRequest | undefined

  if (typeof video?.height !== "number") return row.label

  return video.container
    ? videoLabel(video.height, video.container)
    : `${video.height}p`
}

/**
 * where this download stands, in the line opposite the chip
 *
 * a running one says nothing here: the bar underneath already carries the
 * speed, the eta and the percentage, and the one thing it cannot say is how far
 * through a playlist the run is.
 *
 * a finished playlist counts videos rather than bytes. `file_size` on a
 * playlist's completed event describes the last file that landed, not the run
 * (noted on Q2), so the honest number is what it saved out of what it was
 * given.
 */
function standingOf(row: Row, t: Translate): string {
  switch (row.status) {
    case "queued":
      return t("downloads.queued")

    case "starting":
    case "downloading":
      return row.kind === "playlist" && typeof row.itemsTotal === "number"
        ? t("downloads.itemsProgress", {
            done: row.itemsCompleted ?? 0,
            total: row.itemsTotal
          })
        : ""

    case "completed":
      if (row.kind === "playlist") {
        return typeof row.itemsSaved === "number" &&
          typeof row.itemsTotal === "number"
          ? t("playlist.summarySaved", {
              saved: row.itemsSaved,
              n: row.itemsTotal
            })
          : t("downloads.done")
      }

      return row.fileSize
        ? `${t("downloads.done")} · ${formatFileSize(row.fileSize)}`
        : t("downloads.done")

    case "cancelled":
      return t("downloads.cancelled")

    case "interrupted":
      return t("downloads.interrupted")

    // the sentence on its own line below says what happened
    default:
      return ""
  }
}
