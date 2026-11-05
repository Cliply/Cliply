const path = require("node:path")
const { mergeArgs } = require("./losslesscut")
const { MediaError } = require("./errors")

function concatManifest(directory, cuts) {
  const count = cuts.length
  // Only internally reserved names. Never consume a user playlist/manifest.
  if (!Number.isInteger(count) || count < 2 || count > 32 || /[\r\n\0]/.test(directory)) throw new MediaError("OUTPUT_PATH")
  return "ffconcat version 1.0\n" + Array.from({ length: count }, (_, i) =>
    `file 'file:${path.join(directory, `part-${i}.partial`).replace(/'/g, "'\\''")}'\n`).join("")
}
function concatArgs(plan, metadataPath, outputPath) {
  return mergeArgs(plan, metadataPath, outputPath)
}
module.exports = { concatManifest, concatArgs }
