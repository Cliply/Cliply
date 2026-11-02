import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

  return <Card id={remux ? "container-change" : "track-removal"} className="border-slate-300/50 bg-white/80 dark:border-slate-700/50 dark:bg-slate-800/60">
    <CardHeader><CardTitle>{t(remux ? "media.remux" : "media.remove")}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">{t(remux ? "media.remuxNotice" : "media.trackCopyNotice")}</p>
      {remux && <div className="space-y-2">
        <label htmlFor="target-container" className="block text-sm font-medium">{t("media.targetContainer")}</label>
        <select id="target-container" className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-600 dark:bg-slate-800" disabled={locked} value={targetContainer}
          onChange={event => setSelection({ targetContainer: event.target.value as MediaContainer | "" })}>
          <option value="">{t("media.chooseContainer")}</option>
          {(source.remuxProfiles || []).map(target => <option key={target.targetContainer} value={target.targetContainer}>{target.targetContainer.toUpperCase()}</option>)}
        </select>
      </div>}
      <Button id="remove-all-audio" variant="outline" disabled={locked || !kept.some(stream => stream.type === "audio")}
        onClick={() => setSelection({ streamIndexes: kept.filter(stream => stream.type !== "audio").map(stream => stream.index) })}>{t("media.removeAllAudio")}</Button>
      <fieldset disabled={locked} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">{t("media.keepTracks")}</legend>
        {source.streams.map(stream => {
          const checked = selection.streamIndexes.includes(stream.index)
          const supported = profile?.supportedStreamIndexes.includes(stream.index)
          return <div key={stream.index} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-slate-900 dark:accent-slate-100" id={`keep-track-${stream.index}`} checked={checked} disabled={locked}
              onChange={event => setSelection({ streamIndexes: event.target.checked ? [...selection.streamIndexes, stream.index] : selection.streamIndexes.filter(index => index !== stream.index) })} />
            <label htmlFor={`keep-track-${stream.index}`} className="min-w-0 flex-1 break-words text-sm">
              <span className="block">{`#${stream.index} · ${stream.type} · ${stream.codec || "?"} · ${stream.language || "—"}${stream.title ? ` · ${stream.title}` : ""}`}{stream.disposition.attached_pic ? ` · ${t("media.coverArt")}` : ""}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">{t(checked ? "media.trackKept" : "media.trackRemoved")}{!supported && (!remux || profile) ? ` · ${t("media.trackUnsupported")}` : ""}</span>
            </label>
          </div>
        })}
      </fieldset>
      {source.chapterCount > 0 && <div className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-slate-900 dark:accent-slate-100" id="remove-chapters" checked={selection.removeChapters} disabled={locked} onChange={event => setSelection({ removeChapters: event.target.checked })} />
        <label htmlFor="remove-chapters" className="text-sm">{t("media.removeChapters", { count: source.chapterCount })}</label>
      </div>}
      {remux && source.chapterCount > 0 && !selection.removeChapters && remuxProfile?.preservesChapters && <p className="text-sm">{t("media.chaptersKept", { count: source.chapterCount })}</p>}
      <p className="text-sm text-slate-600 dark:text-slate-300">{profile ? t(remux ? "media.remuxResult" : "media.trackCopyResult", { format: profile.extension.toUpperCase() }) : t(remux ? source.remuxProfiles?.length ? "media.error.REMUX_TARGET" : "media.error.REMUX_SOURCE" : "media.error.TRACK_CONTAINER")}</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t("media.fullFilePreview")}</p>
      {limitation && profile && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{t(limitation)}</p>}
      <Button variant="outline" disabled={locked || Boolean(limitation)} onClick={() => {
        const { sourceId, streamIndexes, removeChapters } = selection
        if (remux) { if (targetContainer) void localExportActions.prepare({ operation: "remux", sourceId, streamIndexes, removeChapters, targetContainer }) }
        else void localExportActions.prepare({ operation: "removeTracks", sourceId, streamIndexes, removeChapters })
      }}>{t("media.chooseDestination")}</Button>
      {plan && <div className="space-y-3 rounded-lg border border-slate-300 p-4 dark:border-slate-600">
        <p className="break-all text-sm">{t("media.saveAs", { name: plan.outputName })}</p>
        <p className="text-sm">{t("media.keptSummary", { ids: plan.streamIndexes.map(index => `#${index}`).join(", ") })}</p>
        <p className="text-sm">{t("media.removedSummary", { ids: plan.removedStreamIndexes.map(index => `#${index}`).join(", ") || "—" })}</p>
        <Button disabled={locked || Boolean(limitation)} onClick={() => void localExportActions.start(plan.planId)}>{t("media.saveCopy")}</Button>
      </div>}
    </CardContent>
  </Card>
}
