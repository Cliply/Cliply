// analytics utilities

const fs = require("fs")
const path = require("path")
const os = require("os")

// error classification lives in utils/error-taxonomy.js - the substring
// matcher that used to sit here invented codes the rest of the app never had
// (FFMPEG_DISK_FULL) and read "block" in any word as bot detection

// extract quality from format id
function extractQuality(formatId) {
  if (!formatId) return "unknown"

  const id = formatId.toString().toLowerCase()

  // a video download is reported by the height the user picked, so any height
  // the menu offered comes through as itself rather than as "unknown"
  if (/^\d{2,4}p$/.test(id)) {
    return id
  }

  const knownIds = {
    // the three audio modes
    mp3: "mp3",
    m4a: "m4a",
    original: "original_audio",

    // platforms that always use best available (no user format selection)
    pinterest: "best_available",
    tiktok: "best_available"
  }

  if (knownIds[id]) {
    return knownIds[id]
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

/**
 * how long a download took, as a label rather than a measurement
 *
 * the boundaries are deliberately uneven. an even split would spend most of
 * its resolution separating fast from slightly less fast, where the question
 * these answer is whether downloads work for this person at all - so the
 * detail sits under a minute, which is where a download that behaved stops
 * being distinguishable from one that struggled, and everything past a quarter
 * of an hour collapses into a single "something is wrong".
 *
 * @param {number} elapsedMs - wall clock from the request to the finished file
 * @returns {string|null} a bucket label, or null when it was not measurable
 */
function elapsedBucket(elapsedMs) {
  // null rather than a "0s" that would read as an instant download. a clock
  // that stepped backwards mid-download is the realistic way this happens
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return null
  }

  const seconds = elapsedMs / 1000

  if (seconds < 5) return "<5s"
  if (seconds < 15) return "5-15s"
  if (seconds < 60) return "15-60s"
  if (seconds < 300) return "1-5 min"
  if (seconds < 900) return "5-15 min"
  return ">15 min"
}

/**
 * how fast a download ran, in mebibytes a second - the unit yt-dlp shows the
 * user while it works
 *
 * the label says MBps rather than MB/s because the bucket grammar's unit is
 * letters only: a slash cannot be written, and MBps is the same thing without
 * one. the boundary that matters is 1, which is roughly where a connection
 * stops keeping up with a video download.
 *
 * @param {number} bytes - the finished file's size
 * @param {number} elapsedMs - how long it took to arrive
 * @returns {string|null} a bucket label, or null when it was not measurable
 */
function speedBucket(bytes, elapsedMs) {
  // a size of zero is a stat that failed rather than an empty file - a
  // download that resolved always wrote something - and a duration of zero
  // divides into it to give an infinite speed. neither is a slow download
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return null
  }

  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null
  }

  const perSecond = bytes / (1024 * 1024) / (elapsedMs / 1000)

  if (perSecond < 1) return "<1 MBps"
  if (perSecond < 3) return "1-3 MBps"
  if (perSecond < 10) return "3-10 MBps"
  if (perSecond < 30) return "10-30 MBps"
  return ">30 MBps"
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
  extractQuality,
  extractTitleFromFilename,
  elapsedBucket,
  speedBucket,
  isFirstLaunch,
  sanitizeTitle,
  getAppVersion
}
