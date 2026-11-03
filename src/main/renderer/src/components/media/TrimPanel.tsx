import { useEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { Scissors, Undo2, Redo2, Plus, Play, Pause, Trash2, ArrowDownToLine } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT, type Key } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import type { MediaSource } from "@/lib/local-media-types"
import { useLocalMedia } from "@/lib/stores/localMediaStore"
import { exportActive, localExportActions, localTrimActions, useLocalExport } from "@/lib/stores/localExportStore"
import { useEditor, editorActions, initialEdit, retainedSections, setEdge, splitSection, addSection, deleteSection, type EditDocument } from "@/lib/stores/editorStore"
import { CutTimeline, timecode } from "./CutTimeline"

export const cutSeconds = (value: string) => /^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null

export function TrimPanel({ source, busy, player, inspectorTarget }: { source: MediaSource; busy: boolean; player: RefObject<HTMLMediaElement | null>; inspectorTarget?: HTMLElement | null }) {
  const t = useT()
  const snapshot = useLocalExport(s => s.snapshot), pending = useLocalExport(s => s.pending)
  const timingPending = useLocalExport(s => s.timingPending), storedTiming = useLocalExport(s => s.trimTiming)
  const position = useLocalMedia(s => s.position)
  const state = useEditor()
  const duration = source.duration ?? 0
  const edit = state.sourceId === source.sourceId ? state.document : initialEdit(duration)
  const [previewing, setPreviewing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const previewIndex = useRef(0)
  const retained = retainedSections(edit, duration)
  const valid = retained.length > 0 && retained.length <= 32 && retained.every(range => range.end - range.start >= 0.1 - 1e-9)
  const locked = busy || pending || timingPending || exportActive(snapshot)
  const timing = storedTiming?.sourceId === source.sourceId && storedTiming.intent === edit.intent && storedTiming.mode === edit.mode &&
    JSON.stringify(storedTiming.ranges) === JSON.stringify(edit.ranges) && storedTiming.expiresAt > Date.now() ? storedTiming : null
  const plan = snapshot.plan?.operation === "trim" && snapshot.plan.trimPlanId === timing?.trimPlanId ? snapshot.plan : null
  const range = edit.ranges[edit.active]
  const currentTime = () => player.current && player.current.readyState > 0 ? player.current.currentTime : position
  const seek = (time: number) => {
    if (locked) return
    setPreviewing(false)
    const target = Math.max(0, Math.min(duration, time))
    if (player.current && Number.isFinite(player.current.duration)) player.current.currentTime = target
    useLocalMedia.setState({ position: target })
  }
  const commit = (next: EditDocument) => { if (!locked) { setPreviewing(false); editorActions.commit(next); localTrimActions.reset() } }
  const mark = (edge: "start" | "end") => commit(setEdge(edit, edge, currentTime(), duration))
  const togglePlay = () => {
    const media = player.current
    if (!media) return
    setPreviewing(false)
    if (media.paused) void media.play().catch(() => {})
    else media.pause()
  }
  useEffect(() => { editorActions.open(source.sourceId, duration) }, [source.sourceId, duration])
  useEffect(() => {
    const media = player.current
    if (!media) return
    const update = () => setPlaying(!media.paused && !media.ended)
    update()
    media.addEventListener("play", update)
    media.addEventListener("pause", update)
    media.addEventListener("ended", update)
    media.addEventListener("emptied", update)
    return () => {
      media.removeEventListener("play", update)
      media.removeEventListener("pause", update)
      media.removeEventListener("ended", update)
      media.removeEventListener("emptied", update)
    }
  }, [player, source.sourceId])
  useEffect(() => {
    if (!previewing || locked) return
    const media = player.current
    if (!media) return
    let frame = 0
    const tick = () => {
      const section = retained[previewIndex.current]
      if (!section) { media.pause(); setPreviewing(false); return }
      if (!media.seeking && media.currentTime >= section.end) {
        previewIndex.current += 1
        const next = retained[previewIndex.current]
        if (!next) { media.pause(); setPreviewing(false); return }
        media.currentTime = next.start
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); media.pause() }
    // Edits stop preview through commit; position updates must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewing, locked, source.sourceId])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (event.defaultPrevented || locked || event.altKey || event.repeat || target?.isContentEditable || target?.closest("input,textarea,select,video,audio,[role=slider],[role=separator],[contenteditable]")) return
      const key = event.key.toLowerCase()
      if (key === " " && target?.closest("button")) return
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault(); setPreviewing(false); localTrimActions.reset()
        if (event.shiftKey) editorActions.redo(); else editorActions.undo()
      } else if (!event.metaKey && !event.ctrlKey && ["i", "o", "b", "delete", "backspace", " ", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault()
        if (key === "i" || key === "o") mark(key === "i" ? "start" : "end")
        else if (key === "b") commit(splitSection(edit, currentTime()))
        else if (["delete", "backspace"].includes(key)) commit(deleteSection(edit))
        else if (key === " ") togglePlay()
        else if (event.shiftKey && range) seek(key === "arrowleft" ? range.start : range.end)
        else seek(currentTime() + (key === "arrowleft" ? -1 : 1))
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  })
  useEffect(() => () => { if (useLocalExport.getState().timingPending) void localTrimActions.cancel() }, [])
  const reason = `media.error.${source.capabilities?.trim?.reason}`
  const inspector = <div className="flex min-w-0 flex-col gap-5" data-testid="cut-inspector">
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2"><h2 className="text-xs font-semibold">{t("media.editVideo")}</h2><Scissors className="size-3.5 text-muted-foreground" aria-hidden="true" /></div>
      <select aria-label={t("media.editMode")} value={edit.intent} disabled={locked} onChange={event => commit({ ...edit, intent: event.target.value as "keep" | "remove" })} className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <option value="keep">{t("media.keepMarked")}</option><option value="remove">{t("media.removeMarked")}</option>
      </select>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t(edit.intent === "keep" ? "media.keepMeaning" : "media.removeMeaning")}</p>
      <div className="max-h-52 space-y-1 overflow-y-auto">
        {edit.ranges.map((section, index) => <div key={index} className={`flex min-w-0 items-center rounded-md border ${index === edit.active ? "border-primary/40 bg-primary/10" : "border-transparent bg-muted/40"}`}>
          <button disabled={locked} type="button" aria-pressed={index === edit.active} className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-2.5 text-left text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => { editorActions.select(index); seek(section.start) }}>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-background text-[10px] text-muted-foreground">{index + 1}</span><span className="min-w-0 truncate font-mono">{timecode(section.start)} – {timecode(section.end)}</span>
          </button>
          <button disabled={locked} type="button" className="mr-1 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={t("media.deleteMark", { number: index + 1 })} title={t("media.deleteMark", { number: index + 1 })} onClick={() => commit(deleteSection({ ...edit, active: index }))}><Trash2 className="size-3.5" /></button>
        </div>)}
      </div>
    </div>
    <details className="border-t border-border pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer select-none text-[11px]">{t("media.preciseControls")}</summary>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {range && (["start", "end"] as const).map(edge => <label key={edge} className="min-w-0 space-y-1 text-[11px]">{t(edge === "start" ? "media.trimStart" : "media.trimEnd")}
          <input id={`trim-${edge}`} type="number" step="0.1" min={0} max={duration} value={Number(range[edge].toFixed(6))} disabled={locked}
            onChange={event => { const value = cutSeconds(event.target.value); if (value !== null) commit(setEdge(edit, edge, value, duration)) }} className="block h-8 w-full min-w-0 rounded border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary" /></label>)}
        <label className="col-span-2 space-y-1 text-[11px]">{t("media.keyframeDirection")}<select id="trim-keyframe" value={edit.mode} disabled={locked} onChange={event => commit({ ...edit, mode: event.target.value as "before" | "after" })} className="block h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <option value="before">{t("media.keyframeBefore")}</option><option value="after">{t("media.keyframeAfter")}</option>
        </select></label>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed">{t("media.editorShortcuts")}</p>
    </details>
    <div className="space-y-3 border-t border-border pt-4">
      {!source.trimProfile && <p role="alert" className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{reason in en ? t(reason as Key) : t("media.error.TRIM_PROFILE")}</p>}
      {!valid && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{t("media.emptyEdit")}</p>}
      {timingPending ? <Button className="h-auto min-h-8 w-full whitespace-normal px-2 py-2 text-xs" variant="outline" onClick={() => void localTrimActions.cancel()}>{t("media.cancelTiming")}</Button> :
        <Button className="h-auto min-h-8 w-full whitespace-normal px-2 py-2 text-xs" disabled={locked || !valid || !source.trimProfile} onClick={() => { setPreviewing(false); void localTrimActions.inspect({ sourceId: source.sourceId, ranges: edit.ranges, intent: edit.intent, mode: edit.mode }) }}><ArrowDownToLine className="size-3.5" />{t("media.reviewCut")}</Button>}
      {timing && <div className="space-y-3 rounded-md border border-primary/25 bg-primary/5 p-3">
        <p className="text-xs font-medium leading-relaxed">{t("media.editFormat", { format: timing.extension.toUpperCase() })}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("media.fastCutNote")}</p>
        <ol className="max-h-40 space-y-1 overflow-y-auto text-[11px] tabular-nums">{(timing.cuts ?? [timing]).map((cut, index) => <li key={index}>{index + 1}. {t("media.plannedCut", { start: cut.plannedStart.toFixed(3), end: cut.plannedEnd.toFixed(3) })}</li>)}</ol>
        <Button className="h-auto min-h-8 w-full whitespace-normal px-2 text-xs" variant="outline" disabled={locked} onClick={() => void localExportActions.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })}>{t("media.chooseDestination")}</Button>
        {plan && <><p className="break-all text-[11px] text-muted-foreground">{t("media.saveAs", { name: plan.outputName })}</p><Button className="h-auto min-h-8 w-full whitespace-normal px-2 py-2 text-xs" disabled={locked} onClick={() => void localExportActions.start(plan.planId)}>{t("media.exportEdit")}</Button></>}
      </div>}
    </div>
  </div>
  return <section id="trim-panel" aria-label={t("media.trim")} className="flex h-full min-h-0 flex-col bg-background">
    {/* Compact, grouped toolbar follows OpenCut Classic timeline-toolbar.tsx;
        actions continue to use the existing Cliply/LosslessCut edit document. */}
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5">
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={t("media.playPause")} aria-label={t("media.playPause")} disabled={locked} onClick={togglePlay}>{playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</Button>
      <span aria-hidden="true" className="mx-1 h-4 border-l border-border" />
      <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[11px]" title={`I · ${t("media.setStart")}`} aria-label={t("media.setStart")} disabled={locked || !range} onClick={() => mark("start")}><span className="font-mono text-primary">[ I</span><span className="editor-mark-label">{t("media.setStart")}</span></Button>
      <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[11px]" title={`O · ${t("media.setEnd")}`} aria-label={t("media.setEnd")} disabled={locked || !range} onClick={() => mark("end")}><span className="editor-mark-label">{t("media.setEnd")}</span><span className="font-mono text-primary">O ]</span></Button>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={`B · ${t("media.split")}`} aria-label={t("media.split")} disabled={locked || splitSection(edit, currentTime()) === edit} onClick={() => commit(splitSection(edit, currentTime()))}><Scissors className="size-3.5" /></Button>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={t("media.addSection")} aria-label={t("media.addSection")} disabled={locked || addSection(edit, currentTime(), duration) === edit} onClick={() => commit(addSection(edit, currentTime(), duration))}><Plus className="size-3.5" /></Button>
      <span aria-hidden="true" className="mx-1 h-4 border-l border-border" />
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={t("media.undo")} aria-label={t("media.undo")} disabled={locked || !state.past.length} onClick={() => { setPreviewing(false); localTrimActions.reset(); editorActions.undo() }}><Undo2 className="size-3.5" /></Button>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={t("media.redo")} aria-label={t("media.redo")} disabled={locked || !state.future.length} onClick={() => { setPreviewing(false); localTrimActions.reset(); editorActions.redo() }}><Redo2 className="size-3.5" /></Button>
      <span className="ml-auto px-1 font-mono text-[11px] tabular-nums text-muted-foreground">{timecode(position)}</span>
    </div>
    {duration > 0 && <CutTimeline key={source.sourceId} edit={edit} duration={duration} position={position} locked={locked} onEdit={commit} onSelect={editorActions.select} onSeek={seek} />}
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-2 py-1">
      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" aria-label={t(previewing ? "media.stopPreview" : "media.previewEdit")} title={t(previewing ? "media.stopPreview" : "media.previewEdit")} disabled={locked || !valid} onClick={() => {
        const media = player.current
        if (previewing) { setPreviewing(false); media?.pause(); return }
        if (media && Number.isFinite(media.duration)) {
          previewIndex.current = 0; media.currentTime = retained[0].start; setPreviewing(true)
          void media.play().catch(() => setPreviewing(false))
        }
      }}>{previewing ? <Pause className="size-3" /> : <Play className="size-3" />}<span className="editor-preview-label">{t(previewing ? "media.stopPreview" : "media.previewEdit")}</span><span className="editor-preview-short-label">{t(previewing ? "media.stopPreviewShort" : "media.previewShort")}</span></Button>
      <span className="px-1 text-[10px] tabular-nums text-muted-foreground">{t("media.outputSummary", { count: retained.length, time: timecode(retained.reduce((sum, part) => sum + part.end - part.start, 0)) })}</span>
    </div>
    {inspectorTarget ? createPortal(inspector, inspectorTarget) : <div className="border-t border-border p-3">{inspector}</div>}
  </section>
}
