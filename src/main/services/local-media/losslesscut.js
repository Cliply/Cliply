// Supported single-input subset of LosslessCut's losslessCutSingle/concatFiles.
// Upstream: mifi/lossless-cut@6fc47dd4cc81b72a8f1b3132c47a99880cd9bbdb
// See third-party/losslesscut/README.md for provenance and integration boundaries.
const number = value => value.toFixed(6)

// Container/network access restrictions wrap upstream's media procedure.
function inputFlags(plan) {
  return ["-protocol_whitelist", "fd,file,pipe", "-format_whitelist", "mov,matroska,webm,wav,mp3,aac",
    ...(plan.movInput ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : [])]
}
function outputFlags(muxer) {
  if (["mp4", "mov", "ipod"].includes(muxer)) return ["-movflags", "+faststart"]
  if (muxer === "matroska") return ["-default_mode", "infer_no_subs"]
  return []
}

function mapStreams(streams, { dispositions = false } = {}) {
  return streams.flatMap((stream, index) => ["-map", `0:${stream.index}`, `-c:${index}`, "copy",
    ...(stream.title ? [`-metadata:s:${index}`, `title=${stream.title}`] : []),
    ...(dispositions ? [`-disposition:${index}`, Object.entries(stream.disposition || {}).filter(([, value]) => value).map(([key]) => key).join("+") || "0"] : [])])
}

function cutArgs(plan, input = [...inputFlags(plan), "-fd", "0", "-i", "fd:"], output = ["-fd", "1", "fd:"]) {
  const cuttingStart = plan.requestedStart > 0
  const keyframeCut = plan.mode === "before"
  const compensation = keyframeCut && cuttingStart && plan.matroskaInput && plan.bFrames > 0 ? 3 / 23 + 0.001 : 0
  const seek = cuttingStart ? ["-ss", number(plan.requestedStart + compensation)] : []
  const duration = Math.max(plan.requestedEnd - plan.requestedStart, 1 / (plan.fps || 30))
  return ["-hide_banner", "-nostdin",
    ...(keyframeCut ? [...seek, ...(compensation ? ["-itsoffset", number(compensation)] : [])] : []),
    ...input,
    ...(!keyframeCut ? seek : []),
    ...(!plan.eof ? ["-t", number(duration)] : []),
    ...(cuttingStart && keyframeCut ? ["-avoid_negative_ts", "make_zero"] : []),
    ...(cuttingStart && !keyframeCut && !plan.hasVideo ? ["-copyinkf"] : []),
    ...mapStreams(plan.expectedStreams), "-map_metadata", "0", "-map_chapters", "-1",
    ...outputFlags(plan.muxer), "-ignore_unknown", "-progress", "pipe:2", "-nostats", "-f", plan.muxer, ...output]
}

function mergeArgs(plan, metadataPath, outputPath) {
  return ["-hide_banner", "-nostdin", "-f", "concat", "-safe", "0", "-protocol_whitelist", "file,pipe,fd", "-fd", "0", "-i", "fd:",
    ...(metadataPath ? ["-i", metadataPath] : []),
    ...mapStreams(plan.expectedStreams.map((stream, index) => ({ ...stream, index })), { dispositions: true }),
    ...(metadataPath ? ["-map_metadata", "1"] : []), "-map_chapters", "-1",
    ...outputFlags(plan.muxer), "-ignore_unknown", "-progress", "pipe:2", "-nostats", "-f", plan.muxer, ...(outputPath ? ["-y", outputPath] : ["-fd", "1", "fd:"])]
}

function fullFileArgs(plan, outputPath) {
  const output = outputPath ? ["-y", outputPath] : ["-fd", "1", "fd:"]
  // extractNonAttachmentStreams uses FFmpeg's default metadata mapping.
  if (plan.operation === "extractAudio") return ["-hide_banner", "-nostdin", ...inputFlags(plan), "-fd", "0", "-i", "fd:",
    "-map", `0:${plan.streamIndex}`, "-c", "copy", "-progress", "pipe:2", "-nostats", "-f", plan.muxer, ...output]
  // losslessCutSingle with no cut boundaries, selected tracks and the user's
  // chapter decision. Explicit dispositions preserve the selected track flags.
  return ["-hide_banner", "-nostdin", ...inputFlags(plan), "-fd", "0", "-i", "fd:",
    ...mapStreams(plan.expectedStreams, { dispositions: true }), "-map_metadata", "0",
    "-map_chapters", plan.expectedChapters?.length ? "0" : "-1", ...outputFlags(plan.muxer), "-ignore_unknown",
    "-progress", "pipe:2", "-nostats", "-f", plan.muxer, ...output]
}

module.exports = { cutArgs, mergeArgs, fullFileArgs, mapStreams, outputFlags }
