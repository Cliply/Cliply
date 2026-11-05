// Explicit offline staging of a pinned upstream archive, never a runtime fetch
// or publication. Download the recorded URL into a task-owned temp directory.
const fs = require("node:fs/promises")
const { createReadStream } = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { createHash } = require("node:crypto")
const { execFileSync } = require("node:child_process")
const { parseArgs } = require("node:util")
const { extractZip } = require("../src/main/utils/archive")
const { verifyArchitecture } = require("./fetch-helpers")
const { TARGETS } = require("../src/main/services/local-media/paths")
const CANDIDATES = require("../third-party/ffprobe/candidates.json")

async function hash(file) {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest("hex")
}

async function stageFfprobe({ platform, archive, output }) {
  const candidate = CANDIDATES[platform]
  const target = TARGETS[platform]
  if (!candidate || !archive || !output) throw new Error("Pass --platform, --archive and a new --output directory")
  if (await hash(archive) !== candidate.archiveSha256) throw new Error("FFprobe archive checksum mismatch")
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-ffprobe-"))
  let ownsOutput = false
  try {
    const extracted = path.join(scratch, "unpacked")
    await fs.mkdir(extracted)
    if (candidate.url.endsWith(".zip")) await extractZip(archive, extracted)
    else execFileSync("tar", ["-xJf", path.resolve(archive), "-C", extracted, candidate.member], { timeout: 120000 })
    const executable = path.join(extracted, candidate.member)
    await verifyArchitecture(executable, platform)
    const sha256 = await hash(executable)
    if (candidate.executableSha256 && sha256 !== candidate.executableSha256) throw new Error("FFprobe executable checksum mismatch")
    await fs.chmod(executable, 0o755)
    const evidence = {
      platform, asset: target.asset, ...candidate, sha256, bytes: (await fs.stat(executable)).size,
      nativeExecution: false
    }
    if (platform === `${process.platform}-${process.arch}`) {
      for (const [key, flag] of [["version", "-version"], ["buildconf", "-buildconf"], ["license", "-L"]]) {
        evidence[key] = execFileSync(executable, ["-hide_banner", flag], {
          encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
        })
      }
      evidence.nativeExecution = true
    }
    // An existing output directory is never ours to overwrite or clean.
    await fs.mkdir(output)
    ownsOutput = true
    await fs.copyFile(executable, path.join(output, target.asset), fs.constants.COPYFILE_EXCL)
    await fs.chmod(path.join(output, target.asset), 0o755)
    await fs.writeFile(path.join(output, "ffprobe-evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" })
    return evidence
  } catch (error) {
    if (ownsOutput) await fs.rm(output, { recursive: true, force: true })
    throw error
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

if (require.main === module) {
  const { values } = parseArgs({ options: {
    platform: { type: "string" }, archive: { type: "string" }, output: { type: "string" }
  } })
  stageFfprobe(values).then((evidence) => console.log(JSON.stringify(evidence, null, 2))).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { stageFfprobe, hash }
