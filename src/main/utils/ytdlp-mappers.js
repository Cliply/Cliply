// maps yt-dlp --dump-json output onto the response shapes the renderer already
// expects, and rebuilds the output filenames the python services produced
// ported from python/platforms/*.py and python/shared_utils.py

const { getFormatPresets, getQualityLabel } = require("./ytdlp-formats")

/**
 * strip characters that are illegal in filenames (ported from shared_utils)
 * @param {string} filename - raw title
 * @returns {string} safe filename fragment
 */
function sanitizeFilename(filename) {
  let name = String(filename == null ? "" : filename)

  // basename: drop anything up to the last path separator
  name = name.split(/[\\/]/).pop()

  // eslint-disable-next-line no-control-regex
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
  name = name.replace(/\s+/g, " ").trim()
  name = name.slice(0, 200)

  // windows rejects trailing dots/spaces and treats them specially
  name = name.replace(/[. ]+$/, "")

  return name || "video"
}

/**
 * seconds -> "MM:SS" or "HH:MM:SS" (ported from shared_utils.format_duration)
 * @param {number} seconds - duration
 * @returns {string} formatted duration
 */
function formatDuration(seconds) {
  if (!seconds) {
    return "00:00"
  }

  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
  }

  return `${pad(minutes)}:${pad(secs)}`
}

// same as format_duration but always used for filename fragments
function secondsToTimeString(seconds) {
  return formatDuration(seconds)
}

function pad(value) {
  return String(value).padStart(2, "0")
}

// a literal % in an output template would be read as a field spec by yt-dlp
function escapeTemplateLiteral(text) {
  return String(text).replace(/%/g, "%%")
}

// python used the low 5 digits of the epoch in ms
function filenameTimestamp(now = Date.now()) {
  return now % 100000
}

/**
 * youtube video info -> the VideoInfoResponse shape the renderer renders
 * @param {Object} info - parsed --dump-json payload
 * @param {string} url - the requested url (decides the shorts format list)
 * @returns {Object} response body
 */
function mapVideoInfo(info, url) {
  const { videoFormats, audioFormats } = getFormatPresets(url)

  return {
    title: info.title || "Unknown",
    duration: Math.floor(info.duration || 0),
    duration_string: formatDuration(info.duration || 0),
    thumbnail: info.thumbnail || null,
    uploader: info.uploader || "Unknown",
    video_formats: videoFormats,
    audio_formats: audioFormats
  }
}

/**
 * tiktok / pinterest info -> their simpler shared shape
 * @param {Object} info - parsed --dump-json payload
 * @param {string} fallbackTitle - used when the extractor has no title
 * @returns {Object} response body
 */
function mapSimpleInfo(info, fallbackTitle = "video") {
  return {
    title: info.title || fallbackTitle,
    duration: Math.floor(info.duration || 0),
    duration_string: formatDuration(info.duration || 0),
    thumbnail: info.thumbnail || null,
    // python fell back through uploader -> channel -> creator, in that order
    uploader: info.uploader || info.channel || info.creator || "Unknown"
  }
}

/**
 * does this extraction actually contain a playable video stream?
 * pinterest pins are often just images, which the python service rejected
 * @param {Object} info - parsed --dump-json payload
 * @returns {boolean} true when a video stream is present
 */
function hasPlayableVideo(info) {
  if (!info) return false

  const formats = Array.isArray(info.formats) ? info.formats : []

  // python inspected the format list and nothing else - metadata with no
  // formats (an image pin carrying a duration field) was never downloadable
  if (formats.length === 0) {
    return false
  }

  return formats.some(
    (format) => format && format.vcodec && format.vcodec !== "none"
  )
}

/**
 * output template for a combined video download
 * matches the python naming: <title>_<quality>[_trimmed_<start>-<end>]_<ts>.<ext>
 * @param {Object} params - {title, videoFormatId, timeRange, now}
 * @returns {string} yt-dlp -o template
 */
function buildVideoOutputTemplate({ title, videoFormatId, timeRange, now }) {
  const safeTitle = sanitizeFilename(title || "video")
  const quality = getQualityLabel(videoFormatId)
  const timestamp = filenameTimestamp(now)

  let name
  if (timeRange) {
    const start = secondsToTimeString(timeRange.start)
    const end = secondsToTimeString(timeRange.end)
    name = `${safeTitle}_${quality}_trimmed_${start}-${end}_${timestamp}`
  } else {
    name = `${safeTitle}_${quality}_${timestamp}`
  }

  // python replaced colons across the whole filename after formatting
  return `${escapeTemplateLiteral(name.replace(/:/g, "-"))}.%(ext)s`
}

/**
 * output template for an audio download
 * @param {Object} params - {title, formatId, timeRange, now}
 * @returns {string} yt-dlp -o template
 */
function buildAudioOutputTemplate({ title, formatId, timeRange, now }) {
  const safeTitle = sanitizeFilename(title || "audio")
  const quality = String(formatId || "auto").replace(/_audio$/, "")
  const timestamp = filenameTimestamp(now)

  let name
  if (timeRange) {
    const start = secondsToTimeString(timeRange.start)
    const end = secondsToTimeString(timeRange.end)
    name = `${safeTitle}_audio_${quality}_trimmed_${start}-${end}_${timestamp}`
  } else {
    name = `${safeTitle}_audio_${quality}_${timestamp}`
  }

  return `${escapeTemplateLiteral(name.replace(/:/g, "-"))}.%(ext)s`
}

/**
 * output template for a simple platform download (tiktok / pinterest)
 * @param {Object} params - {title, platform, now}
 * @returns {string} yt-dlp -o template
 */
function buildSimpleOutputTemplate({ title, platform, now }) {
  const safeTitle = sanitizeFilename(title || `${platform}_video`)
  const timestamp = filenameTimestamp(now)

  return `${escapeTemplateLiteral(`${safeTitle}_${platform}_${timestamp}`)}.%(ext)s`
}

module.exports = {
  hasPlayableVideo,
  sanitizeFilename,
  formatDuration,
  secondsToTimeString,
  escapeTemplateLiteral,
  filenameTimestamp,
  mapVideoInfo,
  mapSimpleInfo,
  buildVideoOutputTemplate,
  buildAudioOutputTemplate,
  buildSimpleOutputTemplate
}
