const { MediaError } = require("./errors")
const path = require("node:path")

function trackContainer(source) {
  const extension = path.extname(source.filename || "").slice(1).toLowerCase()
  if (extension === "mkv" && source.formatNames.includes("matroska")) return { extension, muxer: "matroska" }
  if (!source.formatNames.includes("mov")) return null
  if (extension === "mov" && source.majorBrand === "qt") return { extension, muxer: "mov" }
  if (extension === "mp4" && ["isom", "iso2", "mp41", "mp42", "avc1"].includes(source.majorBrand)) return { extension, muxer: "mp4" }
  return null // a demuxer-family label alone does not prove the source container
}

function trackSupported(container, stream) {
  if (stream.titleCopySafe === false) return false
  if (Object.entries(stream.disposition || {}).some(([key, value]) => value === 1 && !["default", "forced"].includes(key))) return false
  if (stream.language && !/^[a-z]{3}$/i.test(stream.language)) return false
  if (stream.type === "video") return stream.codec === "h264" && stream.pixelFormat === "yuv420p" &&
    Number.isSafeInteger(stream.width) && stream.width > 0 && Number.isSafeInteger(stream.height) && stream.height > 0 &&
    !stream.hasHdrMetadata && [null, undefined, "unknown", "bt709", "smpte170m", "bt470bg"].includes(stream.colorTransfer) &&
    [null, undefined, "unknown", "bt709", "smpte170m", "bt470bg"].includes(stream.colorPrimaries) &&
    [0, 90, -90, 180, -180, 270].includes(stream.rotation ?? 0) && (container.extension !== "mkv" || !stream.rotation)
  if (stream.type === "audio") return stream.codec === "aac" && stream.profile === "LC" &&
    Number.isSafeInteger(stream.sampleRate) && stream.sampleRate > 0 && [1, 2].includes(stream.channels)
  return stream.type === "subtitle" && stream.codec === (container.extension === "mkv" ? "subrip" : "mov_text")
}

function trackRemovalProfile(source) {
  const container = trackContainer(source)
  if (!container || !Number.isFinite(source.duration) || source.duration <= 0) return null
  return { extension: container.extension, supportedStreamIndexes: source.streams.filter(stream => trackSupported(container, stream)).map(stream => stream.index) }
}

function planTracks(source, request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "operation,removeChapters,sourceId,streamIndexes" ||
      request.operation !== "removeTracks" || typeof request.removeChapters !== "boolean" ||
      !Array.isArray(request.streamIndexes) || request.streamIndexes.length > 128 ||
      request.streamIndexes.some(index => !Number.isSafeInteger(index) || index < 0) ||
      new Set(request.streamIndexes).size !== request.streamIndexes.length) throw new MediaError("REQUEST_INVALID")
  if (!source || request.sourceId !== source.sourceId) throw new MediaError("SOURCE_UNKNOWN")
  const container = trackContainer(source)
  if (!container || !Number.isFinite(source.duration) || source.duration <= 0) throw new MediaError("TRACK_CONTAINER")
  const selected = source.streams.filter(stream => request.streamIndexes.includes(stream.index)).sort((a, b) => a.index - b.index)
  if (selected.length !== request.streamIndexes.length) throw new MediaError("REQUEST_INVALID")
  if (!selected.some(stream => ["video", "audio"].includes(stream.type) && !stream.disposition?.attached_pic)) throw new MediaError("TRACK_EMPTY")
  if (selected.some(stream => !trackSupported(container, stream))) throw new MediaError("TRACK_UNSUPPORTED")
  if (selected.filter(stream => stream.type === "video").length > 1) throw new MediaError("TRACK_VIDEO_LIMIT")
  if (source.chapterCount > 0 && !request.removeChapters) throw new MediaError("TRACK_CHAPTERS")
  // MOV/MP4 promotes the first remaining track of a type when none is default.
  // Refuse that unrequested disposition change; Matroska supports passthrough.
  if (container.extension !== "mkv" && selected.some(stream => !selected.some(other => other.type === stream.type && other.disposition?.default))) throw new MediaError("TRACK_DEFAULT")
  const duration = Math.max(...selected.filter(stream => ["video", "audio"].includes(stream.type)).map(stream => stream.duration ?? source.duration))
  if (!Number.isFinite(duration) || duration <= 0) throw new MediaError("TRACK_CONTAINER")
  return { operation: "removeTracks", sourceId: source.sourceId, streamIndexes: selected.map(stream => stream.index),
    removeChapters: request.removeChapters, removedStreamIndexes: source.streams.filter(stream => !request.streamIndexes.includes(stream.index)).map(stream => stream.index),
    duration,
    expectedStreams: selected, fileTags: source.tags || {}, movInput: container.extension !== "mkv", ...container }
}

