// formatting and parsing the renderer does on its own, with no ipc involved

import type { Key } from "@/lib/i18n"

export const extractVideoId = (url: string): string | null => {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([^"&?/\s]{11})/
  )
  return match ? match[1] : null
}

export const isYouTubeShorts = (url: string): boolean => {
  return /\/shorts\//.test(url.toLowerCase())
}

export const formatFileSize = (bytes?: number | null): string => {
  if (!bytes) return "Unknown size"
  const sizes = ["Bytes", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i]
}

/**
 * a language code as a name a person reads: "hi" -> "Hindi", "zh-Hans" ->
 * "Simplified Chinese"
 *
 * `Intl.DisplayNames` is the browser's own CLDR data, which is the whole point:
 * a hand-written table of 22 languages would be exactly the invented vocabulary
 * this revamp deleted, and it would go stale the moment youtube adds a dub.
 * A tag it cannot name (or one malformed enough to throw) falls back to the
 * code itself, which is still something the user can act on.
 */
export const languageName = (code: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code
  } catch {
    return code
  }
}

export const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`
}

export const secondsToTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`
}

export const timeToSeconds = (time: string): number => {
  const parts = time.split(":").map(Number)
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  return parts[0] || 0
}

// the reason is a translation key rather than a sentence: whoever renders it
// calls `t()` there, the same way the zod schemas carry their messages
export const validateTimeRange = (
  start: number,
  end: number,
  duration: number
): { isValid: boolean; error?: Key } => {
  if (start < 0) {
    return { isValid: false, error: "time.startNegative" }
  }

  if (end > duration) {
    return { isValid: false, error: "time.endExceeds" }
  }

  if (start >= end) {
    return { isValid: false, error: "time.endBeforeStart" }
  }

  return { isValid: true }
}
