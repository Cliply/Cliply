import { CompactPicker } from "@/components/ui/compact-picker"
import { Scissors, Trash2, ArrowDownToLine } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT, type Key } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import type { MediaSource } from "@/lib/local-media-types"
import {
  localExportActions,
  localTrimActions,
  useLocalExport
} from "@/lib/stores/localExportStore"
import {
  editorActions,
  setEdge,
  deleteSection,
  type EditDocument
} from "@/lib/stores/editorStore"
import { timecode } from "./CutTimeline"

const cutSeconds = (value: string) =>
  /^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value) &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null

type TrimInspectorProps = {
  source: MediaSource
  edit: EditDocument
  locked: boolean
  valid: boolean
  commit: (edit: EditDocument) => void
  seek: (time: number) => void
  stopPreview: () => void
}

// Owns section fields and export review; edits still use the shared document.
export function TrimInspector({
  source,
  edit,
  locked,
  valid,
  commit,
  seek,
  stopPreview
}: TrimInspectorProps) {
  const t = useT()
  const snapshot = useLocalExport((s) => s.snapshot)
  const timingPending = useLocalExport((s) => s.timingPending)
  const storedTiming = useLocalExport((s) => s.trimTiming)
  const duration = source.duration ?? 0
  const range = edit.ranges[edit.active]
  const timing =
    storedTiming?.sourceId === source.sourceId &&
    storedTiming.intent === edit.intent &&
    storedTiming.mode === edit.mode &&
    JSON.stringify(storedTiming.ranges) === JSON.stringify(edit.ranges) &&
    storedTiming.expiresAt > Date.now()
      ? storedTiming
      : null
  const plan =
    snapshot.plan?.operation === "trim" &&
    snapshot.plan.trimPlanId === timing?.trimPlanId
      ? snapshot.plan
      : null
  const reason = `media.error.${source.capabilities?.trim?.reason}`
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="cut-inspector">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold">{t("media.editVideo")}</h2>
          <Scissors
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <CompactPicker id="edit-intent" label={t("media.editMode")} value={edit.intent} disabled={locked}
          options={[{ value: "keep", label: t("media.keepMarked") }, { value: "remove", label: t("media.removeMarked") }]}
          onSelect={intent => commit({ ...edit, intent })} />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            edit.intent === "keep" ? "media.keepMeaning" : "media.removeMeaning"
          )}
        </p>
        <div className="max-h-52 space-y-1 overflow-y-auto">
          {edit.ranges.map((section, index) => (
            <div
              key={index}
              className={`flex min-w-0 items-center rounded-md border ${index === edit.active ? "border-primary/40 bg-primary/10" : "border-transparent bg-muted/40"}`}
            >
              <button
                disabled={locked}
                type="button"
                aria-pressed={index === edit.active}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-2.5 text-left text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => {
                  editorActions.select(index)
                  seek(section.start)
                }}
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-background text-[10px] text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 truncate font-mono">
                  {timecode(section.start)} – {timecode(section.end)}
                </span>
              </button>
              <button
                disabled={locked}
                type="button"
                className="mr-1 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                aria-label={t("media.deleteMark", { number: index + 1 })}
                title={t("media.deleteMark", { number: index + 1 })}
                onClick={() =>
                  commit(deleteSection({ ...edit, active: index }))
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
      <details className="border-t border-border pt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none text-[11px]">
          {t("media.preciseControls")}
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {range &&
            (["start", "end"] as const).map((edge) => (
              <label key={edge} className="min-w-0 space-y-1 text-[11px]">
                {t(edge === "start" ? "media.trimStart" : "media.trimEnd")}
                <input
                  id={`trim-${edge}`}
                  type="number"
                  step="0.1"
                  min={0}
                  max={duration}
                  value={Number(range[edge].toFixed(6))}
                  disabled={locked}
                  onChange={(event) => {
                    const value = cutSeconds(event.target.value)
                    if (value !== null)
                      commit(setEdge(edit, edge, value, duration))
                  }}
                  className="block h-8 w-full min-w-0 rounded border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </label>
            ))}
          <div className="col-span-2 space-y-1 text-[11px]">
            <label htmlFor="trim-keyframe">{t("media.keyframeDirection")}</label>
            <CompactPicker id="trim-keyframe" label={t("media.keyframeDirection")} value={edit.mode} disabled={locked}
              options={[{ value: "before", label: t("media.keyframeBefore") }, { value: "after", label: t("media.keyframeAfter") }]}
              onSelect={mode => commit({ ...edit, mode })} />
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed">
          {t("media.editorShortcuts")}
        </p>
      </details>
      <div className="space-y-3 border-t border-border pt-4">
        {!source.trimProfile && (
          <p
            role="alert"
            className="text-xs leading-relaxed text-amber-700 dark:text-amber-300"
          >
            {reason in en ? t(reason as Key) : t("media.error.TRIM_PROFILE")}
          </p>
        )}
        {!valid && (
          <p
            role="alert"
            className="text-xs text-amber-700 dark:text-amber-300"
          >
            {t("media.emptyEdit")}
          </p>
        )}
        {timingPending ? (
          <Button
            className="h-auto min-h-8 w-full whitespace-normal px-2 py-2 text-xs"
            variant="outline"
            onClick={() => void localTrimActions.cancel()}
          >
            {t("media.cancelTiming")}
          </Button>
        ) : (
          <Button
            className="h-auto min-h-8 w-full whitespace-normal px-2 py-2 text-xs"
            disabled={locked || !valid || !source.trimProfile}
            onClick={() => {
              stopPreview()
              void localTrimActions.inspect({
                sourceId: source.sourceId,
                ranges: edit.ranges,
                intent: edit.intent,
                mode: edit.mode
              })
            }}
          >
            <ArrowDownToLine className="size-3.5" />
            {t("media.reviewCut")}
          </Button>
        )}
        {timing && (
          <div className="space-y-3 rounded-md border border-primary/25 bg-primary/5 p-3">
            <p className="text-xs font-medium leading-relaxed">
              {t("media.editFormat", {
                format: timing.extension.toUpperCase()
              })}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("media.fastCutNote")}
            </p>
            <ol className="max-h-40 space-y-1 overflow-y-auto text-[11px] tabular-nums">
              {(timing.cuts ?? [timing]).map((cut, index) => (
                <li key={index}>
                  {index + 1}.{" "}
                  {t("media.plannedCut", {
                    start: cut.plannedStart.toFixed(3),
                    end: cut.plannedEnd.toFixed(3)
                  })}
                </li>
              ))}
            </ol>
            <Button
              className="h-auto min-h-8 w-full whitespace-normal px-2 text-xs"
              variant="outline"
              disabled={locked}
              onClick={() =>
                void localExportActions.prepare({
                  operation: "trim",
                  sourceId: source.sourceId,
                  trimPlanId: timing.trimPlanId
                })
              }
            >
              {t("media.chooseDestination")}
            </Button>
            {plan && (
              <>
                <p className="break-all text-[11px] text-muted-foreground">
                  {t("media.saveAs", { name: plan.outputName })}
                </p>
                <Button
                  className="h-auto min-h-8 w-full whitespace-normal px-2 py-2 text-xs"
                  disabled={locked}
                  onClick={() => void localExportActions.start(plan.planId)}
                >
                  {t("media.exportEdit")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