function planExport(source, request) { return request?.operation === "removeTracks" ? planTracks(source, request) : planAudio(source, request) }

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
  const streams = plan.operation === "removeTracks" ? plan.expectedStreams : null
  const maps = streams ? streams.flatMap(stream => ["-map", `0:${stream.index}`]) : ["-map", `0:${plan.streamIndex}`]
  const metadata = streams ? ["-map_metadata", "0", ...streams.flatMap((stream, outputIndex) => [
    `-map_metadata:s:${outputIndex}`, `0:s:${stream.index}`,
    ...(stream.title ? [`-metadata:s:${outputIndex}`, `title=${stream.title}`] : []),
    `-disposition:${outputIndex}`, ["default", "forced"].filter(flag => stream.disposition?.[flag]).join("+") || "0"
  ]), ...(plan.muxer === "matroska" ? ["-default_mode", "passthrough"] : [])] : ["-map_metadata", "-1", "-map_metadata:s:a", "-1"]
  return ["-hide_banner", "-nostdin", "-v", "error", "-max_alloc", "67108864",
    "-protocol_whitelist", "fd,file,pipe", "-format_whitelist", "mov,matroska,webm,wav,mp3,aac",
    ...(plan.movInput ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    "-probesize", "5000000", "-analyzeduration", "5000000", "-max_streams", "128",
    // Inherited regular-file descriptors are seekable; FFmpeg never opens a
    // renderer path, the selected source path or a final output path.
    "-fd", "0", "-i", "fd:", ...maps, "-c", "copy", ...metadata, "-map_chapters", "-1",
    "-progress", "pipe:2", "-nostats", "-f", plan.muxer, "-fd", "1", "fd:"]
}

function validateOutput(plan, metadata, bytes) {
  if (plan.operation === "removeTracks") return validateTracks(plan, metadata, bytes)
  const stream = metadata.streams[0]
  const family = plan.extension === "aac" ? "aac" : plan.extension
  const duration = stream?.duration ?? metadata.duration
  if (bytes <= 0 || metadata.streams.length !== 1 || stream?.type !== "audio" ||
      stream.codec !== plan.codec || stream.sampleRate !== plan.sampleRate || stream.channels !== plan.channels ||
      !metadata.formatNames.includes(family) || metadata.chapterCount !== 0 ||
      !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - plan.duration) > Math.max(0.25, plan.duration * 0.02)) throw new MediaError("OUTPUT_INVALID")
}

function validateTracks(plan, metadata, bytes) {
  const fail = () => { throw new MediaError("OUTPUT_INVALID") }
  const duration = metadata.duration
  if (bytes <= 0 || metadata.streams.length !== plan.expectedStreams.length || metadata.chapterCount !== 0 ||
      !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - plan.duration) > Math.max(0.25, plan.duration * 0.02) ||
      trackContainer({ ...metadata, filename: `output.${plan.extension}` })?.extension !== plan.extension) fail()
  const containsTags = (before, after) => Object.entries(before || {}).every(([key, value]) => after?.[key] === value)
  if (!containsTags(plan.fileTags, metadata.tags)) fail()
  plan.expectedStreams.forEach((before, index) => {
    const after = metadata.streams[index]
    const same = keys => keys.every(key => (before[key] ?? null) === (after[key] ?? null))
    const angle = value => ((value ?? 0) % 360 + 360) % 360
    if (after.index !== index || !same(["type", "codec", "title"]) ||
        (before.language || "und") !== (after.language || "und") || !containsTags(before.tags, after.tags) ||
        Object.entries(after.disposition || {}).some(([flag, value]) => value === 1 && before.disposition?.[flag] !== 1) ||
        ["default", "forced"].some(flag => (before.disposition?.[flag] || 0) !== (after.disposition?.[flag] || 0))) fail()
    if (before.type === "video" && (!same(["width", "height", "pixelFormat", "colorTransfer", "colorPrimaries", "hasHdrMetadata"]) || angle(before.rotation) !== angle(after.rotation))) fail()
    if (before.type === "audio" && !same(["profile", "sampleRate", "channels"])) fail()
  })
}

module.exports = { audioProfile, planAudio, planTracks, planExport, trackRemovalProfile, exportArgs, validateOutput }
