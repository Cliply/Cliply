import { useEffect, type RefObject } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useT, type Key } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import type { MediaSource } from "@/lib/local-media-types"
import { useLocalMedia } from "@/lib/stores/localMediaStore"
import { exportActive, localExportActions, localTrimActions, useLocalExport } from "@/lib/stores/localExportStore"

export const cutSeconds = (value: string) => /^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null
const display = (seconds: number) => seconds.toFixed(3)

export function TrimPanel({ source, busy, player }: { source: MediaSource; busy: boolean; player: RefObject<HTMLMediaElement | null> }) {
  const t = useT()
  const snapshot = useLocalExport(s => s.snapshot)
  const pending = useLocalExport(s => s.pending)
  const timingPending = useLocalExport(s => s.timingPending)
  const stored = useLocalExport(s => s.trimSelection)
  const storedTiming = useLocalExport(s => s.trimTiming)
  const previewId = useLocalMedia(s => s.auditionPreviewId)
  const position = useLocalMedia(s => s.position)
  const selection = stored?.sourceId === source.sourceId ? stored : { sourceId: source.sourceId, start: "0", end: (source.duration ?? 0).toFixed(6), mode: "before" as const }
  const start = cutSeconds(selection.start), end = cutSeconds(selection.end)
  const valid = start !== null && end !== null && start >= 0 && end <= (source.duration ?? 0) && end - start >= 0.1 - 1e-9
  const locked = busy || pending || timingPending || exportActive(snapshot)
  const timing = storedTiming?.sourceId === source.sourceId && storedTiming.previewId === previewId && storedTiming.requestedStart === start &&
    storedTiming.requestedEnd === end && storedTiming.mode === selection.mode && storedTiming.expiresAt > Date.now() ? storedTiming : null
  const plan = snapshot.plan?.operation === "trim" && snapshot.plan.trimPlanId === timing?.trimPlanId ? snapshot.plan : null
  const setSelection = (values: Partial<typeof selection>) => useLocalExport.setState({ trimSelection: { ...selection, ...values } })
  const setFromPlayer = (edge: "start" | "end") => {
    if (locked || !previewId || !player.current) return
    const value = Math.max(0, Math.min(source.duration ?? 0, player.current.currentTime))
    if (Number.isFinite(value)) setSelection({ [edge]: value.toFixed(6) })
  }
  const seek = (seconds: number) => {
    if (!locked && previewId && player.current) player.current.currentTime = Math.max(0, Math.min(source.duration ?? 0, seconds))
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || target?.isContentEditable || target?.closest("input,textarea,select,button,video,audio,[contenteditable]")) return
      const key = event.key.toLowerCase()
      if (!locked && previewId && ["i", "o", "arrowleft", "arrowright"].includes(key)) {
        event.preventDefault()
        if (key === "i" || key === "o") setFromPlayer(key === "i" ? "start" : "end")
        else seek((player.current?.currentTime ?? position) + (key === "arrowleft" ? -5 : 5))
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  })
  useEffect(() => () => { if (useLocalExport.getState().timingPending) void localTrimActions.cancel() }, [])
  useEffect(() => {
    if (!storedTiming) return
    const timer = setTimeout(() => useLocalExport.setState({ trimTiming: null }), Math.max(0, storedTiming.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [storedTiming])
  const reason = source.capabilities?.trim?.reason
  const unsupportedKey = reason && Object.hasOwn(en, `media.error.${reason}`) ? `media.error.${reason}` as Key : "media.error.TRIM_PROFILE"
  return <Card id="trim-panel" className="border-slate-300/50 bg-white/80 dark:border-slate-700/50 dark:bg-slate-800/60">
    <CardHeader><CardTitle>{t("media.trim")}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">{t("media.trimNotice")}</p>
      {!source.trimProfile ? <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{t(unsupportedKey)}</p> : <>
        {!previewId && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{t("media.error.TRIM_PREVIEW")}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {(["start", "end"] as const).map(edge => <div key={edge} className="space-y-2">
            <label htmlFor={`trim-${edge}`} className="block text-sm font-medium">{t(edge === "start" ? "media.trimStart" : "media.trimEnd")}</label>
            <input id={`trim-${edge}`} type="text" inputMode="decimal" value={selection[edge]} disabled={locked} onChange={event => setSelection({ [edge]: event.target.value })}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-800" />
            <Button variant="outline" disabled={locked || !previewId} onClick={() => setFromPlayer(edge)}>{t(edge === "start" ? "media.setStart" : "media.setEnd")}</Button>
          </div>)}
        </div>
        <label htmlFor="trim-seek" className="block text-sm">{t("media.seekTime", { time: display(position) })}</label>
        <input id="trim-seek" type="range" min="0" max={source.duration ?? 0} step="0.001" value={Math.min(position, source.duration ?? 0)} disabled={locked || !previewId}
          onChange={event => seek(Number(event.target.value))} className="w-full accent-slate-900 dark:accent-slate-100" />
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("media.trimShortcuts")}</p>
        {source.trimProfile.hasVideo && <div className="space-y-2">
          <label htmlFor="trim-keyframe" className="block text-sm font-medium">{t("media.keyframeDirection")}</label>
          <select id="trim-keyframe" value={selection.mode} disabled={locked} onChange={event => setSelection({ mode: event.target.value as "before" | "after" })}
            className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-600 dark:bg-slate-800">
            <option value="before">{t("media.keyframeBefore")}</option><option value="after">{t("media.keyframeAfter")}</option>
          </select>
        </div>}
        {!valid && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{t("media.error.TRIM_RANGE")}</p>}
        {timingPending ? <Button variant="outline" onClick={() => void localTrimActions.cancel()}>{t("media.cancelTiming")}</Button> :
          <Button variant="outline" disabled={locked || !previewId || !valid} onClick={() => {
            if (previewId && start !== null && end !== null) void localTrimActions.inspect({ sourceId: source.sourceId, previewId, start, end, mode: selection.mode })
          }}>{t("media.reviewCut")}</Button>}
        {timing && <div className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-600">
          <p className="text-sm">{t("media.requestedCut", { start: display(timing.requestedStart), end: display(timing.requestedEnd) })}</p>
          <p className="text-sm">{t("media.plannedCut", { start: display(timing.plannedStart), end: display(timing.plannedEnd) })}</p>
          <p className="text-sm text-amber-700 dark:text-amber-300">{t("media.cutTolerance", { milliseconds: Math.round(timing.tolerance * 1000) })}</p>
          <p className="text-sm">{t("media.trimResult", { format: timing.extension.toUpperCase(), ids: timing.streamIndexes.map(id => `#${id}`).join(", ") })}</p>
          <Button variant="outline" disabled={locked || !previewId} onClick={() => void localExportActions.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })}>{t("media.chooseDestination")}</Button>
          {plan && <><p className="break-all text-sm">{t("media.saveAs", { name: plan.outputName })}</p>
            <Button disabled={locked || !previewId} onClick={() => void localExportActions.start(plan.planId)}>{t("media.saveClip")}</Button></>}
        </div>}
      </>}
    </CardContent>
  </Card>
}
