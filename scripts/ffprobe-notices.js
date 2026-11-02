// Build-time source/license notices. Evaluation records never satisfy production pins.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const { ffprobeRelease } = require("./fetch-helpers")
const sourcePin = require("../third-party/ffprobe/source-build.json")
const runtimePins = require("../third-party/ffprobe/runtime-notices.json")
const digest = data => createHash("sha256").update(data).digest("hex")
const hash = file => digest(fs.readFileSync(file))
const serialize = record => JSON.stringify(record, null, 2) + "\n"
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
function validateRecord(record, platform, published) {
  assert.equal(record.schema, 1)
  assert.equal(record.platform, platform, "notice record belongs to another platform")
  assert.equal(record.sourceCommit, sourcePin.commit)
  assert.equal(record.sourceArchiveSha256, sourcePin.archiveSha256)
  assert(validHash(record.binarySha256), "notice record needs the exact input binary hash")
  const asset = record.sourceAsset
  assert(asset && validHash(asset.sha256), "notice record needs the exact source packet hash")
  assert.equal(asset.name, `ffprobe-source-${record.sourceCommit.slice(0, 12)}-${platform}-${record.binarySha256.slice(0, 12)}-${asset.sha256.slice(0, 12)}.tar.gz`)
  assert(record.files && validHash(record.files["NOTICE.txt"]), "missing FFprobe notice")
  assert.equal(record.files["COPYING.LGPLv2.1"], sourcePin.licenseFiles["COPYING.LGPLv2.1"], "missing or altered upstream LGPL text")
  const runtime = runtimePins[platform]
  if (runtime) {
    assert.equal(record.files["COPYING.GPLv3"], sourcePin.licenseFiles["COPYING.GPLv3"], "missing runtime GPL text")
    for (const [name, input] of Object.entries(runtime.installedFiles)) {
      assert.equal(record.files[name], runtime.files[input], "missing or altered runtime notice: " + name)
    }
  }
  for (const [name, sha256] of Object.entries(record.files)) {
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== "SOURCE.json" && validHash(sha256), "invalid notice filename or checksum")
  }
  if (published) {
    assert.equal(record.evaluationOnly, false, "evaluation notices cannot satisfy a production record")
    assert.equal(record.binarySha256, published.sha256, "notices do not match the published binary")
    assert.equal(asset.url, "https://github.com/Cliply/Cliply/releases/download/binaries/" + asset.name)
    assert(Number.isSafeInteger(asset.assetId) && asset.assetId > 0, "source asset must be verified as published")
  } else {
    assert.equal(record.evaluationOnly, true, "unpublished notices must remain evaluation-only")
    assert.equal(asset.url, null, "evaluation must not invent a published source URL")
    assert.equal(asset.assetId, null)
  }
}
function checkFiles(directory, record) {
  for (const [name, sha256] of Object.entries(record.files)) {
    const file = path.join(directory, name)
    assert(fs.lstatSync(file).isFile(), "notice must be a regular file: " + name)
    assert.equal(hash(file), sha256, "notice checksum mismatch: " + name)
  }
}
function binaryPath(resources, platform) { return path.join(resources, "binaries", platform === "win32-x64" ? "ffprobe.exe" : "ffprobe") }
function prepareNotices({ projectDir, resources, platform, evaluationRecord, published = ffprobeRelease(platform) }) {
  if (!published && !evaluationRecord) return null // Existing supplier/downloader path.
  assert(!published || !evaluationRecord, "cannot mix evaluation and published notices")
  let recordFile = evaluationRecord
  if (published) {
    const relative = `distributions/${platform}/SOURCE.json`
    assert.equal(published.sourceRecord, relative, "production source record must use the reviewed platform directory")
    assert(validHash(published.sourceRecordSha256), "published notice record checksum is required")
    recordFile = path.join(projectDir, "third-party/ffprobe", relative)
  }
  assert(path.isAbsolute(recordFile), "notice record path must be absolute")
  assert(fs.lstatSync(recordFile).isFile(), "notice record must be a regular file")
  const contents = fs.readFileSync(recordFile, "utf8"), record = JSON.parse(contents)
  assert.equal(contents, serialize(record), "notice record must use canonical JSON formatting")
  const recordSha256 = digest(contents)
  if (published) assert.equal(recordSha256, published.sourceRecordSha256, "published notice record changed")
  validateRecord(record, platform, published)
  checkFiles(path.dirname(recordFile), record)
  assert.equal(hash(binaryPath(resources, platform)), record.binarySha256, "notices do not match the input FFprobe")
  const destination = path.join(resources, "third-party/ffprobe")
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.mkdirSync(destination)
  for (const name of Object.keys(record.files)) fs.copyFileSync(path.join(path.dirname(recordFile), name), path.join(destination, name), fs.constants.COPYFILE_EXCL)
  return { record, recordSha256, destination, resources, platform }
}
function finishNotices(prepared) {
  if (!prepared) return
  const { record, recordSha256, destination, resources, platform } = prepared
  const packagedSha256 = hash(binaryPath(resources, platform))
  if (platform !== "darwin-arm64") assert.equal(packagedSha256, record.binarySha256, "unexpected FFprobe packaging transform")
  // Signing can change Mac bytes. Retain the original source/binary mapping and
  // bind it to the actual installed helper after the existing signing audit.
  fs.writeFileSync(path.join(destination, "SOURCE.json"), serialize({ record, recordSha256, packagedSha256 }), { flag: "wx" })
}
function verifyInstalledNotices(resources, platform, { required = false, published = ffprobeRelease(platform) } = {}) {
  const directory = path.join(resources, "third-party/ffprobe"), file = path.join(directory, "SOURCE.json")
  if (!fs.existsSync(file) && !required && !published) return null
  assert(fs.lstatSync(file).isFile(), "installed FFprobe source record is required")
  const installed = JSON.parse(fs.readFileSync(file, "utf8")), { record, recordSha256, packagedSha256 } = installed
  assert.equal(digest(serialize(record)), recordSha256, "installed source record checksum mismatch")
  if (published) assert.equal(recordSha256, published.sourceRecordSha256, "installed record differs from the production pin")
  validateRecord(record, platform, published); checkFiles(directory, record)
  assert.equal(hash(binaryPath(resources, platform)), packagedSha256, "installed FFprobe differs from its source record")
  if (platform !== "darwin-arm64") assert.equal(packagedSha256, record.binarySha256)
  return installed
}
module.exports = { prepareNotices, finishNotices, verifyInstalledNotices, validateRecord, serialize }
