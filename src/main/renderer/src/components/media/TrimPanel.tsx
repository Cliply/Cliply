import { useEffect, useRef, useState, type RefObject } from "react"
import { Scissors, Undo2, Redo2, Plus, Play, Pause, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT, type Key } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import type { MediaSource } from "@/lib/local-media-types"
import { useLocalMedia } from "@/lib/stores/localMediaStore"
import { exportActive, localExportActions, localTrimActions, useLocalExport } from "@/lib/stores/localExportStore"
import { useEditor, editorActions, initialEdit, retainedSections, setEdge, splitSection, addSection, deleteSection, type EditDocument } from "@/lib/stores/editorStore"
import { CutTimeline, timecode } from "./CutTimeline"

export const cutSeconds = (value: string) => /^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null

export function TrimPanel({ source, busy, player }: { source: MediaSource; busy: boolean; player: RefObject<HTMLMediaElement | null> }) {
  const t = useT()
  const snapshot = useLocalExport(s => s.snapshot), pending = useLocalExport(s => s.pending)
  const timingPending = useLocalExport(s => s.timingPending), storedTiming = useLocalExport(s => s.trimTiming)
  const position = useLocalMedia(s => s.position)
  const state = useEditor()
  const duration = source.duration ?? 0
  const edit = state.sourceId === source.sourceId ? state.document : initialEdit(duration)
  const [previewing, setPreviewing] = useState(false)
  const previewIndex = useRef(0)
  const retained = retainedSections(edit, duration)
  const valid = retained.length > 0 && retained.length <= 32 && retained.every(range => range.end - range.start >= 0.1 - 1e-9)
  const locked = busy || pending || timingPending || exportActive(snapshot)
  const timing = storedTiming?.sourceId === source.sourceId && storedTiming.intent === edit.intent && storedTiming.mode === edit.mode &&
    JSON.stringify(storedTiming.ranges) === JSON.stringify(edit.ranges) && storedTiming.expiresAt > Date.now() ? storedTiming : null
  const plan = snapshot.plan?.operation === "trim" && snapshot.plan.trimPlanId === timing?.trimPlanId ? snapshot.plan : null
  const range = edit.ranges[edit.active]
  const currentTime = () => player.current?.currentTime ?? position
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
      if (locked || event.altKey || event.repeat || target?.isContentEditable || target?.closest("input,textarea,select,button,video,audio,[role=slider],[contenteditable]")) return
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault(); setPreviewing(false); localTrimActions.reset()
        if (event.shiftKey) editorActions.redo(); else editorActions.undo()
      } else if (!event.metaKey && !event.ctrlKey && ["i", "o", "b", "delete", "backspace", " ", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault()
        if (key === "i" || key === "o") mark(key === "i" ? "start" : "end")
        else if (key === "b") commit(splitSection(edit, currentTime()))
        else if (["delete", "backspace"].includes(key)) commit(deleteSection(edit))
        else if (key === " ") togglePlay()
        else seek(currentTime() + (key === "arrowleft" ? -1 : 1) * (event.shiftKey ? 1 : 5))
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  })
  useEffect(() => () => { if (useLocalExport.getState().timingPending) void localTrimActions.cancel() }, [])
  const reason = `media.error.${source.capabilities?.trim?.reason}`
  return <section id="trim-panel" aria-label={t("media.trim")} className="space-y-4 rounded-2xl border border-slate-300/60 bg-white/80 p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/70">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Scissors className="size-4" /><h2 className="font-medium">{t("media.editVideo")}</h2><span className="font-mono text-sm tabular-nums text-slate-500 dark:text-slate-400">{timecode(position)}</span></div>
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" aria-label={t("media.undo")} disabled={locked || !state.past.length} onClick={() => { setPreviewing(false); localTrimActions.reset(); editorActions.undo() }}><Undo2 /></Button>
        <Button size="sm" variant="ghost" aria-label={t("media.redo")} disabled={locked || !state.future.length} onClick={() => { setPreviewing(false); localTrimActions.reset(); editorActions.redo() }}><Redo2 /></Button>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" aria-label={t("media.playPause")} disabled={locked} onClick={togglePlay}><Play className="size-4" /> / <Pause className="size-4" /></Button>
      <Button size="sm" variant="outline" disabled={locked || !range} onClick={() => mark("start")}>I · {t("media.setStart")}</Button>
      <Button size="sm" variant="outline" disabled={locked || !range} onClick={() => mark("end")}>O · {t("media.setEnd")}</Button>
      <Button size="sm" variant="outline" disabled={locked || splitSection(edit, currentTime()) === edit} onClick={() => commit(splitSection(edit, currentTime()))}><Scissors />{t("media.split")}</Button>
      <Button size="sm" variant="outline" disabled={locked || addSection(edit, currentTime(), duration) === edit} onClick={() => commit(addSection(edit, currentTime(), duration))}><Plus />{t("media.addSection")}</Button>
      <select aria-label={t("media.editMode")} value={edit.intent} disabled={locked} onChange={event => commit({ ...edit, intent: event.target.value as "keep" | "remove" })} className="ml-auto rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
        <option value="keep">{t("media.keepMarked")}</option><option value="remove">{t("media.removeMarked")}</option>
      </select>
    </div>
    {duration > 0 && <CutTimeline key={source.sourceId} edit={edit} duration={duration} position={position} locked={locked} onEdit={commit} onSelect={editorActions.select} onSeek={seek} />}
    <div className="flex flex-wrap items-center gap-2">
      {edit.ranges.map((section, index) => <div key={index} className={`flex items-center rounded-lg border ${index === edit.active ? "border-teal-600 bg-teal-50 dark:bg-teal-950" : "border-slate-300 dark:border-slate-600"}`}>
        <button disabled={locked} type="button" aria-pressed={index === edit.active} className="px-3 py-2 text-xs tabular-nums" onClick={() => { editorActions.select(index); seek(section.start) }}>{index + 1} · {timecode(section.start)} – {timecode(section.end)}</button>
        <button disabled={locked} type="button" className="p-2" aria-label={t("media.deleteMark", { number: index + 1 })} onClick={() => commit(deleteSection({ ...edit, active: index }))}><Trash2 className="size-3.5" /></button>
      </div>)}
    </div>
    <p className="text-xs text-slate-500 dark:text-slate-400">{t(edit.intent === "keep" ? "media.keepMeaning" : "media.removeMeaning")}</p>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button variant="outline" size="sm" disabled={locked || !valid} onClick={() => {
        const media = player.current
        if (previewing) { setPreviewing(false); media?.pause(); return }
        if (media && Number.isFinite(media.duration)) {
          previewIndex.current = 0; media.currentTime = retained[0].start; setPreviewing(true)
          void media.play().catch(() => setPreviewing(false))
        }
      }}>{previewing ? <Pause /> : <Play />}{t(previewing ? "media.stopPreview" : "media.previewEdit")}</Button>
      <span className="text-sm">{t("media.outputSummary", { count: retained.length, time: timecode(retained.reduce((sum, part) => sum + part.end - part.start, 0)) })}</span>
    </div>
    <details className="text-xs text-slate-500 dark:text-slate-400"><summary className="cursor-pointer">{t("media.preciseControls")}</summary>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {range && (["start", "end"] as const).map(edge => <label key={edge} className="space-y-1">{t(edge === "start" ? "media.trimStart" : "media.trimEnd")}
          <input id={`trim-${edge}`} type="number" step="0.1" min={0} max={duration} value={Number(range[edge].toFixed(6))} disabled={locked}
            onChange={event => { const value = cutSeconds(event.target.value); if (value !== null) commit(setEdge(edit, edge, value, duration)) }} className="block w-32 rounded border border-slate-300 bg-white p-2 text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white" /></label>)}
        <label>{t("media.keyframeDirection")}<select id="trim-keyframe" value={edit.mode} disabled={locked} onChange={event => commit({ ...edit, mode: event.target.value as "before" | "after" })} className="ml-2 rounded border bg-white p-2 dark:border-slate-600 dark:bg-slate-900">
          <option value="before">{t("media.keyframeBefore")}</option><option value="after">{t("media.keyframeAfter")}</option>
        </select></label>
      </div>
      <p className="mt-2">{t("media.editorShortcuts")}</p>
    </details>
    {!source.trimProfile && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{reason in en ? t(reason as Key) : t("media.error.TRIM_PROFILE")}</p>}
    {!valid && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{t("media.emptyEdit")}</p>}
    {timingPending ? <Button variant="outline" onClick={() => void localTrimActions.cancel()}>{t("media.cancelTiming")}</Button> :
      <Button disabled={locked || !valid || !source.trimProfile} onClick={() => { setPreviewing(false); void localTrimActions.inspect({ sourceId: source.sourceId, ranges: edit.ranges, intent: edit.intent, mode: edit.mode }) }}>{t("media.reviewCut")}</Button>}
    {timing && <div className="space-y-3 rounded-xl border border-teal-500/40 bg-teal-50/50 p-4 dark:bg-teal-950/20">
      <p className="text-sm">{t("media.fastCutNote")}</p>
      <ol className="space-y-1 text-sm tabular-nums">{(timing.cuts ?? [timing]).map((cut, index) => <li key={index}>{index + 1}. {t("media.plannedCut", { start: cut.plannedStart.toFixed(3), end: cut.plannedEnd.toFixed(3) })}</li>)}</ol>
      <Button variant="outline" disabled={locked} onClick={() => void localExportActions.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })}>{t("media.chooseDestination")}</Button>
      {plan && <><p className="break-all text-sm">{t("media.saveAs", { name: plan.outputName })}</p><Button disabled={locked} onClick={() => void localExportActions.start(plan.planId)}>{t("media.exportEdit")}</Button></>}
    </div>}
  </section>
}
