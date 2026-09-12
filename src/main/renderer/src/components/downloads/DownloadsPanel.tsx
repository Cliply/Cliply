import { AnimatePresence, motion } from "framer-motion"
import { useEffect, useRef } from "react"

import { useT } from "@/lib/i18n"
import {
  isLiveRow,
  useDownloadRows,
  useDownloadsStore,
  useLifetimeCompleted
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
 * already (the rows, the lifetime count, `panelOpen`, `highlightedId`), so
 * there is no provider and no context - the hooks can open the panel on a
 * duplicate click by calling the store, from anywhere, without a tree of
 * providers agreeing about it first.
 *
 * no scrim, on purpose: the panel is something to keep an eye on while working,
 * not a modal to answer. which is also why nothing traps focus inside it, and
 * why a click outside closes it and still reaches whatever was clicked.
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
  const lifetime = useLifetimeCompleted()
  const listRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)

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
   * a click anywhere else closes it, which is what the close button used to be
   *
   * on `mousedown` rather than `click`, so the panel is out of the way by the
   * time the button or link underneath receives its own event: nothing is
   * swallowed, and the user does not have to dismiss the panel before using
   * what they were reaching for.
   *
   * the toggle is the one exception. It sets `panelOpen` to the opposite of
   * what it reads, so closing here first would leave its click reading a closed
   * panel and opening it again - the panel would refuse to close from the one
   * control whose whole job is closing it. It marks itself with
   * `data-downloads-toggle` (see `DownloadsToggle`) and is left alone.
   */
  useEffect(() => {
    if (!open) return

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target

      if (!(target instanceof Element)) return
      if (panelRef.current?.contains(target)) return
      if (target.closest("[data-downloads-toggle]")) return

      setPanelOpen(false)
    }

    document.addEventListener("mousedown", onMouseDown)

    return () => document.removeEventListener("mousedown", onMouseDown)
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
          ref={panelRef}
          aria-label={t("downloads.title")}
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ duration: 0.25, ease: "easeInOut" }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-[340px] flex-col",
            // the app's card surface, standing on its edge
            "border-l-2 border-slate-300/50 bg-white/80 backdrop-blur-sm",
            "shadow-2xl shadow-black/10",
            "dark:border-slate-700/50 dark:bg-slate-800/60",
            "font-space-grotesk"
          )}
        >
          {/* no border under the header and none anywhere else: the spacing
              separates the three parts, which is the whole of the chrome */}
          <header className="flex flex-shrink-0 items-baseline justify-between gap-3 px-5 pt-5">
            {/* the app's own section label, letter for letter: the same
                spelling `ReportIssueDialog` gives the headings over its fields.
                smaller and quieter than the heading this used to be, which is
                what the second pass asked for */}
            <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {t("downloads.title")}
            </h2>

            <button
              type="button"
              onClick={() => clearFinished()}
              disabled={!hasFinished}
              className={cn(
                "font-mono text-[11px] leading-4 text-slate-500 transition-colors duration-200",
                "hover:text-cyan-700 dark:text-slate-400 dark:hover:text-cyan-300",
                "disabled:pointer-events-none disabled:opacity-40",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
              )}
            >
              {t("downloads.clearHistory")}
            </button>
          </header>

          {/*
            the one number, and what it counts

            it is the lifetime count from `settings.json`, not the length of the
            list below it: clearing the history empties the list and leaves this
            where it was. a fresh install reads zero, which is a true thing to
            say and needs no empty state of its own.
          */}
          <div className="flex-shrink-0 px-5 pb-5 pt-3">
            <p className="font-mono text-[34px] font-medium leading-none tabular-nums text-slate-900 dark:text-white">
              {lifetime}
            </p>
            <p className="mt-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
              {t("downloads.mediaDownloaded", { n: lifetime })}
            </p>
          </div>

          {/* the list takes the rest of the panel, so the empty state has a
              height to sit in the middle of rather than a line to sit at the
              top of */}
          <div className="flex flex-1 flex-col overflow-y-auto px-4 pb-5">
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

/**
 * the middle of the empty list, and nothing else
 *
 * one quiet line, centred in the height the list was given: the number above it
 * already says what this install has downloaded, so this only has to say that
 * there is nothing here to read. no icon, for the same reason there are no
 * divider lines anywhere else in the panel.
 */
function EmptyState() {
  const t = useT()

  return (
    <div className="flex flex-1 items-center justify-center px-1 py-6">
      <p className="text-[13px] text-slate-500 dark:text-slate-400">
        {t("downloads.nothingToShow")}
      </p>
    </div>
  )
}
