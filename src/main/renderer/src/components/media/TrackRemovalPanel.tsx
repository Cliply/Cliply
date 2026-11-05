import { CompactPicker } from "@/components/ui/compact-picker"
import { Button } from "@/components/ui/button"
import { FileVideo, FolderOpen, ListVideo, VolumeX } from "lucide-react"
import { useT, type Key } from "@/lib/i18n"
import type { MediaSource, MediaContainer } from "@/lib/local-media-types"
import { exportActive, localExportActions, useLocalExport } from "@/lib/stores/localExportStore"

export function TrackRemovalPanel({ source, busy, operation = "removeTracks" }: { source: MediaSource; busy: boolean; operation?: "removeTracks" | "remux" }) {
  const t = useT()
  const snapshot = useLocalExport(s => s.snapshot)
  const pending = useLocalExport(s => s.pending)
  const remux = operation === "remux"
  const stored = useLocalExport(s => remux ? s.remuxSelection : s.trackSelection)
  const selection = stored?.sourceId === source.sourceId ? stored : {
    sourceId: source.sourceId, streamIndexes: source.streams.map(stream => stream.index), removeChapters: false
  }
  const remuxStored = useLocalExport(s => s.remuxSelection)
  const targetContainer = remuxStored?.sourceId === source.sourceId ? remuxStored.targetContainer : ""
  const remuxProfile = source.remuxProfiles?.find(profile => profile.targetContainer === targetContainer)
  const profile = remux ? remuxProfile : source.trackRemovalProfile
  const locked = busy || pending || exportActive(snapshot)
  const kept = source.streams.filter(stream => selection.streamIndexes.includes(stream.index))
  const setSelection = (changes: Partial<typeof selection> & { targetContainer?: MediaContainer | "" }) => {
    if (remux) useLocalExport.setState({ remuxSelection: { ...selection, targetContainer, ...changes } })
    else useLocalExport.setState({ trackSelection: { ...selection, ...changes } })
  }
  let limitation: Key | null = null
  if (!profile) limitation = remux ? source.remuxProfiles?.length ? "media.error.REMUX_TARGET" : "media.error.REMUX_SOURCE" : "media.error.TRACK_CONTAINER"
  else if (!kept.some(stream => ["video", "audio"].includes(stream.type) && !stream.disposition.attached_pic)) limitation = "media.error.TRACK_EMPTY"
  else if (kept.some(stream => !profile.supportedStreamIndexes.includes(stream.index))) limitation = "media.error.TRACK_UNSUPPORTED"
  else if (kept.filter(stream => stream.type === "video").length > 1) limitation = "media.error.TRACK_VIDEO_LIMIT"
  else if (source.chapterCount > 0 && !selection.removeChapters && !(remux && remuxProfile?.preservesChapters)) limitation = remux ? "media.error.REMUX_CHAPTERS" : "media.error.TRACK_CHAPTERS"
  else if (remux && [source, ...kept.filter(stream => ["audio", "video"].includes(stream.type))].some(item => item.startTime == null || Math.abs(item.startTime) > 0.1)) limitation = "media.error.REMUX_TIMING"
  else if (profile.extension !== "mkv" && kept.some(stream => !kept.some(other => other.type === stream.type && other.disposition.default))) limitation = "media.error.TRACK_DEFAULT"
  const candidate = snapshot.plan
  const plan = candidate?.operation === operation && (candidate.operation !== "remux" || candidate.targetContainer === targetContainer) && candidate.sourceId === source.sourceId &&
    candidate.removeChapters === selection.removeChapters && candidate.streamIndexes.length === selection.streamIndexes.length &&
    candidate.streamIndexes.every(index => selection.streamIndexes.includes(index)) ? candidate : null

  return <section id={remux ? "container-change" : "track-removal"} aria-labelledby="track-tool-title" className="min-w-0 text-sm">
    <h2 id="track-tool-title" className="mb-4 flex items-center gap-2 text-sm font-medium">{remux ? <FileVideo className="size-4 text-muted-foreground" aria-hidden="true" /> : <ListVideo className="size-4 text-muted-foreground" aria-hidden="true" />}{t(remux ? "media.remux" : "media.remove")}</h2>
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{t(remux ? "media.remuxNotice" : "media.trackCopyNotice")}</p>
      {remux && <div className="space-y-2">
        <label htmlFor="target-container" className="block text-xs font-medium text-muted-foreground">{t("media.targetContainer")}</label>
        <CompactPicker<MediaContainer | ""> id="target-container" label={t("media.targetContainer")}
          className="w-full" value={targetContainer} disabled={locked}
          options={[{ value: "", label: t("media.chooseContainer") }, ...(source.remuxProfiles || []).map(({ targetContainer: value }) => ({ value, label: value.toUpperCase() }))]}
          onSelect={value => setSelection({ targetContainer: value })} />
      </div>}
      <Button id="remove-all-audio" size="sm" variant="outline" className="h-auto min-h-8 w-full whitespace-normal py-2 text-xs" disabled={locked || !kept.some(stream => stream.type === "audio")}
        onClick={() => setSelection({ streamIndexes: kept.filter(stream => stream.type !== "audio").map(stream => stream.index) })}><VolumeX aria-hidden="true" />{t("media.removeAllAudio")}</Button>
      <fieldset disabled={locked} className="min-w-0 space-y-1.5">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">{t("media.keepTracks")}</legend>
        {source.streams.map(stream => {
          const checked = selection.streamIndexes.includes(stream.index)
          const supported = profile?.supportedStreamIndexes.includes(stream.index)
          return <div key={stream.index} className={`flex items-start gap-2.5 rounded-md border p-2.5 ${checked ? "border-border bg-muted/40" : "border-transparent"}`}>
            <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-[hsl(var(--primary))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" id={`keep-track-${stream.index}`} checked={checked} disabled={locked}
              onChange={event => setSelection({ streamIndexes: event.target.checked ? [...selection.streamIndexes, stream.index] : selection.streamIndexes.filter(index => index !== stream.index) })} />
            <label htmlFor={`keep-track-${stream.index}`} className="min-w-0 flex-1 cursor-pointer break-words text-xs leading-relaxed [overflow-wrap:anywhere]">
              <span className="block">{`#${stream.index} · ${stream.type} · ${stream.codec || "?"} · ${stream.language || "—"}${stream.title ? ` · ${stream.title}` : ""}`}{stream.disposition.attached_pic ? ` · ${t("media.coverArt")}` : ""}</span>
              <span className="text-muted-foreground">{t(checked ? "media.trackKept" : "media.trackRemoved")}{!supported && (!remux || profile) ? ` · ${t("media.trackUnsupported")}` : ""}</span>
            </label>
          </div>
        })}
      </fieldset>
      {source.chapterCount > 0 && <div className="flex items-start gap-2.5 border-t border-border pt-3">
        <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-[hsl(var(--primary))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" id="remove-chapters" checked={selection.removeChapters} disabled={locked} onChange={event => setSelection({ removeChapters: event.target.checked })} />
        <label htmlFor="remove-chapters" className="cursor-pointer text-xs leading-relaxed">{t("media.removeChapters", { count: source.chapterCount })}</label>
      </div>}
      {remux && source.chapterCount > 0 && !selection.removeChapters && remuxProfile?.preservesChapters && <p className="text-xs leading-relaxed">{t("media.chaptersKept", { count: source.chapterCount })}</p>}
      <p className="rounded-md bg-muted/50 p-3 text-xs leading-relaxed">{profile ? t(remux ? "media.remuxResult" : "media.trackCopyResult", { format: profile.extension.toUpperCase() }) : t(remux ? source.remuxProfiles?.length ? "media.error.REMUX_TARGET" : "media.error.REMUX_SOURCE" : "media.error.TRACK_CONTAINER")}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("media.fullFilePreview")}</p>
      {limitation && profile && <p role="alert" className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">{t(limitation)}</p>}
      <Button size="sm" variant="outline" className="h-auto min-h-8 w-full whitespace-normal py-2 text-xs" disabled={locked || Boolean(limitation)} onClick={() => {
        const { sourceId, streamIndexes, removeChapters } = selection
        if (remux) { if (targetContainer) void localExportActions.prepare({ operation: "remux", sourceId, streamIndexes, removeChapters, targetContainer }) }
        else void localExportActions.prepare({ operation: "removeTracks", sourceId, streamIndexes, removeChapters })
      }}><FolderOpen aria-hidden="true" />{t("media.chooseDestination")}</Button>
      {plan && <div className="space-y-3 border-t border-border pt-4">
        <p className="break-words text-xs leading-relaxed [overflow-wrap:anywhere]">{t("media.saveAs", { name: plan.outputName })}</p>
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>{t("media.keptSummary", { ids: plan.streamIndexes.map(index => `#${index}`).join(", ") })}</p>
          <p>{t("media.removedSummary", { ids: plan.removedStreamIndexes.map(index => `#${index}`).join(", ") || "—" })}</p>
        </div>
        <Button size="sm" className="h-auto min-h-8 w-full whitespace-normal py-2 text-xs" disabled={locked || Boolean(limitation)} onClick={() => void localExportActions.start(plan.planId)}>{t("media.saveCopy")}</Button>
      </div>}
    </div>
  </section>
}
