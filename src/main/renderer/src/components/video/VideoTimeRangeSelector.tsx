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

interface VideoTimeRangeSelectorProps {
  maxDuration: number
  className?: string
}

export function VideoTimeRangeSelector({
  maxDuration,
  className
}: VideoTimeRangeSelectorProps) {
  const { videoTimeRange, setVideoTimeRange } = useAppStore()
  const [startTimeInput, setStartTimeInput] = useState("00:00")
  const [endTimeInput, setEndTimeInput] = useState(secondsToTime(maxDuration))
  const [validationError, setValidationError] = useState<string | null>(null)

  // Initialize with full duration
  useEffect(() => {
    setEndTimeInput(secondsToTime(maxDuration))
    setVideoTimeRange({ start: 0, end: maxDuration })
  }, [maxDuration, setVideoTimeRange])

  const validateAndUpdateRange = (start: string, end: string) => {
    const startSeconds = timeToSeconds(start)
    const endSeconds = timeToSeconds(end)

    const validation = validateTimeRange(startSeconds, endSeconds, maxDuration)

    if (validation.isValid) {
      setVideoTimeRange({ start: startSeconds, end: endSeconds })
      setValidationError(null)
      return true
    } else {
      setValidationError(validation.error || null)
      return false
    }
  }

  const handleStartTimeChange = (value: string) => {
    setStartTimeInput(value)
    validateAndUpdateRange(value, endTimeInput)
  }

  const handleEndTimeChange = (value: string) => {
    setEndTimeInput(value)
    validateAndUpdateRange(startTimeInput, value)
  }

  const isValidRange =
    !validationError && videoTimeRange.end > videoTimeRange.start
  const selectedDuration = videoTimeRange.end - videoTimeRange.start

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
          Time Range
        </h3>
      </div>

      {/* Time Inputs */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          {/* Start Time */}
          <div>
            <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">
              Start Time
            </label>
            <input
              type="text"
              placeholder="MM:SS or HH:MM:SS"
              value={startTimeInput}
              onChange={(e) => handleStartTimeChange(e.target.value)}
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
          <div>
            <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">
              End Time
            </label>
            <input
              type="text"
              placeholder="MM:SS or HH:MM:SS"
              value={endTimeInput}
              onChange={(e) => handleEndTimeChange(e.target.value)}
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
      </div>

      {/* Validation Error */}
      {validationError && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-sm text-red-600 dark:text-red-400 font-medium"
        >
          {validationError}
        </motion.div>
      )}

      {/* Selected Duration Display */}
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
      <p className="text-xs text-slate-500 dark:text-slate-500">
        Format: MM:SS or HH:MM:SS • Max duration: {secondsToTime(maxDuration)}
      </p>
    </motion.div>
  )
}
