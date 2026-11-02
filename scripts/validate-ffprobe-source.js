// Separate source-built evaluation entry; does not select supplier candidates.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process"), { parseArgs } = require("node:util")
const { build, sourcePin } = require("./build-ffprobe-prototype")
const { packageSource, stageInstalledNotices } = require("./package-ffprobe-source")
const { validate } = require("./validate-ffprobe-candidate")
const { retainCandidate, collectRuntimeNotices } = require("./retain-ffprobe-candidate")
async function validateSource({ source, evidence, retain }) {
  assert(evidence && path.isAbsolute(evidence), "pass a new absolute --evidence directory")
  assert(!retain || (path.isAbsolute(retain) && !fs.existsSync(retain)), "retention needs a new absolute directory")
  fs.mkdirSync(evidence)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-source-check-")), output = path.join(scratch, "build")
  const acquisition = []
  try {
    if (!source) {
      source = path.join(scratch, "upstream"); fs.mkdirSync(source)
      for (const args of [["init", source], ["-C", source, "remote", "add", "origin", sourcePin.source], ["-C", source, "fetch", "--depth", "1", "origin", sourcePin.commit], ["-C", source, "checkout", "--detach", "FETCH_HEAD"]]) {
        const result = spawnSync("git", args, { encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024 })
        acquisition.push({ args, status: result.status, output: (result.stdout || "") + (result.stderr || "") })
        assert.equal(result.status, 0, result.stderr || result.error?.message)
      }
    }
    build({ source, output })
    let noticeRecord, packetDirectory
    // Preserve small runtime inputs even if a later UI check fails. Failed
    // validation still cannot retain a helper or a successful candidate record.
    const runtimeDirectory = path.join(evidence, "runtime-notices")
    collectRuntimeNotices(runtimeDirectory, process.platform + "-" + process.arch)
    if (process.platform === "darwin" || process.platform === "linux") {
      packetDirectory = path.join(scratch, "packet-a")
      const first = await packageSource({ buildDirectory: output, runtimeDirectory, output: packetDirectory })
      const second = await packageSource({ buildDirectory: output, runtimeDirectory, output: path.join(scratch, "packet-b") })
      assert.equal(first.sha256, second.sha256, "same-input source packet must be deterministic")
      fs.writeFileSync(path.join(evidence, "source-packet.json"), JSON.stringify({ ...first, identicalRepeat: true }, null, 2) + "\n")
      noticeRecord = stageInstalledNotices({ buildDirectory: output, packetDirectory, output: path.join(scratch, "installed-notices") })
    }
    await validate({ sourceBuild: output, noticeRecord, evidence: path.join(evidence, "native-validation") })
    if (retain) {
      const record = retainCandidate({ buildDirectory: output, evidence: path.join(evidence, "native-validation"),
        packetDirectory, output: retain })
      fs.writeFileSync(path.join(evidence, "retained-candidate.json"), JSON.stringify(record, null, 2) + "\n")
    }
    console.log("Source-built FFprobe native/package validation passed; source selection/publication remain separate review gates")
  } finally {
    try {
      fs.writeFileSync(path.join(evidence, "source-acquisition.json"), JSON.stringify(acquisition, null, 2) + "\n")
      if (fs.existsSync(output)) {
        const small = path.join(evidence, "build"); fs.mkdirSync(small)
        for (const file of fs.readdirSync(output).filter(name => name.endsWith(".log") || name === "prototype.json")) fs.copyFileSync(path.join(output, file), path.join(small, file))
        for (const name of ["config.mak", "config.log"]) {
          const file = path.join(output, "source/ffbuild", name)
          if (fs.existsSync(file)) {
            const contents = fs.readFileSync(file)
            fs.writeFileSync(path.join(small, name), contents.length <= 2 * 1024 * 1024 ? contents : Buffer.concat([contents.subarray(0, 65536), Buffer.from("\n[diagnostic middle omitted]\n"), contents.subarray(-65536)]))
          }
        }
      }
    } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
  }
}
if (require.main === module) {
  const { values } = parseArgs({ options: { source: { type: "string" }, evidence: { type: "string" }, retain: { type: "string" } } })
  validateSource(values).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { validateSource }
