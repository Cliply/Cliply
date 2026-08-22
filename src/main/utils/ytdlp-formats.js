// yt-dlp format selectors
// ported from python/platforms/youtube.py so the preset format ids the
// renderer already sends keep resolving to the exact same yt-dlp selectors

// shorts are served as a single "auto" option instead of the full quality list
function isYoutubeShorts(url) {
  return typeof url === "string" && url.toLowerCase().includes("/shorts/")
}

// the preset ids the renderer knows about - anything else is treated as a raw
// yt-dlp format id coming straight from --dump-json
const VIDEO_PRESETS = {
  auto: null, // null means "let yt-dlp decide" - no -f flag at all
  shorts_auto: "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
  eco_360p: "best[height<=720]/bestvideo[height<=360]+bestaudio",
  hd_720p: "bestvideo[height<=720]+bestaudio",
  best_quality: "bestvideo+bestaudio/best"
}

const AUDIO_PRESETS = {
  auto_audio: "bestaudio",
  high_audio: "bestaudio",
  medium_audio: "bestaudio[abr<=128]"
}

const QUALITY_LABELS = {
  auto: "auto",
  shorts_auto: "shorts",
  best_quality: "best",
  hd_720p: "720p",
  eco_360p: "360p"
}

// the format option lists the ui renders
function getFormatPresets(url = "") {
  if (isYoutubeShorts(url)) {
    return {
      videoFormats: [
        {
          format_id: "shorts_auto",
          quality: "Auto",
          ext: "mp4",
          filesize: null,
          type: "auto"
        }
      ],
      audioFormats: [
        {
          format_id: "auto_audio",
          quality: "Auto",
          ext: "m4a",
          filesize: null,
          type: "audio"
        }
      ]
    }
  }

  return {
    videoFormats: [
      {
        format_id: "auto",
        quality: "Auto (Recommended)",
        ext: "mp4/webm",
        filesize: null,
        type: "auto"
      },
      {
        format_id: "best_quality",
        quality: "Best Quality",
        ext: "mp4/webm",
        filesize: null,
        type: "video"
      },
      {
        format_id: "hd_720p",
        quality: "720p HD",
        ext: "mp4/webm",
        filesize: null,
        type: "video"
      },
      {
        format_id: "eco_360p",
        quality: "360p (Fast)",
        ext: "mp4",
        filesize: null,
        type: "combined"
      }
    ],
    audioFormats: [
      {
        format_id: "auto_audio",
        quality: "Auto",
        ext: "m4a",
        filesize: null,
        type: "audio"
      },
      {
        format_id: "high_audio",
        quality: "High Quality",
        ext: "m4a",
        filesize: null,
        type: "audio"
      },
      {
        format_id: "medium_audio",
        quality: "Medium Quality",
        ext: "m4a",
        filesize: null,
        type: "audio"
      }
    ]
  }
}

/**
 * convert a video/audio format id pair into a yt-dlp -f selector
 * @param {string} videoFormatId - preset id or raw yt-dlp format id
 * @param {string} audioFormatId - preset id or raw yt-dlp format id
 * @returns {string|null} selector, or null when yt-dlp should pick by itself
 */
function getFormatSelector(videoFormatId, audioFormatId) {
  if (Object.prototype.hasOwnProperty.call(VIDEO_PRESETS, videoFormatId)) {
    return VIDEO_PRESETS[videoFormatId]
  }

  // raw format ids from --dump-json get merged the way the plan describes
  if (isRawFormatId(videoFormatId) && isRawFormatId(audioFormatId)) {
    return `${videoFormatId}+${audioFormatId}`
  }

  return "bestvideo+bestaudio/best"
}

/**
 * convert an audio format id into a yt-dlp -f selector
 * @param {string} formatId - preset id or raw yt-dlp format id
 * @returns {string} selector
 */
function getAudioFormatSelector(formatId) {
  if (Object.prototype.hasOwnProperty.call(AUDIO_PRESETS, formatId)) {
    return AUDIO_PRESETS[formatId]
  }

  if (isRawFormatId(formatId)) {
    return formatId
  }

  return "bestaudio"
}

// short label used in output filenames
function getQualityLabel(videoFormatId) {
  return QUALITY_LABELS[videoFormatId] || videoFormatId
}

// short label used in audio output filenames (matches the python string dance)
function getAudioQualityLabel(formatId) {
  if (!formatId) return "auto"
  return String(formatId).replace(/_audio$/, "")
}

// a raw id is what --dump-json reports: "133", "251", "hls-720", never a preset
function isRawFormatId(formatId) {
  return (
    typeof formatId === "string" &&
    formatId.length > 0 &&
    /^[\w.-]+$/.test(formatId) &&
    !Object.prototype.hasOwnProperty.call(VIDEO_PRESETS, formatId) &&
    !Object.prototype.hasOwnProperty.call(AUDIO_PRESETS, formatId)
  )
}

// download options the python services used for the simple platforms
// (ported from python/platforms/tiktok.py and pinterest.py)
const SIMPLE_PLATFORM_PRESETS = {
  tiktok: {
    // 'b' picks the best pre-merged file; yt-dlp scores the non-watermarked
    // play_addr streams above the watermarked download_addr ones
    formatSelector: "b",
    extraArgs: [
      "--merge-output-format",
      "mp4",
      // a us ip normalises format availability - some regions get only a single
      // low quality stream from the tiktok cdn
      "--add-header",
      "X-Forwarded-For:8.8.8.8",
      "--extractor-args",
      "tiktok:api_hostname=api22-normal-v4.tiktokv.com",
      // tiktok's own retry counts, which were more generous than the shared ones
      "--retries",
      "2",
      "--extractor-retries",
      "2",
      "--fragment-retries",
      "3"
    ]
  },
  pinterest: {
    formatSelector: "bestvideo+bestaudio/best",
    extraArgs: ["--merge-output-format", "mp4"]
  }
}

/**
 * the download options for a simple platform
 * @param {string} platform - tiktok | pinterest
 * @returns {Object} {formatSelector, extraArgs}
 */
function getSimplePlatformOptions(platform) {
  const preset = SIMPLE_PLATFORM_PRESETS[String(platform || "").toLowerCase()]

  if (!preset) {
    return { formatSelector: "best", extraArgs: [] }
  }

  return { formatSelector: preset.formatSelector, extraArgs: [...preset.extraArgs] }
}

module.exports = {
  getSimplePlatformOptions,
  isYoutubeShorts,
  getFormatPresets,
  getFormatSelector,
  getAudioFormatSelector,
  getQualityLabel,
  getAudioQualityLabel,
  isRawFormatId
}
