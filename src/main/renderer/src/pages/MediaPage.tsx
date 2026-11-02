import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, FolderOpen, X, Scissors, Music2, ListVideo, FileVideo, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DownloadsToggle } from "@/components/downloads/DownloadsToggle"
import { LocaleToggle } from "@/components/ui/locale-toggle"
import { ModeToggle } from "@/components/ui/mode-toggle"
import { NativeMediaPlayer } from "@/components/media/NativeMediaPlayer"
import { AudioExtractionPanel } from "@/components/media/AudioExtractionPanel"
import { ExportStatus } from "@/components/media/LocalExportStatus"
import { exportActive, useLocalExport } from "@/lib/stores/localExportStore"
import { useT } from "@/lib/i18n"
import { localMediaActions, useLocalMedia } from "@/lib/stores/localMediaStore"

export default function MediaPage() {
  const t = useT()
  const source = useLocalMedia((s) => s.source)
  const busy = useLocalMedia((s) => s.busy)
  const exporting = useLocalExport(s => exportActive(s.snapshot) || s.pending)
  const error = useLocalMedia((s) => s.error)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      await localMediaActions.refresh()
      if (alive) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  return <main className="min-h-screen bg-gradient-to-br from-slate-50 via-slate-100 to-slate-200 px-6 py-6 dark:from-slate-900 dark:via-slate-800 dark:to-slate-900">
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" asChild><Link to="/"><ArrowLeft />{t("media.back")}</Link></Button>
        <div className="flex items-center gap-2"><DownloadsToggle /><LocaleToggle /><ModeToggle /></div>
      </header>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1"><h1 ref={heading} tabIndex={-1} className="break-words text-2xl font-medium tracking-tight outline-none">{t("media.title")}</h1>
          <p className="mt-2 break-all text-slate-600 dark:text-slate-300">{source?.filename || t("media.empty")}</p></div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy || exporting} onClick={() => void localMediaActions.open()}>{busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}{t(source ? "media.change" : "media.open")}</Button>
          {(source || busy) && <Button variant="ghost" disabled={exporting} onClick={() => void localMediaActions.close()}><X />{t(busy ? "media.cancel" : "media.close")}</Button>}
        </div>
      </div>
      {busy && <p role="status" className="text-sm">{t("media.opening")}</p>}
      <ExportStatus />
      {error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      {!source && <Card><CardContent className="pt-6 text-sm text-slate-600 dark:text-slate-300">{t("media.emptyBody")}</CardContent></Card>}
      {source && <>
        <Card className="border-slate-300/50 bg-white/80 shadow-xl shadow-black/5 dark:border-slate-700/50 dark:bg-slate-800/60">
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600 dark:text-slate-300">
              <span>{t("media.duration")}: {source.duration === null ? t("media.unknown") : t("media.seconds", { value: source.duration.toFixed(2) })}</span>
              <span>{t("media.size")}: {source.bytes === null ? t("media.unknown") : `${(source.bytes / 1048576).toFixed(2)} MB`}</span>
              <span>{t("media.container")}: {source.formatNames.join(", ") || t("media.unknown")}</span>
            </div>
            <NativeMediaPlayer key={source.sourceId} source={source} busy={busy} />
          </CardContent>
        </Card>
        <Card className="border-slate-300/50 bg-white/80 dark:border-slate-700/50 dark:bg-slate-800/60">
          <CardHeader><CardTitle>{t("media.tracks")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <caption className="sr-only">{t("media.tracks")}</caption>
              <thead><tr className="border-b border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {(["media.trackId", "media.type", "media.codec", "media.language", "media.trackTitle"] as const).map((key) => <th key={key} scope="col" className="px-2 py-3 font-medium">{t(key)}</th>)}
              </tr></thead>
              <tbody>{source.streams.map((stream) => <tr key={stream.index} className="border-b border-slate-200/70 last:border-0 dark:border-slate-700/70">
                <td className="px-2 py-3">{stream.index}</td><td className="px-2 py-3">{stream.type}{stream.disposition.attached_pic ? ` (${t("media.coverArt")})` : ""}</td>
                <td className="px-2 py-3 font-mono">{stream.codec || t("media.unknown")}</td><td className="px-2 py-3">{stream.language || "—"}</td><td className="max-w-xs break-words px-2 py-3">{stream.title || "—"}</td>
              </tr>)}</tbody>
            </table></div>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("media.chapters", { count: source.chapterCount })}</p>
          </CardContent>
        </Card>
        <section aria-label={t("media.tools")} className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Button variant="outline" disabled><Scissors />{t("media.trim")}</Button><Button variant="secondary" onClick={() => document.getElementById("local-audio-track")?.focus()}><Music2 />{t("media.extract")}</Button>
            <Button variant="outline" disabled><ListVideo />{t("media.remove")}</Button><Button variant="outline" disabled><FileVideo />{t("media.remux")}</Button>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t("media.toolsUnavailable")}</p>
        </section>
        <AudioExtractionPanel source={source} busy={busy} />
      </>}
      <p className="pb-6 text-xs text-slate-500 dark:text-slate-400">{t("media.sessionOnly")}</p>
    </div>
  </main>
}
