const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto")
const { prepareNotices, finishNotices, verifyInstalledNotices, validateRecord, serialize } = require("../scripts/ffprobe-notices")
const pin = require("../third-party/ffprobe/source-build.json")
const hash = data => crypto.createHash("sha256").update(data).digest("hex")
let root, resources, directory, record, recordFile
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-notices-")); resources = path.join(root, "resources"); directory = path.join(root, "notice-input")
  fs.mkdirSync(path.join(resources, "binaries"), { recursive: true }); fs.mkdirSync(directory)
  fs.writeFileSync(path.join(resources, "binaries/ffprobe"), "synthetic helper")
  const license = fs.readFileSync(path.join(__dirname, "../third-party/ffprobe/COPYING.LGPLv2.1"))
  fs.writeFileSync(path.join(directory, "COPYING.LGPLv2.1"), license); fs.writeFileSync(path.join(directory, "NOTICE.txt"), "Synthetic notice\n")
  const binarySha256 = hash("synthetic helper"), packetSha = "a".repeat(64)
  record = { schema: 1, evaluationOnly: true, platform: "darwin-arm64", binarySha256, sourceCommit: pin.commit, sourceArchiveSha256: pin.archiveSha256,
    sourceAsset: { name: `ffprobe-source-${pin.commit.slice(0, 12)}-darwin-arm64-${binarySha256.slice(0, 12)}-${packetSha.slice(0, 12)}.tar.gz`, sha256: packetSha, url: null, assetId: null },
    files: { "NOTICE.txt": hash("Synthetic notice\n"), "COPYING.LGPLv2.1": hash(license) } }
  recordFile = path.join(directory, "SOURCE.json"); save()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const save = () => fs.writeFileSync(recordFile, serialize(record))
const prepare = (options = {}) => prepareNotices({ projectDir: root, resources, platform: "darwin-arm64", evaluationRecord: recordFile, published: null, ...options })
test("installs exact notices and binds the source record through the Mac signing transform", () => {
  const prepared = prepare(); fs.appendFileSync(path.join(resources, "binaries/ffprobe"), " signed"); finishNotices(prepared)
  const installed = verifyInstalledNotices(resources, "darwin-arm64", { required: true, published: null })
  expect(installed.record.binarySha256).toBe(hash("synthetic helper")); expect(installed.packagedSha256).toBe(hash("synthetic helper signed"))
  expect(fs.readFileSync(path.join(resources, "third-party/ffprobe/COPYING.LGPLv2.1"))).toEqual(fs.readFileSync(path.join(directory, "COPYING.LGPLv2.1")))
  fs.appendFileSync(path.join(resources, "binaries/ffprobe"), " changed")
  expect(() => verifyInstalledNotices(resources, "darwin-arm64", { required: true, published: null })).toThrow(/differs/)
})
test("refuses a different input helper before copying notices", () => {
  fs.appendFileSync(path.join(resources, "binaries/ffprobe"), " changed")
  expect(prepare).toThrow(/input FFprobe/)
  expect(fs.existsSync(path.join(resources, "third-party/ffprobe"))).toBe(false)
})
test.each(["NOTICE.txt", "COPYING.LGPLv2.1"])("refuses altered %s", name => {
  fs.appendFileSync(path.join(directory, name), " changed"); expect(prepare).toThrow(/checksum/)
})
test("rejects missing notice/license, traversal and wrong platform/source mapping", () => {
  const original = structuredClone(record)
  for (const change of [r => delete r.files["NOTICE.txt"], r => delete r.files["COPYING.LGPLv2.1"], r => r.files["../outside"] = "a".repeat(64), r => r.platform = "win32-x64", r => r.sourceArchiveSha256 = "b".repeat(64)]) {
    record = structuredClone(original); change(record); save(); expect(prepare).toThrow()
  }
})
test("required installed notices cannot be omitted; supplier/downloader path remains optional", () => {
  expect(prepare({ evaluationRecord: undefined })).toBeNull()
  expect(verifyInstalledNotices(resources, "darwin-arm64", { published: null })).toBeNull()
  expect(() => verifyInstalledNotices(resources, "darwin-arm64", { published: null, required: true })).toThrow()
})
test("production requires a pinned record and real source asset; evaluation cannot satisfy it", () => {
  const relative = "distributions/darwin-arm64/SOURCE.json", destination = path.join(root, "third-party/ffprobe", relative)
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.cpSync(directory, path.dirname(destination), { recursive: true })
  let published = { sha256: record.binarySha256, sourceRecord: relative, sourceRecordSha256: hash(serialize(record)) }
  expect(() => prepare({ evaluationRecord: undefined, published })).toThrow(/evaluation/)
  record.evaluationOnly = false; record.sourceAsset.url = "https://github.com/Cliply/Cliply/releases/download/binaries/" + record.sourceAsset.name; record.sourceAsset.assetId = 123
  fs.writeFileSync(destination, serialize(record)); published = { ...published, sourceRecordSha256: hash(serialize(record)) }
  const prepared = prepare({ evaluationRecord: undefined, published }); finishNotices(prepared)
  expect(verifyInstalledNotices(resources, "darwin-arm64", { published }).record.evaluationOnly).toBe(false)
  expect(() => verifyInstalledNotices(resources, "darwin-arm64", { published: { ...published, sourceRecordSha256: "b".repeat(64) } })).toThrow(/production pin/)
})
test("installed notice or record tampering is rejected", () => {
  finishNotices(prepare()); const file = path.join(resources, "third-party/ffprobe/SOURCE.json"), installed = JSON.parse(fs.readFileSync(file))
  installed.record.sourceAsset.sha256 = "b".repeat(64); fs.writeFileSync(file, serialize(installed))
  expect(() => verifyInstalledNotices(resources, "darwin-arm64", { required: true, published: null })).toThrow(/record checksum/)
})
test.each(["linux-x64", "win32-x64"])("%s records require the reviewed runtime notices and full GPL texts", platform => {
  record.platform = platform
  record.sourceAsset.name = record.sourceAsset.name.replace("darwin-arm64", platform)
  const runtime = require("../third-party/ffprobe/runtime-notices.json")[platform]
  record.files["COPYING.GPLv3"] = pin.licenseFiles["COPYING.GPLv3"]
  if (platform === "win32-x64") record.files["COPYING.GPLv2"] = pin.licenseFiles["COPYING.GPLv2"]
  for (const [name, input] of Object.entries(runtime.installedFiles)) record.files[name] = runtime.files[input]
  expect(() => validateRecord(record, platform, null)).not.toThrow()
  for (const name of ["COPYING.GPLv3", ...(platform === "win32-x64" ? ["COPYING.GPLv2"] : []), ...Object.keys(runtime.installedFiles)]) {
    const missing = structuredClone(record); delete missing.files[name]
    expect(() => validateRecord(missing, platform, null)).toThrow(/runtime/)
    missing.files[name] = "b".repeat(64)
    expect(() => validateRecord(missing, platform, null)).toThrow(/runtime/)
  }
})
