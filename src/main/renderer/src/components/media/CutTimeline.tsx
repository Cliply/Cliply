import { useEffect, useRef, useState } from "react"
import type { EditDocument } from "@/lib/stores/editorStore"
import { retainedSections, setEdge } from "@/lib/stores/editorStore"
import { useT } from "@/lib/i18n"
import { Button } from "@/components/ui/button"

export const timecode = (seconds: number) => {
  const value = Math.max(0, seconds)
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toFixed(3).padStart(6, "0")}`
}
export function CutTimeline({ edit, duration, position, locked, onEdit, onSelect, onSeek }: {
  edit: EditDocument; duration: number; position: number; locked: boolean
  onEdit: (edit: EditDocument) => void; onSelect: (index: number) => void; onSeek: (time: number) => void
}) {
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [draft, setDraft] = useState<EditDocument | null>(null)
  const drag = useRef<{ edge: "start" | "end"; base: EditDocument; draft: EditDocument } | null>(null)
  const shown = draft ?? edit
  const fraction = (time: number) => `${time / duration * 100}%`
  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollLeft = position / duration * node.clientWidth * zoom - node.clientWidth / 2
    // Center the current playhead only when changing zoom, not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])
  const pointerTime = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    return rect?.width ? Math.max(0, Math.min(duration, (clientX - rect.left) / rect.width * duration)) : 0
  }
  return <section aria-label={t("media.timeline")} className="space-y-2">
    <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>{t("media.timelineHint")}</span>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" aria-label={t("media.zoomOut")} disabled={zoom === 1} onClick={() => setZoom(value => value / 2)}>−</Button>
        <span>{zoom}×</span>
        <Button size="sm" variant="outline" aria-label={t("media.zoomIn")} disabled={zoom === 64} onClick={() => setZoom(value => value * 2)}>+</Button>
      </div>
    </div>
    <div ref={scroller} className="overflow-x-auto rounded-xl border border-slate-300 bg-slate-100 dark:border-slate-600 dark:bg-slate-900">
      <div ref={track} data-testid="cut-timeline" className="relative h-32 touch-none select-none" style={{ width: `${zoom * 100}%` }}
        onPointerDown={event => {
          if (locked || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          const edge = (event.target as HTMLElement).dataset.edge as "start" | "end" | undefined
          if (edge) drag.current = { edge, base: edit, draft: edit }
          else onSeek(pointerTime(event.clientX))
        }}
        onPointerMove={event => {
          if (locked || !event.currentTarget.hasPointerCapture(event.pointerId)) return
          const time = pointerTime(event.clientX)
          if (drag.current) {
            const next = setEdge(drag.current.base, drag.current.edge, time, duration)
            drag.current.draft = next; setDraft(next)
          }
          onSeek(time)
        }}
        onPointerUp={event => {
          if (drag.current && !locked) onEdit(drag.current.draft)
          drag.current = null; setDraft(null)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => { drag.current = null; setDraft(null) }}>
        {Array.from({ length: Math.min(65, 8 * zoom) + 1 }, (_, i) => {
          const time = duration * i / Math.min(65, 8 * zoom)
          return <div key={i} className="pointer-events-none absolute top-0 h-full border-l border-slate-300/60 text-[10px] text-slate-500 dark:border-slate-700 dark:text-slate-400" style={{ left: fraction(time) }}>
            <span className="ml-1">{timecode(time)}</span>
          </div>
        })}
        {shown.ranges.map((range, index) => <button key={index} type="button" disabled={locked} aria-pressed={index === shown.active}
          aria-label={t("media.section", { number: index + 1 })} onClick={() => onSelect(index)}
          className={`absolute top-9 h-12 overflow-hidden rounded border-2 text-left text-xs font-medium ${shown.intent === "keep" ? "border-teal-600 bg-teal-500/35 dark:border-teal-400" : "border-rose-600 bg-rose-500/30 dark:border-rose-400"} ${index === shown.active ? "ring-2 ring-slate-900 ring-offset-2 dark:ring-white dark:ring-offset-slate-900" : "opacity-65"}`}
          style={{ left: fraction(range.start), width: fraction(range.end - range.start), minWidth: 4 }}><span className="px-4">{index + 1}</span></button>)}
        {shown.ranges[shown.active] && (["start", "end"] as const).map(edge => <div key={edge} role="slider" tabIndex={locked ? -1 : 0} data-edge={edge}
          aria-label={t(edge === "start" ? "media.trimStart" : "media.trimEnd")} aria-disabled={locked}
          aria-valuemin={0} aria-valuemax={duration} aria-valuenow={shown.ranges[shown.active][edge]} aria-valuetext={timecode(shown.ranges[shown.active][edge])}
          onKeyDown={event => {
            if (locked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
            event.preventDefault(); event.stopPropagation()
            const time = event.key === "Home" ? 0 : event.key === "End" ? duration : shown.ranges[shown.active][edge] + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : 0.1)
            onEdit(setEdge(edit, edge, time, duration))
          }}
          className="absolute top-8 z-20 flex h-14 w-4 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded bg-slate-800 text-white shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:bg-slate-100 dark:text-slate-900"
          style={{ left: fraction(shown.ranges[shown.active][edge]) }}>⋮</div>)}
        {retainedSections(shown, duration).map((range, index) => <div key={index} className="pointer-events-none absolute bottom-3 h-2 rounded bg-teal-600 dark:bg-teal-400" style={{ left: fraction(range.start), width: fraction(range.end - range.start) }} />)}
        <div className="pointer-events-none absolute bottom-0 top-5 z-10 w-0.5 bg-amber-500" style={{ left: fraction(position) }}><span className="absolute -left-1.5 -top-1 text-amber-500">▼</span></div>
      </div>
    </div>
    <input aria-label={t("media.seekTime", { time: timecode(position) })} type="range" min={0} max={duration} step={0.001} value={position} disabled={locked} onChange={event => onSeek(Number(event.target.value))} className="sr-only focus:not-sr-only focus:w-full" />
  </section>
}
