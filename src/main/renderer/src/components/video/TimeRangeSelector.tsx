import {
  formatDuration,
  secondsToTime,
  timeToSeconds,
  validateTimeRange
} from "@/lib/api"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Clock } from "lucide-react"
import { useEffect, useState } from "react"

interface TimeRangeSelectorProps {
  maxDuration: number
  className?: string
}

export function TimeRangeSelector({
  maxDuration,
  className
}: TimeRangeSelectorProps) {
  const { audioTimeRange, setAudioTimeRange } = useAppStore()
  const [startTimeInput, setStartTimeInput] = useState("00:00")
  const [endTimeInput, setEndTimeInput] = useState(secondsToTime(maxDuration))
  const [validationError, setValidationError] = useState<string | null>(null)

  // Initialize end time when component mounts
  useEffect(() => {
    setEndTimeInput(secondsToTime(maxDuration))
    setAudioTimeRange({ start: 0, end: maxDuration })
  }, [maxDuration, setAudioTimeRange])

  const validateAndUpdateRange = (start: string, end: string) => {
    const startSeconds = timeToSeconds(start)
    const endSeconds = timeToSeconds(end)

    const validation = validateTimeRange(startSeconds, endSeconds, maxDuration)

    if (validation.isValid) {
      setAudioTimeRange({ start: startSeconds, end: endSeconds })
      setValidationError(null)
      return true
    } else {
      setValidationError(validation.error || "Invalid time range")
      return false
    }
  }

  const handleStartTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setStartTimeInput(value)
    validateAndUpdateRange(value, endTimeInput)
  }

  const handleEndTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setEndTimeInput(value)
    validateAndUpdateRange(startTimeInput, value)
  }

  const isValidRange =
    !validationError && audioTimeRange.end > audioTimeRange.start
  const selectedDuration = audioTimeRange.end - audioTimeRange.start

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn("space-y-4", "font-space-grotesk", className)}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <Clock className="h-5 w-5 text-slate-600 dark:text-slate-400" />
        <h3 className="font-medium text-slate-900 dark:text-white">
          Time Range Selection
        </h3>
      </div>

      {/* Time Inputs */}
      <div className="grid grid-cols-2 gap-3">
        {/* Start Time */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-600 dark:text-slate-400">
            Start Time
          </label>
          <input
            type="text"
            value={startTimeInput}
            onChange={handleStartTimeChange}
            placeholder="MM:SS or HH:MM:SS"
            pattern="^([0-9]{1,2}:)?[0-5]?[0-9]:[0-5][0-9]$"
            className={cn(
              "w-full px-3 py-2 rounded-xl border transition-all duration-200",
              // Dark mode styles
              "dark:bg-slate-800 dark:border-slate-700 dark:text-white dark:placeholder:text-slate-500",
              "dark:focus:border-slate-600",
              // Light mode styles
              "bg-white border-slate-300 text-slate-900 placeholder:text-slate-500",
              "focus:border-slate-400",
              // Common styles
              "focus:outline-none text-sm",
              validationError && "border-red-500 focus:border-red-500"
            )}
          />
        </div>

        {/* End Time */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-600 dark:text-slate-400">
            End Time
          </label>
          <input
            type="text"
            value={endTimeInput}
            onChange={handleEndTimeChange}
            placeholder="MM:SS or HH:MM:SS"
            pattern="^([0-9]{1,2}:)?[0-5]?[0-9]:[0-5][0-9]$"
            className={cn(
              "w-full px-3 py-2 rounded-xl border transition-all duration-200",
              // Dark mode styles
              "dark:bg-slate-800 dark:border-slate-700 dark:text-white dark:placeholder:text-slate-500",
              "dark:focus:border-slate-600",
              // Light mode styles
              "bg-white border-slate-300 text-slate-900 placeholder:text-slate-500",
              "focus:border-slate-400",
              // Common styles
              "focus:outline-none text-sm",
              validationError && "border-red-500 focus:border-red-500"
            )}
          />
        </div>
      </div>

      {/* Validation Error */}
      {validationError && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-sm text-red-600 dark:text-red-400"
        >
          {validationError}
        </motion.div>
      )}

      {/* Duration Display */}
      {isValidRange && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-sm text-slate-600 dark:text-slate-400"
        >
          Selected duration:{" "}
          <span className="font-medium text-slate-900 dark:text-white">
            {formatDuration(selectedDuration)}
          </span>
        </motion.div>
      )}

      {/* Helper Text */}
      <div className="text-xs text-slate-500 dark:text-slate-500">
        Use MM:SS or HH:MM:SS format. Max duration: {secondsToTime(maxDuration)}
      </div>
    </motion.div>
  )
}
