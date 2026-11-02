import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useT } from "@/lib/i18n"
import type { MediaSource } from "@/lib/local-media-types"
import { exportActive, localExportActions, useLocalExport } from "@/lib/stores/localExportStore"

export function AudioExtractionPanel({ source, busy }: { source: MediaSource; busy: boolean }) {
  const t = useT()
  const state = useLocalExport(s => s.snapshot)
  const selection = useLocalExport(s => s.selection)
  const pending = useLocalExport(s => s.pending)
  const selected = selection?.sourceId === source.sourceId ? selection.streamIndex : null
  const profile = source.extractionProfiles?.find(p => p.streamIndex === selected)
  const locked = busy || pending || exportActive(state)
  const plan = state.plan?.operation === "extractAudio" && state.plan.sourceId === source.sourceId && state.plan.streamIndex === selected ? state.plan : null
  const audio = source.streams.filter(s => s.type === "audio")
  return <Card id="audio-extraction" className="border-slate-300/50 bg-white/80 dark:border-slate-700/50 dark:bg-slate-800/60">
    <CardHeader><CardTitle>{t("media.extract")}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <label htmlFor="local-audio-track" className="block text-sm font-medium">{t("media.selectAudio")}</label>
      <select id="local-audio-track" value={selected ?? ""} disabled={locked || !audio.length}
        className="w-full rounded-md border border-slate-300 bg-white p-3 text-sm dark:border-slate-600 dark:bg-slate-900"
        onChange={event => useLocalExport.setState({ selection: event.target.value === "" ? null : { sourceId: source.sourceId, streamIndex: Number(event.target.value) } })}>
        <option value="">{t("media.chooseTrack")}</option>
        {audio.map(stream => <option key={stream.index} value={stream.index}>{`#${stream.index} · ${stream.codec || "?"} · ${stream.language || "—"}${stream.title ? ` · ${stream.title}` : ""}`}</option>)}
      </select>
      <p className="text-sm text-slate-600 dark:text-slate-300">{profile ? t("media.audioResult", { format: profile.extension.toUpperCase() }) : t(audio.length ? "media.audioProfiles" : "media.noAudio")}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t("media.extractionNotice")}</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t("media.extractionPreview")}</p>
      <Button variant="outline" disabled={locked || !profile} onClick={() => void localExportActions.prepare({ operation: "extractAudio", sourceId: source.sourceId, streamIndex: selected! })}>{t("media.chooseDestination")}</Button>
      {plan && <div className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-600">
        <p className="break-all text-sm">{t("media.saveAs", { name: plan.outputName })}</p>
        <p className="text-sm">{`#${plan.streamIndex} · ${plan.codec} · ${plan.extension.toUpperCase()}`}</p>
        <Button disabled={locked} onClick={() => void localExportActions.start(plan.planId)}>{t("media.extract")}</Button>
      </div>}
    </CardContent>
  </Card>
}
