// One helper source for native CI and packaging. Downloads are staged together
// so a missing asset or wrong architecture leaves existing helpers untouched.
const fs = require("node:fs/promises")
const path = require("node:path")
const { parseArgs } = require("node:util")
const { createHash } = require("node:crypto")
const { createReadStream } = require("node:fs")
const publishedFfprobe = require("../third-party/ffprobe/published.json")
const { createHttpClient } = require("../src/main/services/ytdlp-updater")

const TARGETS = {
  "darwin-arm64": { directory: "macos", ffmpeg: "ffmpeg", deno: "deno", ffprobe: "ffprobe" },
  "win32-x64": { directory: "windows", ffmpeg: "ffmpeg.exe", deno: "deno.exe", ffprobe: "ffprobe.exe" },
  "linux-x64": { directory: "linux", ffmpeg: "ffmpeg-linux-x64", deno: "deno-linux-x64", ffprobe: "ffprobe-linux-x64" }
}

function ffprobeRelease(platform, records = publishedFfprobe) {
  const record = records[platform]
  if (!record) return null
  if (!/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.assetId) || record.assetId <= 0 ||
      typeof record.sourceRecord !== "string" || !record.sourceRecord.trim()) throw new Error(`Invalid published FFprobe record for ${platform}`)
  return record
}

async function verifyDigest(file, expected) {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  if (digest.digest("hex") !== expected) throw new Error("FFprobe SHA256 differs from the pinned published asset")
}

async function verifyArchitecture(file, platform) {
  const handle = await fs.open(file)
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    let valid = false
    if (bytesRead === 64 && platform === "linux-x64") {
      valid = header.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) &&
        header.readUInt16LE(18) === 62
    } else if (bytesRead === 64 && platform === "darwin-arm64") {
      valid = header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x100000c
    } else if (bytesRead === 64 && platform === "win32-x64" && header.toString("ascii", 0, 2) === "MZ") {
      const pe = Buffer.alloc(6)
      const offset = header.readUInt32LE(60)
      const read = await handle.read(pe, 0, pe.length, offset)
      valid = read.bytesRead === 6 && pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === 0x8664
    }
    if (!valid) throw new Error(`${file} is not a ${platform} executable`)
  } finally {
    await handle.close()
  }
}

async function fetchHelpers({
  platform = process.env.BUILD_TARGET_PLATFORM || `${process.platform}-${process.arch}`,
  binariesDir = path.resolve(__dirname, "../binaries"),
  baseUrl = `https://github.com/${process.env.GITHUB_REPOSITORY || "Cliply/Cliply"}/releases/download/binaries`,
  http = createHttpClient(),
  requireFfprobe = process.env.CLIPLY_REQUIRE_FFPROBE === "1",
  ffprobeRecords = publishedFfprobe
} = {}) {
  const target = TARGETS[platform]
  if (!target) throw new Error(`Unsupported helper platform: ${platform}`)
  const ffprobe = ffprobeRelease(platform, ffprobeRecords)
  if (requireFfprobe && !ffprobe) throw new Error(`No verified published FFprobe for ${platform}; see third-party/ffprobe/README.md`)
  await fs.mkdir(binariesDir, { recursive: true })
  const staging = await fs.mkdtemp(path.join(binariesDir, ".helpers-"))
  const suffix = platform === "win32-x64" ? ".exe" : ""
  const entries = [
    { asset: target.ffmpeg, destination: path.join(binariesDir, target.directory, `ffmpeg${suffix}`) },
    { asset: target.deno, destination: path.join(binariesDir, "deno", target.directory, `deno${suffix}`) },
    ...(ffprobe ? [{ asset: target.ffprobe, sha256: ffprobe.sha256, destination: path.join(binariesDir, target.directory, `ffprobe${suffix}`) }] : [])
  ]
  try {
    const results = await Promise.allSettled(entries.map(async (entry) => {
      entry.staged = path.join(staging, entry.asset)
      const url = `${baseUrl}/${entry.asset}`
      let failure
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await http.download(url, entry.staged, { signal: AbortSignal.timeout(5 * 60 * 1000) })
          if (entry.sha256) await verifyDigest(entry.staged, entry.sha256)
          await verifyArchitecture(entry.staged, platform)
          await fs.chmod(entry.staged, 0o755)
          return
        } catch (error) {
          failure = error
        }
      }
      throw failure
    }))
    const failed = results.find((result) => result.status === "rejected")
    if (failed) throw failed.reason
    for (const entry of entries) {
      await fs.mkdir(path.dirname(entry.destination), { recursive: true })
      await fs.rename(entry.staged, entry.destination)
      console.log(`installed ${entry.asset} -> ${entry.destination}`)
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

if (require.main === module) {
  const { values } = parseArgs({ options: { platform: { type: "string" }, "require-ffprobe": { type: "boolean" } } })
  fetchHelpers({ platform: values.platform, ...(values["require-ffprobe"] ? { requireFfprobe: true } : {}) }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { TARGETS, verifyArchitecture, fetchHelpers, ffprobeRelease }
