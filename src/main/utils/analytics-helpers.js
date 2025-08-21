// analytics utilities

const fs = require("fs")
const path = require("path")
const os = require("os")

// categorize errors
function categorizeError(errorMessage) {
  const message = errorMessage.toLowerCase()

  if (
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("timeout")
  ) {
    return "NETWORK_ERROR"
  }

  if (
    message.includes("bot") ||
    message.includes("rate") ||
    message.includes("blocked")
  ) {
    return "BOT_DETECTION"
  }

  if (
    message.includes("unavailable") ||
    message.includes("private") ||
    message.includes("deleted") ||
    message.includes("not available on this app") ||
    message.includes("restricted")
  ) {
    return "VIDEO_UNAVAILABLE"
  }

  if (message.includes("python") || message.includes("server")) {
    return "PYTHON_SERVER_ERROR"
  }

  if (message.includes("permission") || message.includes("access")) {
    return "PERMISSION_ERROR"
  }

  return "UNKNOWN_ERROR"
}

// extract quality from format id
function extractQuality(formatId) {
  if (!formatId) return "unknown"

  const id = formatId.toString().toLowerCase()

  // handle our new dynamic format selectors first
  const newFormatMappings = {
    // video format selectors
    auto: "auto",
    best_quality: "best",
    hd_720p: "720p",
    eco_360p: "360p",

    // audio format selectors
    auto_audio: "auto_audio",
    high_audio: "high_quality",
    medium_audio: "medium_quality"
  }

  if (newFormatMappings[id]) {
    return newFormatMappings[id]
  }

  // youtube format mappings (legacy support)
  const formatMap = {
    137: "1080p",
    299: "1080p",
    248: "1080p",
    136: "720p",
    298: "720p",
    247: "720p",
    22: "720p",
    135: "480p",
    244: "480p",
    18: "360p",
    134: "360p",
    243: "360p",
    133: "240p",
    242: "240p",
    160: "144p",
    278: "144p"
  }

  // direct format mapping
  if (formatMap[id]) {
    return formatMap[id]
  }

  // quality patterns
  const qualityPatterns = [
    { pattern: /1080p?/i, quality: "1080p" },
    { pattern: /720p?/i, quality: "720p" },
    { pattern: /480p?/i, quality: "480p" },
    { pattern: /360p?/i, quality: "360p" },
    { pattern: /240p?/i, quality: "240p" },
    { pattern: /144p?/i, quality: "144p" }
  ]

  for (const { pattern, quality } of qualityPatterns) {
    if (pattern.test(id)) {
      return quality
    }
  }

  // audio format mappings
  const audioFormatMap = {
    140: "128kbps",
    141: "256kbps",
    251: "160kbps",
    250: "70kbps",
    249: "50kbps",
    139: "48kbps",
    171: "128kbps",
    172: "256kbps"
  }

  // specific audio formats
  if (audioFormatMap[id]) {
    return audioFormatMap[id]
  }

  // yt-dlp format selectors
  if (id.includes("bestaudio")) {
    // extract bitrate
    const abrMatch = id.match(/abr<=?(\d+)/)
    if (abrMatch) {
      const bitrate = parseInt(abrMatch[1])
      // map bitrates to quality
      if (bitrate <= 70) return "low_quality"
      if (bitrate <= 128) return "medium_quality"
      if (bitrate <= 256) return "high_quality"
      return `${bitrate}kbps`
    }
    return "best_audio"
  }

  // other yt-dlp selectors
  if (id.includes("worstaudio")) {
    return "low_quality"
  }

  // quality-based selectors
  if (id.includes("[quality<=low]") || id.includes("quality=low")) {
    return "low_quality"
  }
  if (id.includes("[quality<=medium]") || id.includes("quality=medium")) {
    return "medium_quality"
  }
  if (id.includes("[quality<=high]") || id.includes("quality=high")) {
    return "high_quality"
  }

  // generic audio detection
  if (id.includes("audio")) {
    return "audio"
  }

  return "unknown"
}

// check first launch
function isFirstLaunch() {
  const userDataPath = path.join(os.homedir(), ".cliply")
  const firstLaunchMarker = path.join(userDataPath, ".first-launch-done")

  try {
    if (fs.existsSync(firstLaunchMarker)) {
      return false
    }

    // create marker
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true })
    }
    fs.writeFileSync(firstLaunchMarker, new Date().toISOString())
    return true
  } catch (error) {
    console.error("Error checking first launch:", error)
    return false
  }
}

// sanitize title (remove pii)
function sanitizeTitle(title) {
  if (!title || typeof title !== "string") {
    return "unknown"
  }

  // limit length and remove pii
  let sanitized = title
    .slice(0, 100)
    .replace(/\b\d{4,}\b/g, "[number]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[email]")

  return sanitized
}

// extract title from filename
function extractTitleFromFilename(filename) {
  if (!filename) return "unknown"

  // remove extension
  const nameWithoutExt = filename.replace(
    /\.(mp4|m4a|webm|mkv|avi|mov|mp3|wav|opus|aac|flac)$/i,
    ""
  )

  // filename patterns:
  // audio: {title}_audio_{quality}_{timestamp}
  // video: {title}_{quality}_{timestamp}

  let titlePart = nameWithoutExt

  // remove timestamp
  titlePart = titlePart.replace(/_\d{5}$/, "")

  // remove trimmed section
  titlePart = titlePart.replace(/_trimmed_[\d-]+$/, "")

  // audio files
  if (titlePart.includes("_audio_")) {
    const parts = titlePart.split("_audio_")
    if (parts.length >= 2) {
      titlePart = parts[0]
    }
  } else {
    // video files
    titlePart = titlePart.replace(
      /_(1080p|720p|480p|360p|240p|144p|high|medium|low)$/,
      ""
    )
  }

  return titlePart || "unknown"
}

// get app version
function getAppVersion() {
  try {
    const packageJson = require("../../../package.json")
    return packageJson.version
  } catch (error) {
    return "unknown"
  }
}

module.exports = {
  categorizeError,
  extractQuality,
  extractTitleFromFilename,
  isFirstLaunch,
  sanitizeTitle,
  getAppVersion
}
