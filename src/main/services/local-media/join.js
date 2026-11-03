const path = require("node:path")
const { exportArgs } = require("./export-plan")
const { MediaError } = require("./errors")

function concatManifest(directory, cuts) {
  const count = cuts.length
  // Only internally reserved names. Never consume a user playlist/manifest.
  if (!Number.isInteger(count) || count < 2 || count > 32 || /[\r\n\0]/.test(directory)) throw new MediaError("OUTPUT_PATH")
  return "ffconcat version 1.0\n" + Array.from({ length: count }, (_, i) =>
    `file 'file:${path.join(directory, `part-${i}.partial`).replace(/'/g, "'\\''")}'\nduration ${(cuts[i].plannedEnd - cuts[i].plannedStart).toFixed(6)}\n`).join("")
}
function concatArgs(plan) {
  const streams = plan.expectedStreams.map((stream, index) => ({ ...stream, index }))
  const args = exportArgs({ ...plan, operation: "removeTracks", expectedStreams: streams, movInput: false })
  // The demuxer already rebases each part. Preserve its zero-based video
  // timeline instead of shifting it by the first AAC priming packet.
  args.unshift("-copyts")
  const input = args.indexOf("-fd")
  args.splice(input, 0, "-f", "concat", "-safe", "0")
  args[args.indexOf("-format_whitelist") + 1] += ",concat"
  // Concat does not propagate global tags. Explicitly restore the allowlisted
  // tags captured from the original, while stream tags come from each part.
  args.splice(args.indexOf("-progress"), 0, ...Object.entries(plan.fileTags).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]))
  return args
}
module.exports = { concatManifest, concatArgs }
