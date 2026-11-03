// Existing native CI entry point now checks the upstream media procedure.
const { runNative } = require("./smoke-losslesscut-parity")
module.exports = { runNative }
if (require.main === module) {
  const [directory, ffmpeg, ffprobe] = process.argv.slice(2)
  runNative({ directory, ffmpeg, ffprobe }).then(result => {
    require("node:fs").writeFileSync(require("node:path").join(directory, "segments-evidence.json"), JSON.stringify(result, null, 2))
    console.log(`LosslessCut parity: ${result.cases.length} joined outputs; cancellation passed`)
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
