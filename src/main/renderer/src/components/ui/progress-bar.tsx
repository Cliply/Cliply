import { createContext, useContext, useId, type ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * composable progress bar.
 *
 * slots mirror the usual header / value / track / meta split so a caller can
 * lay the parts out however it needs, while the value text, indeterminate
 * state and aria wiring stay in one place.
 *
 * `role="progressbar"` lives on the track rather than the root: a progressbar
 * exposes no child content, so putting it on the root would hide the label and
 * meta text from screen readers.
 */

interface ProgressBarContextValue {
  value: number
  isIndeterminate: boolean
  valueText: string
  labelId: string
}

const ProgressBarContext = createContext<ProgressBarContextValue | null>(null)

function useProgressBar(slot: string): ProgressBarContextValue {
  const context = useContext(ProgressBarContext)

  if (!context) {
    throw new Error(`<${slot}> must be rendered inside <ProgressBar>`)
  }

  return context
}

const clamp = (value: number) => Math.min(100, Math.max(0, value))

interface ProgressBarProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** 0-100; clamped, so callers can pass raw progress */
  value?: number
  /** work is running but its duration is unknowable */
  isIndeterminate?: boolean
  children?: ReactNode | ((state: ProgressBarContextValue) => ReactNode)
}

export function ProgressBar({
  value = 0,
  isIndeterminate = false,
  className,
  children,
  ...props
}: ProgressBarProps) {
  const labelId = useId()
  const clamped = clamp(value)

  const state: ProgressBarContextValue = {
    value: clamped,
    isIndeterminate,
    // integers only: a decimal place jitters on every tick and buys nothing
    // the speed and eta readout doesn't already give you
    valueText: `${Math.round(clamped)}%`,
    labelId
  }

  return (
    <ProgressBarContext.Provider value={state}>
      <div
        data-slot="progress-bar"
        data-state={isIndeterminate ? "indeterminate" : "determinate"}
        className={cn("w-full space-y-1.5", className)}
        {...props}
      >
        {typeof children === "function" ? children(state) : children}
      </div>
    </ProgressBarContext.Provider>
  )
}

export function ProgressBarHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="progress-bar-header"
      className={cn("flex items-baseline justify-between gap-3", className)}
      {...props}
    />
  )
}

export function ProgressBarLabel({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const { labelId } = useProgressBar("ProgressBarLabel")

  return (
    <span
      id={labelId}
      data-slot="progress-bar-label"
      className={cn(
        "truncate text-xs text-slate-600 dark:text-slate-300",
        className
      )}
      {...props}
    />
  )
}

export function ProgressBarValue({
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children">) {
  const { valueText, isIndeterminate } = useProgressBar("ProgressBarValue")

  if (isIndeterminate) return null

  return (
    <span
      data-slot="progress-bar-value"
      className={cn(
        // tabular figures keep the number from resizing as it counts up
        "shrink-0 font-mono text-xs tabular-nums text-slate-900 dark:text-slate-100",
        className
      )}
      {...props}
    >
      {valueText}
    </span>
  )
}

export function ProgressBarTrack({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { value, isIndeterminate, valueText, labelId } =
    useProgressBar("ProgressBarTrack")

  return (
    <div
      role="progressbar"
      aria-labelledby={labelId}
      aria-valuemin={0}
      aria-valuemax={100}
      // an indeterminate bar must not report a position
      aria-valuenow={isIndeterminate ? undefined : Math.round(value)}
      aria-valuetext={isIndeterminate ? "Working" : valueText}
      data-slot="progress-bar-track"
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full",
        "bg-slate-200/80 dark:bg-slate-700/60",
        className
      )}
      {...props}
    >
      {isIndeterminate ? (
        <div
          data-slot="progress-bar-shuttle"
          className={cn(
            "absolute inset-y-0 w-1/4 rounded-full",
            "bg-slate-900/70 dark:bg-slate-100/70",
            "animate-progress-shuttle",
            // a sweeping bar is motion for its own sake if you can't take it;
            // fall back to a static, quieter fill
            "motion-reduce:inset-x-0 motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40"
          )}
        />
      ) : (
        <div
          data-slot="progress-bar-fill"
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            "bg-slate-900 dark:bg-slate-100",
            "transition-[width] duration-300 ease-out motion-reduce:transition-none"
          )}
          style={{ width: `${value}%` }}
        />
      )}
    </div>
  )
}

export function ProgressBarMeta({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="progress-bar-meta"
      className={cn(
        // reserved height: the row is empty between states, and without this
        // the card twitches every time speed/eta appear or drop out
        "min-h-4 font-mono text-[11px] leading-4 tabular-nums text-slate-500 dark:text-slate-500",
        className
      )}
      {...props}
    />
  )
}
