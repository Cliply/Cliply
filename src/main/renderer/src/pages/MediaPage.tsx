import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, FolderOpen, X, Scissors, Music2, ListVideo, FileVideo, Loader2, Film } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DownloadsToggle } from "@/components/downloads/DownloadsToggle"
import { LocaleToggle } from "@/components/ui/locale-toggle"
import { ModeToggle } from "@/components/ui/mode-toggle"
import { NativeMediaPlayer } from "@/components/media/NativeMediaPlayer"
import { TrimPanel } from "@/components/media/TrimPanel"
import { TrackRemovalPanel } from "@/components/media/TrackRemovalPanel"
import { AudioExtractionPanel } from "@/components/media/AudioExtractionPanel"
import { ExportStatus } from "@/components/media/LocalExportStatus"
import { EditorWorkspace } from "@/components/media/EditorWorkspace"
import { exportActive, useLocalExport } from "@/lib/stores/localExportStore"
import { useT } from "@/lib/i18n"
import { localMediaActions, useLocalMedia } from "@/lib/stores/localMediaStore"
import type { MediaSource } from "@/lib/local-media-types"
import "@/components/media/editor-workspace.css"

const tools = [
  { action: "trim", label: "media.trim", Icon: Scissors },
  { action: "extractAudio", label: "media.extract", Icon: Music2 },
  { action: "removeTracks", label: "media.remove", Icon: ListVideo },
  { action: "remux", label: "media.remux", Icon: FileVideo }
] as const

function SourceTracks({ source }: { source: MediaSource }) {
  const t = useT()
  return <section className="editor-source-tracks" aria-label={t("media.tracks")}>
    <div className="editor-pane-heading"><h2>{t("media.tracks")}</h2><span>{t("media.chapters", { count: source.chapterCount })}</span></div>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs">
      <caption className="sr-only">{t("media.tracks")}</caption>
      <thead><tr className="border-b text-muted-foreground">
        {(["media.trackId", "media.type", "media.codec", "media.language", "media.trackTitle"] as const).map(key => <th key={key} scope="col" className="px-3 py-2.5 font-medium">{t(key)}</th>)}
      </tr></thead>
      <tbody>{source.streams.map(stream => <tr key={stream.index} className="border-b last:border-0">
        <td className="px-3 py-3 tabular-nums">{stream.index}</td><td className="px-3 py-3">{stream.type}{stream.disposition.attached_pic ? ` (${t("media.coverArt")})` : ""}</td>
        <td className="px-3 py-3 font-mono">{stream.codec || t("media.unknown")}</td><td className="px-3 py-3">{stream.language || "—"}</td><td className="max-w-48 break-words px-3 py-3">{stream.title || "—"}</td>
      </tr>)}</tbody>
    </table></div>
  </section>
}

