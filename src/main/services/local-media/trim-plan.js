const { MediaError } = require("./errors")
const { trackSupported } = require("./export-plan")

const fail = code => { throw new MediaError(code) }

function trimProfile(source) {
  if (!source || !Number.isFinite(source.duration) || source.duration <= 0) fail("TRIM_PROFILE")
  if (source.chapterCount) fail("TRIM_CHAPTERS")
  if (!source.streams.length || source.streams.length > 17) fail("TRIM_STREAMS")
  const videos = source.streams.filter(stream => stream.type === "video")
  const audio = source.streams.filter(stream => stream.type === "audio")
  if (videos.length > 1 || audio.length > 16 || (!videos.length && audio.length > 1) || videos.length + audio.length !== source.streams.length) fail("TRIM_STREAMS")
  const matroskaInput = source.contentContainer === "mkv"
  let extension, muxer, family
  if (["mp4", "mov"].includes(source.contentContainer)) {
    extension = muxer = source.contentContainer; family = "mov"
  } else if (source.contentContainer === "mkv" && videos.length === 1) {
    extension = muxer = "mp4"; family = "mov"
  } else if (!videos.length && audio.length === 1) {
    if (source.formatNames.includes("wav") && audio[0].codec === "pcm_s16le") extension = muxer = family = "wav"
    else if (source.formatNames.includes("mov") && source.majorBrand === "M4A" && audio[0].codec === "aac") { extension = "m4a"; muxer = "ipod"; family = "mov" }
  }
  if (!extension) fail("TRIM_CONTAINER")
  for (const stream of source.streams) {
    if (stream.type === "video" && (stream.codec !== "h264" || stream.pixelFormat !== "yuv420p" || stream.hasHdrMetadata)) fail("TRIM_VIDEO")
    if (stream.type === "audio" && family === "mov" && (stream.codec !== "aac" || !["LC", "HE-AAC"].includes(stream.profile) || ![44100, 48000].includes(stream.sampleRate) || ![1, 2].includes(stream.channels))) fail("TRIM_AUDIO")
    if (family === "mov") {
      if (!trackSupported({ extension }, stream) || (family === "mov" && !source.streams.some(other => other.type === stream.type && other.disposition?.default)) ||
          Object.entries(stream.disposition).some(([flag, value]) => value && flag !== "default")) fail("TRIM_PROFILE")
    } else if (stream.titleCopySafe === false || Object.values(stream.disposition || {}).some(Boolean)) fail("TRIM_PROFILE")
    if (stream.type === "audio" && (![44100, 48000].includes(stream.sampleRate) || ![1, 2].includes(stream.channels))) fail("TRIM_PROFILE")
  }
  if (family === "mov" && audio.some(stream => stream.codec !== "aac" || !["LC", "HE-AAC"].includes(stream.profile))) fail("TRIM_PROFILE")
  return { extension, muxer, family, hasVideo: videos.length === 1, pcm: audio[0]?.codec === "pcm_s16le",
    streamIndex: (videos[0] || audio[0]).index, origin: matroskaInput ? videos[0].startTime ?? 0 : source.startTime ?? 0,
    matroskaInput, inputStart: source.startTime ?? 0, bFrames: videos[0]?.bFrames ?? 0, movInput: family === "mov" && !matroskaInput }
}

function validateTrimRequest(source, request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "end,mode,previewId,sourceId,start" ||
      !["before", "after"].includes(request.mode) || typeof request.previewId !== "string" || !/^[a-f0-9]{64}$/.test(request.previewId) ||
      typeof request.start !== "number" || typeof request.end !== "number" || !Number.isFinite(request.start) || !Number.isFinite(request.end)) fail("REQUEST_INVALID")
  if (!source || request.sourceId !== source.sourceId) fail("SOURCE_UNKNOWN")
  const profile = trimProfile(source)
  if (request.start < 0 || request.end > source.duration || request.end - request.start < 0.1 - 1e-9) fail("TRIM_RANGE")
  return profile
}

// LosslessCut passes the requested times to FFmpeg. Keyframe alignment belongs
// to the demuxer; do not replace these times with our own packet-window estimate.
function planLosslessCut(source, request) {
  const profile = validateTrimRequest(source, request)
  return { operation: "trim", method: "losslesscut", sourceId: source.sourceId, ...profile,
    majorBrand: source.majorBrand, requestedStart: request.start, requestedEnd: request.end,
    plannedStart: request.start, plannedEnd: request.end, mode: request.mode,
    eof: request.end >= source.duration, previewId: request.previewId,
    duration: request.end - request.start, expectedStreams: source.streams,
    streamIndexes: source.streams.map(stream => stream.index), fileTags: source.tags || {}, expectedChapters: [] }
}

module.exports = { planLosslessCut, trimProfile, validateTrimRequest }
