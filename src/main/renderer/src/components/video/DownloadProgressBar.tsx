import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

interface DownloadProgressBarState {
  status: string
  progress: number
  speed?: string
  eta?: string
  indeterminate?: boolean
}

interface DownloadProgressBarProps {
  state: DownloadProgressBarState
  label: string
  className?: string
}

/**
 * live progress for a running download
 *
 * trimmed downloads are muxed by ffmpeg in a single pass and only report once
 * at the end, so they get a pulsing bar rather than a percentage that would sit
 * at 0 and then jump straight to 100
 */
export function DownloadProgressBar({
  state,
  label,
  className
}: DownloadProgressBarProps) {
  const isIndeterminate = state.indeterminate || state.status === "starting"
  const percent = Math.min(100, Math.max(0, state.progress || 0))

  return (
    <div className={cn("space-y-2", className)}>
      <Progress
        value={isIndeterminate ? 100 : percent}
        className={cn("h-2", isIndeterminate && "animate-pulse")}
      />

      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-500">
        <span>
          {isIndeterminate
            ? `Processing your ${label} download...`
            : `Downloading ${label}... ${percent.toFixed(1)}%`}
        </span>

        {!isIndeterminate && (state.speed || state.eta) && (
          <span className="tabular-nums">
            {state.speed}
            {state.speed && state.eta ? " • " : ""}
            {state.eta ? `ETA ${state.eta}` : ""}
          </span>
        )}
      </div>
    </div>
  )
}