export default function MediaPage() {
  const t = useT()
  const source = useLocalMedia(s => s.source)
  const busy = useLocalMedia(s => s.busy)
  const action = useLocalExport(s => s.action)
  const exporting = useLocalExport(s => exportActive(s.snapshot) || s.pending || s.timingPending)
  const hasExportStatus = useLocalExport(s => Boolean(s.snapshot.job || s.snapshot.recoveryError || s.error))
  const error = useLocalMedia(s => s.error)
  const player = useRef<HTMLMediaElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [inspectorTarget, setInspectorTarget] = useState<HTMLDivElement | null>(null)
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

  const toolLabel = tools.find(tool => tool.action === action)!.label
  const isMacOS = (window.electronAPI as typeof window.electronAPI & { platform?: { isMacOS?: boolean } })?.platform?.isMacOS
  // The compact header and nested resizable workspace adapt OpenCut Classic's
  // editor header/layout. Playback, edit state and exports stay owned by Cliply.
  return <main className="media-workspace" data-platform={isMacOS ? "darwin" : undefined}>
    <header className="editor-header">
      <Button variant="ghost" size="icon" asChild className="editor-back"><Link to="/" aria-label={t("media.back")} title={t("media.back")}><ArrowLeft /></Link></Button>
      <div className="editor-file-heading">
        <h1 ref={heading} tabIndex={-1} className="outline-none">{t("media.title")}</h1>
        {source && <p title={source.filename}>{source.filename}</p>}
      </div>
      <div className="editor-header-actions">
        {source && <Button variant="outline" size="sm" disabled={busy || exporting} aria-label={t("media.change")} title={t("media.change")} onClick={() => void localMediaActions.open()}>{busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}<span className="editor-open-label">{t("media.change")}</span></Button>}
        {(source || busy) && <Button variant="ghost" size="icon" disabled={exporting} aria-label={t(busy ? "media.cancel" : "media.close")} title={t(busy ? "media.cancel" : "media.close")} onClick={() => void localMediaActions.close()}><X /></Button>}
        <div className="editor-header-divider" />
        <div className="editor-global-controls"><DownloadsToggle /><LocaleToggle /><ModeToggle /></div>
      </div>
    </header>
    {busy && <p role="status" className="editor-notice"><Loader2 className="size-3.5 animate-spin" />{t("media.opening")}</p>}
    {error && <p role="alert" className="editor-notice text-red-600 dark:text-red-400">{error}</p>}
    <div className="editor-body">
      <nav className="editor-tools" aria-label={t("media.tools")}>
        {tools.map(({ action: tool, label, Icon }) => <button key={tool} type="button" disabled={!source || exporting} aria-pressed={action === tool} aria-label={t(label)} title={t(label)} onClick={() => useLocalExport.setState({ action: tool })}>
          <Icon aria-hidden="true" /><span>{t(label)}</span>
        </button>)}
      </nav>
      {source ? <EditorWorkspace
        preview={<div className="editor-preview-content">
          <div className="editor-pane-heading"><h2>{t("media.source")}</h2><span className="truncate">{source.formatNames.join(" / ").toUpperCase() || t("media.unknown")}</span></div>
          <div className="min-h-0 flex-1"><NativeMediaPlayer key={source.sourceId} source={source} busy={busy} mediaRef={player} /></div>
        </div>}
        inspector={<>
          <div className="editor-pane-heading"><h2>{t(toolLabel)}</h2></div>
          <dl className="editor-source-info">
            <div><dt>{t("media.duration")}</dt><dd>{source.duration === null ? t("media.unknown") : t("media.seconds", { value: source.duration.toFixed(2) })}</dd></div>
            <div><dt>{t("media.size")}</dt><dd>{source.bytes === null ? t("media.unknown") : `${(source.bytes / 1048576).toFixed(2)} MB`}</dd></div>
            <div><dt>{t("media.container")}</dt><dd>{source.formatNames.join(", ") || t("media.unknown")}</dd></div>
          </dl>
          {hasExportStatus && <div className="editor-export-status"><ExportStatus /></div>}
          <div ref={setInspectorTarget} className="editor-cut-inspector" hidden={action !== "trim"} />
          <div className="editor-file-tool">
            {action === "extractAudio" ? <AudioExtractionPanel source={source} busy={busy} /> : action === "trim" ? null : <TrackRemovalPanel source={source} busy={busy} operation={action} />}
          </div>
        </>}
        timeline={action === "trim" ? <TrimPanel source={source} busy={busy} player={player} inspectorTarget={inspectorTarget} /> : <SourceTracks source={source} />}
      /> : <div className="editor-empty">
        {hasExportStatus && <div className="editor-empty-export"><ExportStatus /></div>}
        <div className="editor-empty-content">
          <div className="editor-empty-icon"><Film className="size-7" strokeWidth={1.5} /></div>
          <h2>{t("media.empty")}</h2>
          <p>{t("media.emptyBody")}</p>
          <Button disabled={busy || exporting} onClick={() => void localMediaActions.open()}>{busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}{t("media.open")}</Button>
        </div>
      </div>}
    </div>
    <footer className="editor-footer"><span className="editor-session-dot" aria-hidden="true" />{t("media.sessionOnly")}</footer>
  </main>
}
