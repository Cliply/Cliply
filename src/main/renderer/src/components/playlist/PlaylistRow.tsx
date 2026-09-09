import type { PlaylistEntry } from "@/lib/api"
import { isSelectableEntry, type PlaylistItemStatus } from "@/lib/playlistStore"
import { rowBadge, type PlaylistPhase, type PlaylistRowBadge } from "@/lib/playlistView"
import { cn } from "@/lib/utils"
import { Check } from "lucide-react"

interface PlaylistRowProps {
  entry: PlaylistEntry
  phase: PlaylistPhase
  selected: boolean
  status?: PlaylistItemStatus
  onToggle: (index: number) => void
}

const BADGE_TONES: Record<PlaylistRowBadge["tone"], string> = {
  neutral: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  running: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  gone: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
}

/**
 * one video in the playlist
 *
 * while the user is picking, the row carries a checkbox and its duration. once
 * a run starts the checkbox gives way to a badge: the selection is fixed for
 * the length of the run, and a tick that changed nothing would be a lie about
 * what the download is doing.
 */
export function PlaylistRow({
  entry,
  phase,
  selected,
  status,
  onToggle
}: PlaylistRowProps) {
  const selectable = isSelectableEntry(entry)
  const badge = rowBadge(entry, phase, status)
  const picking = phase === "picking"

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-slate-200/60 px-2 py-2 last:border-b-0",
        "dark:border-slate-700/50 transition-colors duration-200",
        status?.state === "downloading" && "bg-sky-50/60 dark:bg-sky-950/20",
        !selectable && "opacity-60"
      )}
      data-index={entry.index}
    >
      {picking ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={entry.title}
          disabled={!selectable}
          onClick={() => onToggle(entry.index)}
          className={cn(
            "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2",
            "transition-colors duration-200",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50",
            selected
              ? "border-cyan-600 bg-cyan-600 text-white"
              : "border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800",
            !selectable &&
              "cursor-not-allowed border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800/60"
          )}
        >
          {selected && <Check className="h-3 w-3" strokeWidth={3} />}
        </button>
      ) : (
        <span className="w-[18px] shrink-0" aria-hidden="true" />
      )}

      <span className="w-7 shrink-0 font-mono text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
        {String(entry.index).padStart(2, "0")}
      </span>

      <Thumbnail entry={entry} />

      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          entry.unavailable
            ? "italic text-slate-400 dark:text-slate-500"
            : "text-slate-800 dark:text-slate-100"
        )}
        title={entry.title}
      >
        {entry.title}
      </span>

      {badge ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10.5px] leading-4",
            BADGE_TONES[badge.tone]
          )}
        >
          {badge.text}
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
          {entry.duration_string ?? ""}
        </span>
      )}
    </div>
  )
}

/**
 * the cap is a hundred rows, and every one of them carries a thumbnail.
 *
 * a hundred image requests fired the moment a playlist resolves is the one
 * expensive thing about this list, so the images are loaded lazily rather than
 * the rows being virtualised: it costs a single attribute, keeps the list a
 * plain scrollable column that find-in-page and a screen reader can both walk,
 * and a hundred rows of text is nothing to render.
 */
function Thumbnail({ entry }: { entry: PlaylistEntry }) {
  if (!entry.thumbnail) {
    return (
      <span className="h-[30px] w-[52px] shrink-0 rounded bg-slate-200 dark:bg-slate-700" />
    )
  }

  return (
    <img
      src={entry.thumbnail}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-[30px] w-[52px] shrink-0 rounded object-cover bg-slate-200 dark:bg-slate-700"
    />
  )
}
