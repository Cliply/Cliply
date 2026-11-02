const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const crypto = require("node:crypto")
const { makeZip } = require("./helpers/zip-fixture")

jest.mock("../third-party/ffprobe/candidates.json", () => ({
  "darwin-arm64": { url: "https://fixture.invalid/probe.zip", member: "ffprobe", publicationReady: false }
}))
jest.mock("node:child_process", () => ({ execFileSync: jest.fn(() => "synthetic version/license output") }))
const candidates = require("../third-party/ffprobe/candidates.json")
const { stageFfprobe } = require("../scripts/stage-ffprobe")

let root, archive, output
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex")
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-staging-test-"))
  archive = path.join(root, "fixture.zip")
  output = path.join(root, "staged")
  const binary = Buffer.alloc(128)
  binary.writeUInt32LE(0xfeedfacf, 0)
  binary.writeUInt32LE(0x100000c, 4)
  const zip = makeZip([{ name: "ffprobe", data: binary }])
  await fs.writeFile(archive, zip)
  candidates["darwin-arm64"].archiveSha256 = digest(zip)
  candidates["darwin-arm64"].executableSha256 = digest(binary)
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
const stage = () => stageFfprobe({ platform: "darwin-arm64", archive, output })

test("stages only the pinned executable and evidence with the proposed asset name", async () => {
  const evidence = await stage()
  expect(evidence.asset).toBe("ffprobe")
  expect(evidence.publicationReady).toBe(false)
  expect((await fs.readdir(output)).sort()).toEqual(["ffprobe", "ffprobe-evidence.json"])
})

test("checksum mismatch creates no output", async () => {
  await fs.appendFile(archive, "bad")
  await expect(stage()).rejects.toThrow("archive checksum mismatch")
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" })
})

test("extracted checksum mismatch creates no output", async () => {
  candidates["darwin-arm64"].executableSha256 = "0".repeat(64)
  await expect(stage()).rejects.toThrow("executable checksum mismatch")
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" })
})

test("an existing staging directory and its contents are preserved", async () => {
  await fs.mkdir(output)
  await fs.writeFile(path.join(output, "ffprobe"), "pre-existing")
  await expect(stage()).rejects.toMatchObject({ code: "EEXIST" })
  expect(await fs.readFile(path.join(output, "ffprobe"), "utf8")).toBe("pre-existing")
})

test("an archive with the wrong executable architecture is refused", async () => {
  const zip = makeZip([{ name: "ffprobe", data: Buffer.alloc(128) }])
  await fs.writeFile(archive, zip)
  candidates["darwin-arm64"].archiveSha256 = digest(zip)
  await expect(stage()).rejects.toThrow("not a darwin-arm64 executable")
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" })
})

test("resource filters include FFprobe beside existing helpers on each target", () => {
  const { build } = require("../package.json")
  for (const [platform, suffix] of [["mac", ""], ["win", ".exe"], ["linux", ""]]) {
    const mapping = build[platform].extraResources.find((entry) => entry.to === "binaries/")
    expect(mapping.filter).toEqual([`ffmpeg${suffix}`, `ffprobe${suffix}`])
  }
})

test("packaged capability check refuses an absent FFprobe even when an engine exists", async () => {
  const { executableCandidates } = require("../src/main/services/ytdlp/paths")
  const { verifyPackagedHelpers } = require("../scripts/verify-packaged-helpers")
  const engineDir = path.join(root, "binaries/ytdlp")
  await fs.mkdir(engineDir, { recursive: true })
  await fs.writeFile(path.join(engineDir, executableCandidates()[0]), "fixture")
  await expect(verifyPackagedHelpers(root, { requireFfprobe: true }))
    .rejects.toThrow("packaged FFprobe is required for local media capability")
})

test("packaged check validates a present FFprobe's architecture before executing it", async () => {
  const { executableCandidates } = require("../src/main/services/ytdlp/paths")
  const { verifyPackagedHelpers } = require("../scripts/verify-packaged-helpers")
  const engineDir = path.join(root, "binaries/ytdlp")
  await fs.mkdir(engineDir, { recursive: true })
  await fs.writeFile(path.join(engineDir, executableCandidates()[0]), "fixture")
  await fs.writeFile(path.join(root, "binaries", process.platform === "win32" ? "ffprobe.exe" : "ffprobe"), "not an executable")
  await expect(verifyPackagedHelpers(root)).rejects.toThrow("executable")
})
