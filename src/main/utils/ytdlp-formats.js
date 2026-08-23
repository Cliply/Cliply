// download options for the simple platforms
//
// youtube has no table here any more: the quality menu is built from the
// formats yt-dlp reports and the download asks for `-t <container> -S res:<h>`,
// so there is nothing left to look a preset id up in

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
  getSimplePlatformOptions
}
