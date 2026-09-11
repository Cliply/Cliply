/**
 * codec ranking and format selection
 *
 * the sort yt-dlp itself applies to a format list, mirrored here, so that the
 * quality ladder and the audio track list we hand the renderer describe the
 * streams a download really picks rather than the ones we would have guessed
 */

// yt-dlp's own default vcodec preference, best first. mirroring it is what
// makes the stream we describe the stream `-S res:<height>` actually picks
const VCODEC_PREFERENCE = ["av1", "vp9", "h265", "h264", "vp8"]

// the codec that decides whether a height can be handed over as real mp4:
// h264 caps at 1080p on youtube, so 1440p/2160p are av1/vp9 and must be mkv
const MP4_CODEC = "h264"

// `-t mp4` prepends `acodec:aac` to the sort, so an mp4 tier merges the best
// aac stream and never the higher-bitrate opus one
const MP4_ACODEC = "aac"

// yt-dlp's own default acodec preference, best first. it is what separates two
// streams of equal quality - opus wins over aac, which is why an mkv tier and
// an mp4 tier of the same video are sized against different audio
const ACODEC_PREFERENCE = ["opus", "vorbis", MP4_ACODEC, "mp3"]

// "avc1.4d4020" / "vp09.00.40.08" / "av01.0.09M.08" -> the family name we sort
// and label by
function codecFamily(vcodec) {
  const value = String(vcodec == null ? "" : vcodec)
    .toLowerCase()
    .trim()

  if (!value || value === "none") return "unknown"
  if (value.startsWith("av01") || value.startsWith("av1")) return "av1"
  if (value.startsWith("vp09") || value.startsWith("vp9")) return "vp9"
  if (value.startsWith("vp08") || value.startsWith("vp8")) return "vp8"
  if (
    value.startsWith("hev1") ||
    value.startsWith("hvc1") ||
    value.startsWith("h265")
  ) {
    return "h265"
  }
  if (value.startsWith("avc1") || value.startsWith("h264")) return MP4_CODEC

  return value.split(".")[0]
}

// filesize is exact when yt-dlp knows it and approximate otherwise; either
// beats showing nothing, but a zero or a missing value must stay unknown
function formatSize(format) {
  for (const value of [format.filesize, format.filesize_approx]) {
    const size = Number(value)
    if (Number.isFinite(size) && size > 0) {
      return size
    }
  }

  return null
}

function audioRate(format) {
  return Number(format.abr) || Number(format.tbr) || 0
}

function audioOnlyFormats(formats) {
  return formats.filter(
    (format) =>
      format &&
      format.vcodec === "none" &&
      format.acodec &&
      format.acodec !== "none"
  )
}

// "mp4a.40.2" / "aac" -> aac; opus and vorbis stay themselves
function audioCodecFamily(acodec) {
  const value = String(acodec == null ? "" : acodec)
    .toLowerCase()
    .trim()

  if (!value || value === "none") return "unknown"
  if (value.startsWith("mp4a") || value.startsWith("aac")) return MP4_ACODEC

  return value.split(".")[0]
}

// lower sorts better, compared left to right - the fields yt-dlp's own sort
// applies to an audio stream (lang, quality, acodec, size, br), plus the
// `acodec:aac` that -t mp4 puts in front of them
function audioRank(format, container) {
  const family = audioCodecFamily(format.acodec)
  const preference = ACODEC_PREFERENCE.indexOf(family)

  return [
    // `lang` is the first field yt-dlp compares, and it puts the track the
    // video was recorded in ahead of every dub - so a 22-language upload is
    // sized against its original, not against whichever dub encoded loudest
    isOriginalTrack(format) ? 0 : 1,
    -(Number(format.quality) || 0),
    container === "mp4" && family !== MP4_ACODEC ? 1 : 0,
    preference === -1 ? ACODEC_PREFERENCE.length : preference,
    -(formatSize(format) || 0),
    -audioRate(format)
  ]
}

/**
 * the audio stream a merge really pulls in - its bytes belong in the tier size
 *
 * getting this wrong is a visible lie, and the two ways to get it wrong are
 * both real. verified against 2026.08.19 on a 22-language upload:
 *
 * - `-t mp4 -S res:1080` merges the original-language **aac** stream, not the
 *   opus one that tops the bitrate list (3.3 MB apart)
 * - `-t mkv` merges the original-language **opus** stream, not the loudest dub
 *   (4.4 MB apart)
 *
 * @param {Object[]} formats - the whole format list
 * @param {string} container - mp4 | mkv
 * @returns {Object|null} the format whose bytes to add, or null when there is none
 */
function pickBestAudio(formats, container) {
  const audioOnly = audioOnlyFormats(formats)

  if (audioOnly.length === 0) {
    return null
  }

  return audioOnly.reduce((best, format) =>
    isBetterRank(audioRank(format, container), audioRank(best, container))
      ? format
      : best
  )
}

// true when `a` sorts ahead of `b`; equal ranks keep whichever came first
function isBetterRank(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i]
    }
  }

  return false
}

// the track youtube recorded in, which is the one a download gets when nobody
// asks for anything. `language_preference: 10` is how yt-dlp marks it - the
// `format_note` says "English original (default)", but that string is a label
// in the video's own wording and not something to parse
const ORIGINAL_LANGUAGE_PREFERENCE = 10

function isOriginalTrack(format) {
  return Number(format.language_preference) === ORIGINAL_LANGUAGE_PREFERENCE
}

