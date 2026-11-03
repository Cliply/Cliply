import { useEffect, useMemo, useRef, useState } from "react"
import { GripVertical, ZoomIn, ZoomOut } from "lucide-react"
import type { EditDocument } from "@/lib/stores/editorStore"
import { retainedSections, setEdge } from "@/lib/stores/editorStore"
import { useT } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { formatRulerLabel, visibleRulerTicks } from "./timeline/ruler"
import { MAX_ZOOM, sliderToZoom, zoomToSlider } from "./timeline/zoom"

export const timecode = (seconds: number) => {
  const value = Math.max(0, seconds)
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toFixed(3).padStart(6, "0")}`
}

// Ruler, zoom controls and playhead appearance adapted from OpenCut Classic
// (MIT), cf5e79e919144200294fb9fed22a222592a0aeea, timeline/components/
// timeline-{ruler,tick,toolbar,playhead}.tsx. See third-party/opencut-classic.
// Cliply's source-time editing and LosslessCut transport remain authoritative.
export function CutTimeline({ edit, duration, position, locked, onEdit, onSelect, onSeek }: {
  edit: EditDocument; duration: number; position: number; locked: boolean
  onEdit: (edit: EditDocument) => void; onSelect: (index: number) => void; onSeek: (time: number) => void
}) {
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [viewport, setViewport] = useState({ width: 800, left: 0 })
  const [draft, setDraft] = useState<EditDocument | null>(null)
  const drag = useRef<{ edge: "start" | "end"; base: EditDocument; draft: EditDocument } | null>(null)
  const shown = draft ?? edit
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1
  const fraction = (time: number) => `${Math.max(0, Math.min(safeDuration, time)) / safeDuration * 100}%`
  useEffect(() => {
    const node = scroller.current
    if (!node) return
    const measure = () => setViewport({ width: node.clientWidth || 800, left: node.scrollLeft })
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [])
  useEffect(() => {
    const node = scroller.current
    if (node) {
      node.scrollLeft = position / safeDuration * node.clientWidth * zoom - node.clientWidth / 2
      setViewport({ width: node.clientWidth || 800, left: node.scrollLeft })
    }
    // Center the current playhead only when changing zoom, not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])
  const pixelsPerSecond = viewport.width * zoom / safeDuration
  const ticks = useMemo(() => visibleRulerTicks({ duration: safeDuration, pixelsPerSecond, scrollLeft: viewport.left, viewportWidth: viewport.width }), [safeDuration, pixelsPerSecond, viewport.left, viewport.width])
  const pointerTime = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    return rect?.width ? Math.max(0, Math.min(duration, (clientX - rect.left) / rect.width * duration)) : 0
  }
  return <section aria-label={t("media.timeline")} className="flex min-h-[180px] flex-1 flex-col">
    <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b border-border px-3 text-[11px] text-muted-foreground">
      <span className="min-w-0 truncate" title={t("media.timelineHint")}>{t("media.timelineHint")}</span>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={t("media.zoomOut")} aria-label={t("media.zoomOut")} disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value / 2))}><ZoomOut className="size-3.5" /></Button>
        <input type="range" aria-label={t("media.zoom")} min={0} max={1} step={0.01} value={zoomToSlider(zoom)} onChange={event => setZoom(sliderToZoom(Number(event.target.value)))} className="h-1 w-16 cursor-pointer accent-primary" />
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={t("media.zoomIn")} aria-label={t("media.zoomIn")} disabled={zoom >= MAX_ZOOM} onClick={() => setZoom(value => Math.min(MAX_ZOOM, value * 2))}><ZoomIn className="size-3.5" /></Button>
        <span className="w-8 text-right font-mono tabular-nums">{Number(zoom.toFixed(1))}×</span>
      </div>
    </div>
    <div ref={scroller} onScroll={event => setViewport({ width: event.currentTarget.clientWidth || 800, left: event.currentTarget.scrollLeft })} className="min-h-36 flex-1 overflow-x-auto overflow-y-hidden bg-muted/20">
      <div ref={track} data-testid="cut-timeline" className="relative h-full min-h-36 touch-none select-none" style={{ width: `${zoom * 100}%` }}
        onPointerDown={event => {
          if (locked || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          const edge = (event.target as HTMLElement).closest<HTMLElement>("[data-edge]")?.dataset.edge as "start" | "end" | undefined
          if (edge) drag.current = { edge, base: edit, draft: edit }
          else {
            const section = (event.target as HTMLElement).closest<HTMLElement>("[data-section]")
            if (section) onSelect(Number(section.dataset.section))
            onSeek(pointerTime(event.clientX))
          }
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
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-7 border-b border-border bg-background/70">
          {ticks.map(({ time, showLabel }) => showLabel ? <span key={time} className="absolute top-1.5 pl-1 font-mono text-[10px] leading-none text-muted-foreground" style={{ left: fraction(time) }}>{formatRulerLabel(time)}</span> :
            <div key={time} className="absolute top-2 h-1.5 border-l border-muted-foreground/30" style={{ left: fraction(time) }} />)}
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-10 h-14 border-y border-border/60 bg-muted/40" />
        {shown.ranges.map((range, index) => <button key={index} data-section={index} type="button" disabled={locked} aria-pressed={index === shown.active}
          aria-label={t("media.section", { number: index + 1 })} onClick={() => onSelect(index)}
          className={`absolute top-10 h-14 overflow-hidden rounded-sm border text-left text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${shown.intent === "keep" ? "border-primary/50 bg-primary/15 text-foreground" : "border-rose-500/60 bg-rose-500/15 text-foreground"} ${index === shown.active ? "ring-1 ring-inset ring-primary" : "opacity-70"}`}
          style={{ left: fraction(range.start), width: fraction(range.end - range.start), minWidth: 4 }}><span className="px-4">{t("media.section", { number: index + 1 })}</span><span className="absolute bottom-2 left-4 whitespace-nowrap font-mono text-[10px] font-normal text-muted-foreground">{timecode(range.end - range.start)}</span></button>)}
        {shown.ranges[shown.active] && (["start", "end"] as const).map(edge => <div key={edge} role="slider" tabIndex={locked ? -1 : 0} data-edge={edge}
          aria-label={t(edge === "start" ? "media.trimStart" : "media.trimEnd")} aria-disabled={locked}
          aria-valuemin={0} aria-valuemax={duration} aria-valuenow={shown.ranges[shown.active][edge]} aria-valuetext={timecode(shown.ranges[shown.active][edge])}
          onKeyDown={event => {
            if (locked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
            event.preventDefault(); event.stopPropagation()
            const time = event.key === "Home" ? 0 : event.key === "End" ? duration : shown.ranges[shown.active][edge] + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : 0.1)
            onEdit(setEdge(edit, edge, time, duration))
          }}
          className={`absolute top-10 z-20 flex h-14 w-3 cursor-ew-resize items-center justify-center bg-primary text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${edge === "end" ? "-translate-x-full rounded-r-sm" : "rounded-l-sm"}`}
          style={{ left: fraction(shown.ranges[shown.active][edge]) }}><GripVertical className="pointer-events-none size-3" /></div>)}
        {retainedSections(shown, duration).map((range, index) => <div key={index} className="pointer-events-none absolute top-28 h-2 rounded-sm bg-emerald-600/80 dark:bg-emerald-400/80" style={{ left: fraction(range.start), width: fraction(range.end - range.start) }} />)}
        <div aria-hidden="true" className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-primary" style={{ left: fraction(position) }}><span className="absolute left-1/2 top-1 size-2.5 -translate-x-1/2 rounded-full border-2 border-primary bg-background" /></div>
      </div>
    </div>
    <input aria-label={t("media.seekTime", { time: timecode(position) })} type="range" min={0} max={duration} step={0.001} value={position} disabled={locked} onChange={event => onSeek(Number(event.target.value))} className="sr-only focus:not-sr-only focus:w-full" />
  </section>
}
