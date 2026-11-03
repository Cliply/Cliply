import { Button } from "@/components/ui/button"
import { FolderOpen, Music2 } from "lucide-react"
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
  return <section id="audio-extraction" aria-labelledby="audio-extraction-title" className="min-w-0 text-sm">
    <h2 id="audio-extraction-title" className="mb-4 flex items-center gap-2 text-sm font-medium"><Music2 className="size-4 text-muted-foreground" aria-hidden="true" />{t("media.extract")}</h2>
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="local-audio-track" className="block text-xs font-medium text-muted-foreground">{t("media.selectAudio")}</label>
        <select id="local-audio-track" value={selected ?? ""} disabled={locked || !audio.length}
          className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          onChange={event => useLocalExport.setState({ selection: event.target.value === "" ? null : { sourceId: source.sourceId, streamIndex: Number(event.target.value) } })}>
          <option value="">{t("media.chooseTrack")}</option>
          {audio.map(stream => <option key={stream.index} value={stream.index}>{`#${stream.index} · ${stream.codec || "?"} · ${stream.language || "—"}${stream.title ? ` · ${stream.title}` : ""}`}</option>)}
        </select>
      </div>
      <p className="rounded-md bg-muted/50 p-3 text-xs leading-relaxed">{profile ? t("media.audioResult", { format: profile.extension.toUpperCase() }) : t(audio.length ? "media.audioProfiles" : "media.noAudio")}</p>
      <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>{t("media.extractionNotice")}</p>
        <p>{t("media.extractionPreview")}</p>
      </div>
      <Button size="sm" variant="outline" className="h-auto min-h-8 w-full whitespace-normal py-2 text-xs" disabled={locked || !profile} onClick={() => void localExportActions.prepare({ operation: "extractAudio", sourceId: source.sourceId, streamIndex: selected! })}><FolderOpen aria-hidden="true" />{t("media.chooseDestination")}</Button>
      {plan && <div className="space-y-3 border-t border-border pt-4">
        <p className="break-words text-xs leading-relaxed [overflow-wrap:anywhere]">{t("media.saveAs", { name: plan.outputName })}</p>
        <p className="font-mono text-xs text-muted-foreground">{`#${plan.streamIndex} · ${plan.codec} · ${plan.extension.toUpperCase()}`}</p>
        <Button size="sm" className="h-auto min-h-8 w-full whitespace-normal py-2 text-xs" disabled={locked} onClick={() => void localExportActions.start(plan.planId)}><Music2 aria-hidden="true" />{t("media.extract")}</Button>
      </div>}
    </div>
  </section>
}