// yt-dlp reports no language at all on a video that was never dubbed, and a
// language of "none" on some extractors - neither is a code we can ask for
function trackLanguage(format) {
  const code = String(format.language == null ? "" : format.language).trim()

  return code && code.toLowerCase() !== "none" ? code : null
}

// the https formats carry a filesize and win yt-dlp's own `proto` sort; the
// m3u8 duplicates of the same height carry neither
function isProgressive(format) {
  return !String(format.protocol || "").includes("m3u8")
}

// lower sorts better, compared left to right - the same order yt-dlp applies
function streamRank(format) {
  const index = VCODEC_PREFERENCE.indexOf(codecFamily(format.vcodec))

  return [
    index === -1 ? VCODEC_PREFERENCE.length : index,
    isProgressive(format) ? 0 : 1,
    -(Number(format.tbr) || 0)
  ]
}

// ties keep `a`, which is the accumulator when this reduces a group
function betterStream(a, b) {
  return isBetterRank(streamRank(b), streamRank(a)) ? b : a
}

/**
 * the real quality ladder, straight out of the format list yt-dlp already gave us
 *
 * dropping `vcodec === "none"` is the whole of the curation: it takes the
 * storyboard entries (sb0-sb3, which report heights like 27 and 45) and the
 * audio-only formats with it, and what is left is a clean 144->2160 ladder.
 *
 * @param {Object} info - parsed --dump-json payload
 * @returns {Object[]} [{height, container, filesize, fps}], highest first
 */
function extractQualityTiers(info) {
  const formats = Array.isArray(info && info.formats) ? info.formats : []

  const videoFormats = formats.filter(
    (format) =>
      format &&
      format.vcodec &&
      format.vcodec !== "none" &&
      Number.isFinite(Number(format.height)) &&
      Number(format.height) > 0
  )

  // one pick per container, not one overall: which stream a merge really adds
  // depends on the container the tier promises. no audio stream at all means a
  // merge adds nothing (0); one whose size yt-dlp never reported means it adds
  // an unknown number of bytes (null)
  const audioSizeFor = new Map(
    ["mp4", "mkv"].map((container) => {
      const audio = pickBestAudio(formats, container)

      return [container, audio ? formatSize(audio) : 0]
    })
  )

  const byHeight = new Map()
  for (const format of videoFormats) {
    const height = Math.round(Number(format.height))
    const group = byHeight.get(height)
    if (group) {
      group.push(format)
    } else {
      byHeight.set(height, [format])
    }
  }

  const tiers = []

  for (const [height, group] of byHeight) {
    // container is data-driven: mp4 only where an h264 stream really exists
    const h264 = group.filter((format) => codecFamily(format.vcodec) === MP4_CODEC)
    const container = h264.length > 0 ? "mp4" : "mkv"
    const chosen = (h264.length > 0 ? h264 : group).reduce(betterStream)

    const videoSize = formatSize(chosen)
    const muxed = Boolean(chosen.acodec && chosen.acodec !== "none")
    // a pre-muxed stream already carries its audio, so nothing is added to it
    const audioSize = muxed ? 0 : audioSizeFor.get(container)
    const fps = Math.round(Number(chosen.fps))

    tiers.push({
      height,
      container,
      // either half unknown makes the total unknown. adding a missing audio
      // size as 0 would dress a video-only figure up as the download's cost,
      // and a confident wrong number is worse than no number at all
      filesize:
        videoSize === null || audioSize === null ? null : videoSize + audioSize,
      fps: Number.isFinite(fps) && fps > 0 ? fps : null
    })
  }

  // the menu reads top down, best first
  return tiers.sort((a, b) => b.height - a.height)
}

/**
 * the dubbed audio languages this video carries, if it carries more than one
 *
 * a dubbed video returns one audio track per language - 22 of them on a MrBeast
 * upload - and handing the user whichever one yt-dlp picks is not a preference,
 * it is the wrong file. so the languages come out of the format list the same
 * way the quality ladder does.
 *
 * **an empty array means "there is no choice here"**, not "we found nothing":
 * a video with one language (or none, which is what an undubbed video reports)
 * has nothing to pick between, and that is nearly every video. the renderer
 * shows no picker at all in that case and the download args are untouched.
 *
 * @param {Object} info - parsed --dump-json payload
 * @returns {Object[]} [{code, is_original}], original first, or [] when there
 *   are fewer than two languages
 */
function extractAudioTracks(info) {
  const formats = Array.isArray(info && info.formats) ? info.formats : []

  const byCode = new Map()

  for (const format of audioOnlyFormats(formats)) {
    const code = trackLanguage(format)
    if (!code) continue

    // one language has several formats (low/medium, drc and not) and the
    // original marker only has to appear on one of them
    const existing = byCode.get(code)
    if (existing) {
      existing.is_original = existing.is_original || isOriginalTrack(format)
    } else {
      byCode.set(code, { code, is_original: isOriginalTrack(format) })
    }
  }

  if (byCode.size < 2) {
    return []
  }

  const tracks = [...byCode.values()]

  // the original is what the user gets today, so it heads the list and is what
  // the picker opens on; the rest keep the order the extractor listed them in
  return [
    ...tracks.filter((track) => track.is_original),
    ...tracks.filter((track) => !track.is_original)
  ]
}

module.exports = {
  extractQualityTiers,
  extractAudioTracks
}
