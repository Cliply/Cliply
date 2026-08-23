import { X } from "lucide-react"

import {
  ProgressBar,
  ProgressBarHeader,
  ProgressBarLabel,
  ProgressBarMeta,
  ProgressBarTrack,
  ProgressBarValue
} from "@/components/ui/progress-bar"
import { cn } from "@/lib/utils"

interface DownloadProgressBarState {
  status: string
  progress: number
  speed?: string
  eta?: string
  indeterminate?: boolean
  downloadId?: string
}

interface DownloadProgressBarProps {
  state: DownloadProgressBarState
  label: string
  className?: string
  /** omit to render progress without a stop control */
  onCancel?: () => void
}

/**
 * live progress for a running download
 *
 * trimmed downloads are muxed by ffmpeg in a single pass and only report once
 * at the end, so they get a sweeping bar rather than a percentage that would
 * sit at 0 and then jump straight to 100
 */
export function DownloadProgressBar({
  state,
  label,
  className,
  onCancel
}: DownloadProgressBarProps) {
  const isStarting = state.status === "starting"
  const isIndeterminate = state.indeterminate || isStarting

  const meta = isIndeterminate
    ? isStarting
      ? "Starting up"
      : "Progress isn't reported while trimming"
    : [state.speed, state.eta && `ETA ${state.eta}`].filter(Boolean).join("  ·  ")

  return (
    <ProgressBar
      value={state.progress || 0}
      isIndeterminate={isIndeterminate}
      className={cn(className)}
    >
      <ProgressBarHeader>
        <ProgressBarLabel>
          {isIndeterminate ? `Processing ${label}` : `Downloading ${label}`}
        </ProgressBarLabel>
        <ProgressBarValue />
      </ProgressBarHeader>

      <ProgressBarTrack />

      <div className="flex items-baseline justify-between gap-3">
        <ProgressBarMeta>{meta}</ProgressBarMeta>

        {onCancel && (
          // the engine can only be stopped once it has handed back an id, so
          // the control stays inert for the moment before the download starts
          <StopButton onCancel={onCancel} disabled={!state.downloadId} />
        )}
      </div>
    </ProgressBar>
  )
}

function StopButton({
  onCancel,
  disabled
}: {
  onCancel: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      onClick={onCancel}
      disabled={disabled}
      title={disabled ? "Starting up" : "Stop this download"}
      className={cn(
        "-my-0.5 flex shrink-0 items-center gap-1 rounded-lg border px-2 py-0.5",
        "font-mono text-[11px] leading-4 transition-colors duration-200 ease-out",
        // neutral until you reach for it, then the app's own error red
        "border-slate-200/70 text-slate-500",
        "hover:border-red-300/80 hover:text-red-600",
        "dark:border-slate-700/60 dark:text-slate-500",
        "dark:hover:border-red-500/40 dark:hover:text-red-400",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
      )}
    >
      <X className="h-3 w-3" />
      Stop
    </button>
  )
}
