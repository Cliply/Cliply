import { useEffect, type RefObject } from "react"
import { createPortal } from "react-dom"
import { Scissors, Undo2, Redo2, Plus, Play, Pause } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"
import type { MediaSource } from "@/lib/local-media-types"
import { useLocalMedia } from "@/lib/stores/localMediaStore"
import {
  exportActive,
  localTrimActions,
  useLocalExport
} from "@/lib/stores/localExportStore"
import {
  useEditor,
  editorActions,
  initialEdit,
  retainedSections,
  setEdge,
  splitSection,
  addSection,
  type EditDocument
} from "@/lib/stores/editorStore"
import { CutTimeline, timecode } from "./CutTimeline"
import { TrimInspector } from "./TrimInspector"
import { useTrimPlayback } from "./useTrimPlayback"
import { useTrimShortcuts } from "./useTrimShortcuts"

export function TrimPanel({
  source,
  busy,
  player,
  inspectorTarget
}: {
  source: MediaSource
  busy: boolean
  player: RefObject<HTMLMediaElement | null>
  inspectorTarget?: HTMLElement | null
}) {
  const t = useT()
  const snapshot = useLocalExport((s) => s.snapshot)
  const pending = useLocalExport((s) => s.pending)
  const timingPending = useLocalExport((s) => s.timingPending)
  const position = useLocalMedia((s) => s.position)
  const state = useEditor()
  const duration = source.duration ?? 0
  const edit =
    state.sourceId === source.sourceId ? state.document : initialEdit(duration)
  const retained = retainedSections(edit, duration)
  const valid =
    retained.length > 0 &&
    retained.length <= 32 &&
    retained.every((range) => range.end - range.start >= 0.1 - 1e-9)
  const locked = busy || pending || timingPending || exportActive(snapshot)
  useEffect(() => {
    editorActions.open(source.sourceId, duration)
  }, [source.sourceId, duration])
  const { playing, previewing, stopPreview, togglePlay, togglePreview } =
    useTrimPlayback({ player, sourceId: source.sourceId, retained, locked })
  const range = edit.ranges[edit.active]
  const currentTime = () =>
    player.current && player.current.readyState > 0
      ? player.current.currentTime
      : position
  const seek = (time: number) => {
    if (locked) return
    stopPreview()
    const target = Math.max(0, Math.min(duration, time))
    if (player.current && Number.isFinite(player.current.duration))
      player.current.currentTime = target
    useLocalMedia.setState({ position: target })
  }
  const commit = (next: EditDocument) => {
    if (!locked) {
      stopPreview()
      editorActions.commit(next)
      localTrimActions.reset()
    }
  }
  const mark = (edge: "start" | "end") =>
    commit(setEdge(edit, edge, currentTime(), duration))
  useTrimShortcuts({
    locked,
    edit,
    currentTime,
    seek,
    mark,
    commit,
    togglePlay,
    stopPreview
  })
  useEffect(
    () => () => {
      if (useLocalExport.getState().timingPending)
        void localTrimActions.cancel()
    },
    []
  )
  const inspector = (
    <TrimInspector
      source={source}
      edit={edit}
      locked={locked}
      valid={valid}
      commit={commit}
      seek={seek}
      stopPreview={stopPreview}
    />
  )
  return (
    <section
      id="trim-panel"
      aria-label={t("media.trim")}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {/* Compact, grouped toolbar follows OpenCut Classic timeline-toolbar.tsx;
        actions continue to use the existing Cliply/LosslessCut edit document. */}
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          title={t("media.playPause")}
          aria-label={t("media.playPause")}
          disabled={locked}
          onClick={togglePlay}
        >
          {playing ? (
            <Pause className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
        </Button>
        <span aria-hidden="true" className="mx-1 h-4 border-l border-border" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-[11px]"
          title={`I · ${t("media.setStart")}`}
          aria-label={t("media.setStart")}
          disabled={locked || !range}
          onClick={() => mark("start")}
        >
          <span className="font-mono text-primary">[ I</span>
          <span className="editor-mark-label">{t("media.setStart")}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-[11px]"
          title={`O · ${t("media.setEnd")}`}
          aria-label={t("media.setEnd")}
          disabled={locked || !range}
          onClick={() => mark("end")}
        >
          <span className="editor-mark-label">{t("media.setEnd")}</span>
          <span className="font-mono text-primary">O ]</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          title={`B · ${t("media.split")}`}
          aria-label={t("media.split")}
          disabled={locked || splitSection(edit, currentTime()) === edit}
          onClick={() => commit(splitSection(edit, currentTime()))}
        >
          <Scissors className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          title={t("media.addSection")}
          aria-label={t("media.addSection")}
          disabled={
            locked || addSection(edit, currentTime(), duration) === edit
          }
          onClick={() => commit(addSection(edit, currentTime(), duration))}
        >
          <Plus className="size-3.5" />
        </Button>
        <span aria-hidden="true" className="mx-1 h-4 border-l border-border" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          title={t("media.undo")}
          aria-label={t("media.undo")}
          disabled={locked || !state.past.length}
          onClick={() => {
            stopPreview()
            localTrimActions.reset()
            editorActions.undo()
          }}
        >
          <Undo2 className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          title={t("media.redo")}
          aria-label={t("media.redo")}
          disabled={locked || !state.future.length}
          onClick={() => {
            stopPreview()
            localTrimActions.reset()
            editorActions.redo()
          }}
        >
          <Redo2 className="size-3.5" />
        </Button>
        <span className="ml-auto px-1 font-mono text-[11px] tabular-nums text-muted-foreground">
          {timecode(position)}
        </span>
      </div>
      {duration > 0 && (
        <CutTimeline
          key={source.sourceId}
          edit={edit}
          duration={duration}
          position={position}
          locked={locked}
          onEdit={commit}
          onSelect={editorActions.select}
          onSeek={seek}
        />
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          aria-label={t(previewing ? "media.stopPreview" : "media.previewEdit")}
          title={t(previewing ? "media.stopPreview" : "media.previewEdit")}
          disabled={locked || !valid}
          onClick={togglePreview}
        >
          {previewing ? (
            <Pause className="size-3" />
          ) : (
            <Play className="size-3" />
          )}
          <span className="editor-preview-label">
            {t(previewing ? "media.stopPreview" : "media.previewEdit")}
          </span>
          <span className="editor-preview-short-label">
            {t(previewing ? "media.stopPreviewShort" : "media.previewShort")}
          </span>
        </Button>
        <span className="px-1 text-[10px] tabular-nums text-muted-foreground">
          {t("media.outputSummary", {
            count: retained.length,
            time: timecode(
              retained.reduce((sum, part) => sum + part.end - part.start, 0)
            )
          })}
        </span>
      </div>
      {inspectorTarget ? (
        createPortal(inspector, inspectorTarget)
      ) : (
        <div className="border-t border-border p-3">{inspector}</div>
      )}
    </section>
  )
}
