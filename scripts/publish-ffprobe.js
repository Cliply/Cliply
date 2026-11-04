// Explicit promotion of a successful native source CI run. Never builds an app
// release, overwrites a shared asset, or writes production pins into the checkout.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process"), { parseArgs } = require("node:util")
const { createHash } = require("node:crypto")
const { hash, sourcePin } = require("./build-ffprobe-prototype")
const { readBuild, verifyRuntimeNotices, requirePassedValidation } = require("./package-ffprobe-source")
const { validateRecord, serialize } = require("./ffprobe-notices")
const { ffprobeRelease } = require("./fetch-helpers")
const { createHttpClient } = require("../src/main/services/ytdlp-updater")
const repo = path.resolve(__dirname, ".."), repository = "Cliply/Cliply"
const platforms = ["darwin-arm64", "win32-x64", "linux-x64"]
const digest = data => createHash("sha256").update(data).digest("hex")
const json = file => JSON.parse(fs.readFileSync(file, "utf8"))
function gh(args) { return execFileSync("gh", args, { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60 * 1000 }) }
function api(endpoint) { return JSON.parse(gh(["api", `repos/${repository}/${endpoint}`])) }
function inventory(directory, prefix = "") {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix + entry.name, file = path.join(directory, entry.name)
    assert(!entry.isSymbolicLink(), "candidate must not contain symlinks")
    if (entry.isDirectory()) return Object.entries(inventory(file, relative + "/"))
    assert(entry.isFile(), "candidate must contain only regular files")
    return [[relative, hash(file)]]
  }))
}
async function extract(archive, directory) {
  const tar = require("tar"), entries = new Set()
  let invalid
  // Validate the entire archive before extracting any entry. These generated
  // packets and canonical upstream exports contain no links or special files.
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    // Event callbacks must not throw outside the awaited parser promise.
    try {
      const name = entry.path.replace(/\/$/, "")
      assert(name && !name.includes("\\") && !name.includes(":") && !name.startsWith("/") &&
        name.split("/").every(part => part && part !== "." && part !== ".."), "unsafe archive path")
      assert(["File", "Directory"].includes(entry.type), "archive contains a link or special file")
      assert(!entries.has(name), "duplicate archive entry"); entries.add(name)
    } catch (error) { invalid ||= error }
  } })
  if (invalid) throw invalid
  fs.mkdirSync(directory)
  await tar.x({ file: archive, cwd: directory, strict: true, noChmod: true })
}
function validateRun(run, head) {
  assert.equal(run.head_sha, head, "qualify the exact checked-out commit before publication")
  assert.equal(run.head_repository?.full_name, repository, "source run belongs to another repository")
  assert.equal(run.path, ".github/workflows/ci.yml")
  assert.equal(run.event, "workflow_dispatch")
  assert.equal(run.status, "completed"); assert.equal(run.conclusion, "success", "native source CI must pass")
}
async function verifyCandidate(directory, platform, scratch) {
  const review = json(path.join(directory, "REVIEW.json")), files = inventory(directory)
  delete files["REVIEW.json"]
  assert.deepEqual(files, review.files, "retained candidate inventory changed")
  assert.equal(review.platform, platform); assert.equal(review.schema, 1)
  for (const key of ["nativeValidationPassed", "runtimeNoticesReviewed", "installedNoticesValidated", "sourcePacketReadyForReview"]) assert.equal(review[key], true, "incomplete candidate: " + key)
  assert.equal(review.evaluationOnly, true); assert.equal(review.publicationReady, false)
  const packet = json(path.join(directory, "source-packet.json"))
  assert.equal(path.basename(packet.assetName), packet.assetName)
  const archive = path.join(directory, packet.assetName)
  assert.equal(hash(archive), packet.sha256); assert.equal(fs.statSync(archive).size, packet.bytes)
  const unpacked = path.join(scratch, platform + "-source-packet")
  await extract(archive, unpacked)
  assert.deepEqual(json(path.join(unpacked, "manifest.json")), packet.manifest)
  const packetFiles = inventory(unpacked); delete packetFiles["manifest.json"]
  assert.deepEqual(packetFiles, packet.manifest.files, "source packet inventory changed")
  for (const name of ["scripts/build-ffprobe-prototype.js", "scripts/package-ffprobe-source.js", "third-party/ffprobe/source-build.json", "third-party/ffprobe/runtime-notices.json", "third-party/ffprobe/NOTICE.source-build.txt"]) {
    assert.equal(hash(path.join(unpacked, name)), hash(path.join(repo, name)), "source recipe or notice changed: " + name)
  }
  const build = path.join(scratch, platform + "-build"); fs.mkdirSync(build)
  fs.copyFileSync(path.join(unpacked, "upstream/source.tar"), path.join(build, "source.tar"))
  assert.equal(hash(path.join(build, "source.tar")), sourcePin.archiveSha256)
  await extract(path.join(build, "source.tar"), path.join(build, "source"))
  const executableName = platform === "win32-x64" ? "ffprobe.exe" : "ffprobe"
  fs.copyFileSync(path.join(directory, executableName), path.join(build, executableName))
  fs.copyFileSync(path.join(directory, "build/prototype.json"), path.join(build, "prototype.json"))
  fs.copyFileSync(path.join(directory, "build/config.mak"), path.join(build, "source/ffbuild/config.mak"))
  const { facts } = readBuild(build, { validationDirectory: path.join(directory, "validation") })
  assert(typeof review.normalizationRoot === "string" &&
    (platform === "win32-x64" ? path.win32 : path.posix).isAbsolute(review.normalizationRoot), "missing original build normalization root")
  const normalize = text => text.split(review.normalizationRoot).join("$BUILD")
  assert.equal(fs.readFileSync(path.join(unpacked, "build/record.json"), "utf8"), normalize(JSON.stringify(facts, null, 2)) + "\n", "packet contains a different build record")
  assert.equal(fs.readFileSync(path.join(unpacked, "build/config.mak"), "utf8"), normalize(fs.readFileSync(path.join(directory, "build/config.mak"), "utf8")), "packet contains a different configuration")
  for (const [name, expected] of Object.entries(sourcePin.licenseFiles)) assert.equal(hash(path.join(unpacked, "notices", name)), expected, "packet license/source notice changed")
  assert.equal(facts.platform, platform)
  assert.equal(review.executableSha256, facts.executableSha256)
  assert.equal(packet.manifest.executableSha256, facts.executableSha256)
  assert.equal(packet.manifest.sourceCommit, facts.commit); assert.equal(packet.manifest.platform, platform)
  verifyRuntimeNotices(facts, path.join(directory, "runtime-notices"))
  verifyRuntimeNotices(facts, path.join(unpacked, "runtime-notices"))
  const artifact = requirePassedValidation(path.join(directory, "validation"), facts)
  const installed = json(path.join(directory, "installed-notices/SOURCE.json")), record = installed.record
  validateRecord(record, platform, null)
  assert.equal(installed.recordSha256, digest(serialize(record)))
  assert.equal(installed.packagedSha256, artifact.packagedSha256)
  assert.equal(record.binarySha256, facts.executableSha256)
  assert.equal(record.sourceAsset.sha256, packet.sha256); assert.equal(record.sourceAsset.name, packet.assetName)
  assert.equal(record.files["NOTICE.txt"], hash(path.join(unpacked, "third-party/ffprobe/NOTICE.source-build.txt")), "installed notice differs from the source packet")
  for (const [name, expected] of Object.entries(record.files)) assert.equal(hash(path.join(directory, "installed-notices", name)), expected)
  return { platform, directory, facts, record, packet, executableName,
    assetName: `ffprobe-${facts.commit.slice(0, 12)}-${platform}-${facts.executableSha256.slice(0, 12)}${platform === "win32-x64" ? ".exe" : ""}` }
}
async function publishAsset(file, name, expected, scratch, releaseAssets, { upload, download, lookup } = {}) {
  upload ||= () => gh(["release", "upload", "binaries", file, "--repo", repository]) // deliberately no --clobber
  download ||= (url, target) => createHttpClient().download(url, target, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  lookup ||= () => api("releases/tags/binaries").assets
  let matches = releaseAssets.filter(asset => asset.name === name)
  assert(matches.length <= 1, "duplicate release asset")
  if (!matches.length) { upload(); matches = lookup().filter(asset => asset.name === name) }
  assert.equal(matches.length, 1, "uploaded asset is missing")
  const asset = matches[0], url = `https://github.com/${repository}/releases/download/binaries/${name}`
  assert.equal(asset.browser_download_url, url); assert.equal(asset.state, "uploaded")
  assert(Number.isSafeInteger(asset.id) && asset.id > 0)
  assert.equal(asset.size, fs.statSync(file).size, "release asset size differs")
  if (asset.digest) assert.equal(asset.digest, "sha256:" + expected, "release asset digest differs")
  const verified = path.join(scratch, name + ".download")
  await download(url, verified)
  assert.equal(hash(verified), expected, "downloaded release bytes differ")
  fs.rmSync(verified)
  return asset
}
async function promote({ runId, output, publish = false }) {
  assert(/^\d+$/.test(runId || ""), "pass the successful --run ID")
  assert(output && path.isAbsolute(output) && !fs.existsSync(output), "pass a new absolute --output directory")
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
  assert.equal(execFileSync("git", ["diff", "HEAD", "--name-only"], { cwd: repo, encoding: "utf8" }).trim(), "", "commit reviewed changes before promotion")
  const run = api(`actions/runs/${runId}`); validateRun(run, head)
  const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`).artifacts
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-ffprobe-promotion-"))
  fs.mkdirSync(output)
  try {
    const verified = []
    for (const platform of platforms) {
      const name = "source-candidate-" + platform, matches = artifacts.filter(artifact => artifact.name === name && !artifact.expired)
      assert.equal(matches.length, 1, "missing unique retained native candidate: " + platform)
      const directory = path.join(scratch, platform)
      gh(["run", "download", runId, "--repo", repository, "--name", name, "--dir", directory])
      verified.push(await verifyCandidate(directory, platform, scratch))
    }
    const plan = { schema: 1, repository, release: "binaries", runId, commit: head,
      platforms: verified.map(({ platform, assetName, facts, packet }) => ({ platform, assetName, sha256: facts.executableSha256, bytes: facts.bytes,
        sourceAsset: packet.assetName, sourceSha256: packet.sha256, sourceBytes: packet.bytes })) }
    fs.writeFileSync(path.join(output, "plan.json"), serialize(plan))
    if (!publish) { console.log("Verified promotion plan only; no uploads. Review plan.json, then rerun with --publish and a new output directory."); return plan }
    const release = api("releases/tags/binaries")
    assert.equal(release.tag_name, "binaries"); assert.equal(release.draft, false)
    const records = {}, receipts = []
    // Every platform/source packet is verified before the first remote write.
    for (const candidate of verified) {
      const { platform, directory, assetName, facts, packet } = candidate
      const helper = path.join(scratch, assetName)
      fs.copyFileSync(path.join(directory, candidate.executableName), helper)
      const source = await publishAsset(path.join(directory, packet.assetName), packet.assetName, packet.sha256, scratch, release.assets)
      const binary = await publishAsset(helper, assetName, facts.executableSha256, scratch, release.assets)
      const record = { ...candidate.record, evaluationOnly: false, sourceAsset: { ...candidate.record.sourceAsset, assetId: source.id, url: source.browser_download_url } }
      const publication = { assetName, assetId: binary.id, sha256: facts.executableSha256,
        sourceRecord: `distributions/${platform}/SOURCE.json`, sourceRecordSha256: digest(serialize(record)) }
      validateRecord(record, platform, publication); ffprobeRelease(platform, { [platform]: publication })
      const destination = path.join(output, "distributions", platform); fs.mkdirSync(destination, { recursive: true })
      for (const name of Object.keys(record.files)) fs.copyFileSync(path.join(directory, "installed-notices", name), path.join(destination, name))
      fs.writeFileSync(path.join(destination, "SOURCE.json"), serialize(record)); records[platform] = publication
      receipts.push({ platform, binary, source })
      fs.writeFileSync(path.join(output, "receipts.json"), serialize(receipts))
    }
    fs.writeFileSync(path.join(output, "published.json"), serialize(records))
    console.log("All three published helpers and source assets verified. Review the output records before committing production activation.")
    return plan
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
if (require.main === module) {
  const { values } = parseArgs({ options: { run: { type: "string" }, output: { type: "string" }, publish: { type: "boolean", default: false } } })
  promote({ runId: values.run, output: values.output, publish: values.publish }).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { validateRun, verifyCandidate, publishAsset, extract, promote }
