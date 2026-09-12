import { AnimatePresence, motion } from "framer-motion"
import { X } from "lucide-react"
import { useEffect, useRef } from "react"

import { MONO } from "@/lib/fonts"
import { useT } from "@/lib/i18n"
import {
  isLiveRow,
  useActiveCount,
  useDownloadRows,
  useDownloadsStore
} from "@/lib/stores/downloadsStore"
import { cn } from "@/lib/utils"

import { DownloadRow } from "./DownloadRow"

/** how long the ring on a highlighted row stays before it clears itself */
const HIGHLIGHT_MS = 2000

/**
 * every download this install knows about, on the right edge
 *
 * mounted once in `App`, outside the routes, for the same reason
 * `DownloadEvents` is mounted once in `Providers`: the list has to outlive the
 * screen that started any of it. All the state it needs is in `downloadsStore`
 * already (the rows, `panelOpen`, `highlightedId`), so there is no provider and
 * no context - the hooks can open the panel on a duplicate click by calling the
 * store, from anywhere, without a tree of providers agreeing about it first.
 *
 * no scrim, on purpose: the panel is something to keep an eye on while working,
 * not a modal to answer. which is also why Escape closes it but nothing traps
 * focus inside it.
 */
export function DownloadsPanel() {
  const t = useT()
  const open = useDownloadsStore((state) => state.panelOpen)
  const setPanelOpen = useDownloadsStore((state) => state.setPanelOpen)
  const highlightedId = useDownloadsStore((state) => state.highlightedId)
  const setHighlighted = useDownloadsStore((state) => state.setHighlighted)
  const clearFinished = useDownloadsStore((state) => state.clearFinished)
  const hydrated = useDownloadsStore((state) => state.hydrated)
  const rows = useDownloadRows()
  const activeCount = useActiveCount()
  const listRef = useRef<HTMLDivElement | null>(null)

  const hasFinished = rows.some((row) => !isLiveRow(row))

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanelOpen(false)
    }

    window.addEventListener("keydown", onKeyDown)

    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, setPanelOpen])

  /**
   * the ring clears itself, and from here rather than from the row
   *
   * the timer has to run whether or not the row it marks is mounted: the panel
   * can be closed a moment after a duplicate click opened it, and a highlight
   * left set would reappear on the next open, pointing at a download that
   * finished half an hour ago.
   */
  useEffect(() => {
    if (!highlightedId) return

    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS)

    return () => clearTimeout(timer)
  }, [highlightedId, setHighlighted])

  /**
   * ...and the row it names is brought to where it can be seen
   *
   * the ring alone is not the answer to "you already asked for this one": the
   * list is newest first and it scrolls, so the download being pointed at is
   * often below the fold, or above it if the user was reading their history.
   * A marker nobody sees expires in two seconds and the duplicate click looks
   * like it did nothing at all.
   *
   * `block: "nearest"` so the list moves as little as it has to, and matched by
   * walking the rows rather than through a selector, which would have to escape
   * an id that came off disk. jsdom implements no scrolling at all, hence the
   * guard: the panel must not throw in a test that only renders it.
   */
  useEffect(() => {
    if (!open || !highlightedId) return

    const node = Array.from(listRef.current?.children ?? []).find(
      (child) => child.getAttribute("data-download-id") === highlightedId
    )

    if (
      node instanceof HTMLElement &&
      typeof node.scrollIntoView === "function"
    ) {
      node.scrollIntoView({ block: "nearest" })
    }
    // the rows deliberately do not appear here: a highlight is only ever set
    // for a row `findLive` just found, so it is on screen in the same commit,
    // and re-running this on every progress event would drag the list back
    // under a user who scrolled away during the two seconds the ring lasts
  }, [open, highlightedId])

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="downloads-panel"
          aria-label={t("downloads.title")}
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ duration: 0.25, ease: "easeInOut" }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-[340px] flex-col",
            // the app's card surface, standing on its edge: the same white-80
            // blur, slate border and shadow `PlaylistHeader` and
            // `VideoDownloadButton` draw, minus the radius a full-height drawer
            // has no use for
            "border-l-2 border-slate-300/50 bg-white/80 backdrop-blur-sm",
            "shadow-2xl shadow-black/10",
            "dark:border-slate-700/50 dark:bg-slate-800/60",
            // the family every card sets on its own container. the panel is
            // mounted in `App` outside the routes, so there is no card above it
            // to inherit from, and the body's `font-sans` resolves to an
            // undefined `--font-sans` and leaves the browser's serif behind
            "font-space-grotesk"
          )}
        >
          <header className="flex-shrink-0 border-b border-slate-300/50 px-4 py-3 dark:border-slate-700/50">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-slate-900 dark:text-white">
                {t("downloads.title")}
              </h2>

              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className={cn(
                  "-mr-1 rounded-lg p-1 text-slate-500 transition-colors duration-200",
                  "hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
                )}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">{t("downloads.close")}</span>
              </button>
            </div>

            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span
                className="text-[11px] leading-4 tabular-nums text-slate-600 dark:text-slate-400"
                style={{ fontFamily: MONO }}
              >
                {activeCount > 0
                  ? t("downloads.active", { n: activeCount })
                  : ""}
              </span>

              <button
                type="button"
                onClick={() => clearFinished()}
                disabled={!hasFinished}
                style={{ fontFamily: MONO }}
                className={cn(
                  "text-[11px] leading-4 text-slate-600 transition-colors duration-200",
                  "hover:text-cyan-700 dark:text-slate-400 dark:hover:text-cyan-300",
                  "disabled:pointer-events-none disabled:opacity-40",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
                )}
              >
                {t("downloads.clearFinished")}
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {rows.length > 0 ? (
              <div ref={listRef} className="flex flex-col gap-2">
                {rows.map((row) => (
                  <DownloadRow
                    key={row.downloadId}
                    row={row}
                    highlighted={row.downloadId === highlightedId}
                  />
                ))}
              </div>
            ) : (
              // nothing is said about an empty list until the one read that
              // could fill it has landed: "no downloads yet" over a history
              // still being read is a sentence that might be wrong
              hydrated && <EmptyState />
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function EmptyState() {
  const t = useT()

  return (
    <div className="px-2 py-8 text-center">
      <p className="text-[13px] font-medium text-slate-900 dark:text-white">
        {t("downloads.emptyTitle")}
      </p>
      <p className="mt-1.5 text-[11px] leading-4 text-slate-600 dark:text-slate-400">
        {t("downloads.emptyBody")}
      </p>
    </div>
  )
}
