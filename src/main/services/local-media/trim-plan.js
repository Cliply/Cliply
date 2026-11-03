const { MediaError } = require("./errors")
const { startProbe, probeArgs } = require("./probe")
const { trackSupported } = require("./export-plan")

const MAX_PACKETS = 8192
const WINDOW_SECONDS = 60
const EPSILON = 0.000002
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
  const maxStart = matroskaInput ? 0.1 : 0.001
  if ([source, ...source.streams].some(item => (item.startTime == null && family === "mov") || Math.abs(item.startTime ?? 0) > maxStart)) fail("TRIM_TIMING")
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

function packetArgs(sourcePath, streamIndex, from, to) {
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0 || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > WINDOW_SECONDS) fail("TRIM_TIMING")
  const args = probeArgs(sourcePath)
  return [...args.slice(0, args.indexOf("-of")), "-select_streams", String(streamIndex), "-read_intervals", `${from.toFixed(6)}%${to.toFixed(6)}`,
    "-show_packets", "-show_entries", "packet=pts_time,dts_time,duration_time,flags", "-of", "json", "-i", sourcePath]
}
function normalizePackets(raw) {
  if (!raw || !Array.isArray(raw.packets) || !raw.packets.length) fail("TRIM_TIMING")
  if (raw.packets.length > MAX_PACKETS) fail("PROBE_LIMIT")
  const numeric = value => typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null
  const packets = raw.packets.map(packet => ({ pts: numeric(packet?.pts_time), dts: numeric(packet?.dts_time), duration: numeric(packet?.duration_time), key: typeof packet?.flags === "string" && packet.flags.startsWith("K") }))
  // Matroska can omit DTS on the leading reordered pictures. Reconstruct
  // only that bounded prefix from the first known DTS and packet durations;
  // missing timestamps anywhere else remain an ambiguity and are refused.
  const known = packets.findIndex(packet => packet.dts !== null)
  if (known > 0 && known <= 16) {
    for (let i = known - 1; i >= 0; i--) {
      if (!(packets[i].duration > 0 && packets[i].duration <= 0.1)) fail("TRIM_TIMING")
      packets[i].dts = packets[i + 1].dts - packets[i].duration
    }
  }
  if (packets.some(packet => packet.pts === null || packet.dts === null || packet.duration === null || packet.duration <= 0 || packet.duration > 0.1 || Math.abs(packet.pts - packet.dts) > 0.5)) fail("TRIM_TIMING")
  if (packets.some((packet, index) => index > 0 && packet.dts <= packets[index - 1].dts)) fail("TRIM_TIMING")
  const times = packets.map(packet => packet.pts)
  if (Math.max(...times) - Math.min(...times) > WINDOW_SECONDS + 1) fail("TRIM_TIMING")
  return packets
}
function startPacketProbe(executable, sourcePath, streamIndex, from, to, options = {}) {
  return startProbe(executable, sourcePath, { ...options, timeoutMs: 15000, maxOutput: 2 * 1024 * 1024,
    args: packetArgs(sourcePath, streamIndex, from, to), normalize: normalizePackets })
}
function timingWindows(source, request, profile) {
  const around = (time, radius) => ({ from: Math.max(0, time - radius), to: Math.min(source.duration + 0.1, time + radius) })
  return [around(request.start + profile.origin, profile.hasVideo ? 20 : 2), around(request.end + profile.origin, 2)]
}
function planTrimTiming(source, request, startPackets, endPackets) {
  const profile = validateTrimRequest(source, request)
  const relative = packets => packets.map(packet => ({ ...packet, pts: packet.pts - profile.origin, dts: packet.dts - profile.origin }))
  const first = relative(startPackets), last = relative(endPackets)
  let plannedStart, plannedEnd
  if (profile.hasVideo) {
    const keys = first.filter(packet => packet.key).map(packet => packet.pts).sort((a, b) => a - b)
    plannedStart = request.mode === "before" ? keys.filter(time => time <= request.start + EPSILON).at(-1) : keys.find(time => time >= request.start - EPSILON)
    if (plannedStart == null || Math.abs(plannedStart - request.start) > 10) fail("TRIM_KEYFRAME")
    plannedStart = Math.max(0, plannedStart)
  } else if (profile.pcm) plannedStart = request.start
  else plannedStart = first.filter(packet => packet.pts >= request.start - EPSILON).sort((a, b) => a.pts - b.pts)[0]?.pts
  if (!Number.isFinite(plannedStart) || request.end - plannedStart < 0.1 - 1e-9) fail("TRIM_RANGE")
  const eof = Math.abs(request.end - source.duration) < EPSILON
  const tail = last.filter(packet => packet.dts < request.end - EPSILON && packet.pts >= plannedStart - EPSILON)
  if (!tail.length || (!eof && !last.some(packet => packet.dts >= request.end - EPSILON))) fail("TRIM_TIMING")
  if (profile.pcm) {
    const block = first[0].duration
    plannedEnd = eof ? source.duration : Math.min(source.duration, plannedStart + Math.ceil((request.end - plannedStart) / block) * block)
  } else plannedEnd = Math.max(...tail.map(packet => packet.pts + packet.duration))
  const tolerance = profile.hasVideo ? 0.5 : profile.pcm ? 0.1 : 0.05
  if (Math.abs(plannedEnd - request.end) > tolerance || plannedEnd <= plannedStart) fail("TRIM_TIMING")
  // No FPS multiplication: presentation/decode packet times include B-frame
  // reordering and VFR. End is an estimate of retained presentation extent.
  return { operation: "trim", sourceId: source.sourceId, ...profile,
    majorBrand: source.majorBrand, requestedStart: request.start, requestedEnd: request.end, mode: request.mode,
    plannedStart, plannedEnd, tolerance, eof, previewId: request.previewId,
    seekStart: profile.hasVideo ? plannedStart : request.start,
    duration: request.end - (profile.hasVideo ? plannedStart : request.start),
    expectedStreams: source.streams, streamIndexes: source.streams.map(stream => stream.index), fileTags: source.tags || {}, expectedChapters: [] }
}

// Decode only a bounded leading window to check that a packet marked keyframe
// is also a usable starting picture. Any decoder error refuses the plan/output.
function startFrameProbe(executable, sourcePath, streamIndex, start, options = {}) {
  const base = packetArgs(sourcePath, streamIndex, start ? start + EPSILON : 0, start + 0.5)
  const args = base.map(arg => arg === "-show_packets" ? "-show_frames" : arg === "packet=pts_time,dts_time,duration_time,flags" ? "frame=best_effort_timestamp_time,key_frame" : arg)
  return startProbe(executable, sourcePath, { ...options, args, timeoutMs: 10000, maxOutput: 65536, maxStderr: 0,
    normalize: raw => {
      if (!Array.isArray(raw?.frames) || !raw.frames.length || raw.frames.length > 128) fail("TRIM_TIMING")
      const first = raw.frames[0]
      const time = typeof first.best_effort_timestamp_time === "string" ? Number(first.best_effort_timestamp_time) : NaN
      if (!Number.isFinite(time) || first.key_frame !== 1) fail("TRIM_TIMING")
      return { firstTime: time }
    } })
}
module.exports = { trimProfile, validateTrimRequest, packetArgs, normalizePackets, startPacketProbe, startFrameProbe, timingWindows, planTrimTiming, MAX_PACKETS, WINDOW_SECONDS }
