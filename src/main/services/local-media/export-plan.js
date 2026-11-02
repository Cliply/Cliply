const { MediaError } = require("./errors")

// Deliberately narrow, copy-only profiles. No generic codec/container fallback.
function audioProfile(source, stream) {
  const families = source.formatNames || []
  if (stream.type !== "audio" || !Number.isSafeInteger(stream.sampleRate) || stream.sampleRate <= 0 || ![1, 2].includes(stream.channels)) return null
  if (stream.codec === "aac" && stream.profile === "LC" && families.some(f => ["mov", "matroska", "aac"].includes(f))) return { extension: "aac", muxer: "adts" }
  if (stream.codec === "mp3" && families.some(f => ["mp3", "matroska"].includes(f))) return { extension: "mp3", muxer: "mp3" }
  if (stream.codec === "pcm_s16le" && families.some(f => ["wav", "mov", "matroska"].includes(f))) return { extension: "wav", muxer: "wav" }
  return null
}

function planAudio(source, request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "operation,sourceId,streamIndex" ||
      request.operation !== "extractAudio" || !Number.isSafeInteger(request.streamIndex) || request.streamIndex < 0) throw new MediaError("REQUEST_INVALID")
  if (!source || request.sourceId !== source.sourceId) throw new MediaError("SOURCE_UNKNOWN")
  const stream = source.streams.find(s => s.index === request.streamIndex)
  const profile = stream && audioProfile(source, stream)
  const duration = stream?.duration ?? source.duration
  if (!profile || !Number.isFinite(duration) || duration <= 0) throw new MediaError("AUDIO_UNSUPPORTED")
  return { operation: "extractAudio", sourceId: source.sourceId, streamIndex: stream.index,
    codec: stream.codec, language: stream.language, title: stream.title, sampleRate: stream.sampleRate,
    channels: stream.channels, duration, movInput: source.formatNames.includes("mov"), ...profile }
}

function exportArgs(plan) {
  return ["-hide_banner", "-nostdin", "-v", "error", "-max_alloc", "67108864",
    "-protocol_whitelist", "fd,file,pipe", "-format_whitelist", "mov,matroska,webm,wav,mp3,aac",
    ...(plan.movInput ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    "-probesize", "5000000", "-analyzeduration", "5000000", "-max_streams", "128",
    // Inherited regular-file descriptors are seekable; FFmpeg never opens a
    // renderer path, the selected source path or a final output path.
    "-fd", "0", "-i", "fd:", "-map", `0:${plan.streamIndex}`, "-c", "copy",
    "-map_metadata", "-1", "-map_metadata:s:a", "-1", "-map_chapters", "-1",
    "-progress", "pipe:2", "-nostats", "-f", plan.muxer, "-fd", "1", "fd:"]
}

function validateOutput(plan, metadata, bytes) {
  const stream = metadata.streams[0]
  const family = plan.extension === "aac" ? "aac" : plan.extension
  const duration = stream?.duration ?? metadata.duration
  if (bytes <= 0 || metadata.streams.length !== 1 || stream?.type !== "audio" ||
      stream.codec !== plan.codec || stream.sampleRate !== plan.sampleRate || stream.channels !== plan.channels ||
      !metadata.formatNames.includes(family) || metadata.chapterCount !== 0 ||
      !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - plan.duration) > Math.max(0.25, plan.duration * 0.02)) throw new MediaError("OUTPUT_INVALID")
}

module.exports = { audioProfile, planAudio, exportArgs, validateOutput }
