import { useT } from "@/lib/i18n"
import { isSelectableEntry, usePlaylistStore } from "@/lib/stores/playlistStore"
import { summarizeBadges, type PlaylistPhase } from "@/lib/playlistView"
import { cn } from "@/lib/utils"
import { PlaylistRow } from "./PlaylistRow"

interface PlaylistListProps {
  phase: PlaylistPhase
  className?: string
}

/**
 * the videos a playlist holds, and which of them are going to be downloaded
 */
export function PlaylistList({ phase, className }: PlaylistListProps) {
  const {
    playlistInfo,
    selectedIndices,
    itemStatus,
    toggleIndex,
    selectAll,
    selectNone
  } = usePlaylistStore()
  const t = useT()

  if (!playlistInfo) return null

  const entries = playlistInfo.entries
  // an unavailable row is not a row anybody can choose, so it is not part of
  // the "of N" either: "9 of 11 selected" with two that can never be ticked
  // reads as a broken checkbox
  const selectable = entries.filter(isSelectableEntry).length

  return (
    <div className={cn("font-space-grotesk", className)}>
      <div className="flex items-center gap-3 border-y border-slate-200/70 py-2 text-[12.5px] dark:border-slate-700/60">
        {phase === "picking" ? (
          <>
            <button
              type="button"
              onClick={selectAll}
              className="text-cyan-700 transition-colors hover:text-cyan-800 dark:text-cyan-400 dark:hover:text-cyan-300"
            >
              {t("playlist.selectAll")}
            </button>
            <span className="text-slate-300 dark:text-slate-600">|</span>
            <button
              type="button"
              onClick={selectNone}
              className="text-cyan-700 transition-colors hover:text-cyan-800 dark:text-cyan-400 dark:hover:text-cyan-300"
            >
              {t("playlist.selectNone")}
            </button>
          </>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">
            {t("playlist.perVideoStatus")}
          </span>
        )}

        <span className="ml-auto text-slate-500 dark:text-slate-400">
          {phase === "picking"
            ? t("playlist.selectedCount", {
                n: selectedIndices.size,
                total: selectable
              })
            : summarizeBadges(itemStatus)}
        </span>
      </div>

      <div className="max-h-[46vh] overflow-y-auto overscroll-contain xl:max-h-[52vh]">
        {entries.map((entry) => (
          <PlaylistRow
            key={`${entry.index}-${entry.id ?? "gone"}`}
            entry={entry}
            phase={phase}
            selected={selectedIndices.has(entry.index)}
            status={itemStatus.get(entry.index)}
            onToggle={toggleIndex}
          />
        ))}
      </div>
    </div>
  )
}
