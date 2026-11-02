// Opt-in, short-lived CI handoff. Never selects production pins or uploads releases.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const { readBuild, requirePassedValidation, verifyRuntimeNotices } = require("./package-ffprobe-source")
const { hash, sourcePin } = require("./build-ffprobe-prototype")
const { validateRecord, serialize } = require("./ffprobe-notices")
const { createHash } = require("node:crypto")
const repo = path.resolve(__dirname, "..")
function collectRuntimeNotices(output, platform, msysRoot = process.env.CLIPLY_FFPROBE_MSYS2) {
  fs.mkdirSync(output)
  const files = [], metadata = { platform, reviewed: platform === "darwin-arm64", files }
  function copy(file, name) {
    assert(fs.statSync(file).isFile(), "runtime notice missing: " + file)
    assert(fs.statSync(file).size <= 2 * 1024 * 1024, "unexpected runtime notice size")
    fs.copyFileSync(file, path.join(output, name), fs.constants.COPYFILE_EXCL)
    files.push({ installedPath: file, retainedName: name, sha256: hash(file) })
  }
  if (platform === "linux-x64") {
    // Includes compiler-runtime/startup-object notices; system shared libraries
    // are not copied. Actual imports and package versions remain in the build record.
    for (const name of ["gcc-13-base", "libgcc-13-dev", "libc6-dev"]) copy(`/usr/share/doc/${name}/copyright`, name + "-copyright.txt")
  } else if (platform === "win32-x64") {
    assert(msysRoot && path.isAbsolute(msysRoot), "native UCRT64 installation is required")
    const packages = ["gcc", "libgcc", "crt", "headers", "winpthreads", "libwinpthread"].map(name => "mingw-w64-ucrt-x86_64-" + name)
    function pacman(option, args = packages) {
      const result = spawnSync(path.join(msysRoot, "usr/bin/bash.exe"), ["-c", 'exec /usr/bin/pacman "$@"', "--", option, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30000 })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      return result.stdout
    }
    metadata.packages = pacman("-Qi")
    const threadArchive = path.join(msysRoot, "ucrt64/lib/libwinpthread.a")
    metadata.threadRuntimeArchive = { installedPath: threadArchive, sha256: hash(threadArchive),
      ownership: pacman("-Qo", ["/ucrt64/lib/libwinpthread.a"]) }
    const listing = pacman("-Ql")
    for (const line of listing.split(/\r?\n/)) {
      const match = line.match(/^(\S+) (\/ucrt64\/share\/licenses\/[A-Za-z0-9._/-]+)$/)
      if (!match || match[2].endsWith("/")) continue
      assert(!match[2].split("/").includes(".."))
      copy(path.join(msysRoot, ...match[2].split("/").filter(Boolean)), match[1] + "--" + match[2].slice(1).replaceAll("/", "__"))
    }
    assert(files.length, "native compiler/CRT license files were not found")
  } else assert.equal(platform, "darwin-arm64")
  fs.writeFileSync(path.join(output, "inventory.json"), JSON.stringify(metadata, null, 2) + "\n")
  return metadata
}
function retainCandidate({ buildDirectory, evidence, packetDirectory, output }) {
  assert(output && path.isAbsolute(output) && !fs.existsSync(output), "retention needs a new absolute output directory")
  const { facts, executable } = readBuild(buildDirectory)
  const artifact = requirePassedValidation(evidence, facts)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const staging = fs.mkdtempSync(path.join(path.dirname(output), ".ffprobe-review-"))
  try {
    function copy(input, relative) {
      const target = path.join(staging, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(input, target, fs.constants.COPYFILE_EXCL)
    }
    copy(executable, path.basename(executable))
    for (const name of ["prototype.json"]) copy(path.join(buildDirectory, name), "build/" + name)
    copy(path.join(buildDirectory, "source/ffbuild/config.mak"), "build/config.mak")
    for (const name of ["commands.json", "artifact.json"]) copy(path.join(evidence, name), "validation/" + name)
    const runtime = collectRuntimeNotices(path.join(staging, "runtime-notices"), facts.platform)
    let sourcePacket = null
    if (packetDirectory) {
      sourcePacket = JSON.parse(fs.readFileSync(path.join(packetDirectory, "source-packet.json"), "utf8"))
      assert.equal(sourcePacket.manifest.executableSha256, facts.executableSha256)
      assert.equal(path.basename(sourcePacket.assetName), sourcePacket.assetName)
      assert.equal(hash(path.join(packetDirectory, sourcePacket.assetName)), sourcePacket.sha256)
      copy(path.join(packetDirectory, sourcePacket.assetName), sourcePacket.assetName)
      copy(path.join(packetDirectory, "source-packet.json"), "source-packet.json")
    } else {
      // Review inputs, not a completed corresponding-source distribution packet.
      copy(path.join(buildDirectory, "source.tar"), "source-inputs/upstream/source.tar")
      for (const name of ["scripts/build-ffprobe-prototype.js", "third-party/ffprobe/source-build.json", "third-party/ffprobe/source-build.md", "third-party/ffprobe/NOTICE.source-build.txt", "LICENSE"]) copy(path.join(repo, name), "source-inputs/" + name)
      for (const name of Object.keys(sourcePin.licenseFiles)) copy(path.join(buildDirectory, "source", name), "source-inputs/notices/" + name)
    }
    const installed = path.join(evidence, "installed-notices")
    if (fs.existsSync(installed)) {
      const mapping = JSON.parse(fs.readFileSync(path.join(installed, "SOURCE.json"), "utf8"))
      validateRecord(mapping.record, facts.platform, null)
      assert.equal(createHash("sha256").update(serialize(mapping.record)).digest("hex"), mapping.recordSha256)
      assert.equal(mapping.record.binarySha256, facts.executableSha256)
      assert.equal(mapping.packagedSha256, artifact.packagedSha256)
      assert.equal(mapping.record.sourceAsset.sha256, sourcePacket?.sha256, "installed notices validated a different source packet")
      for (const [name, digest] of Object.entries(mapping.record.files)) assert.equal(hash(path.join(installed, name)), digest)
      fs.cpSync(installed, path.join(staging, "installed-notices"), { recursive: true })
    }
    function inventory(directory, prefix = "") {
      return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
        const relative = prefix + entry.name, file = path.join(directory, entry.name)
        assert(!entry.isSymbolicLink())
        return entry.isDirectory() ? Object.entries(inventory(file, relative + "/")) : [[relative, hash(file)]]
      }))
    }
    const record = { schema: 1, evaluationOnly: true, publicationReady: false, platform: facts.platform,
      nativeValidationPassed: true, executableSha256: facts.executableSha256, packagedSha256: artifact.packagedSha256,
      sourceCommit: facts.commit, sourceArchiveSha256: facts.archiveSha256, recipeSha256: facts.recipeSha256,
      runtimeNoticesReviewed: runtime.reviewed || Boolean(sourcePacket && verifyRuntimeNotices(facts, path.join(staging, "runtime-notices"))), installedNoticesValidated: fs.existsSync(installed), sourcePacketReadyForReview: Boolean(sourcePacket),
      remainingGates: ["review native/platform and minimum-OS evidence", "review complete source/runtime notices and installed mapping", "verify NEW shared assets before production pins"], files: inventory(staging) }
    fs.writeFileSync(path.join(staging, "REVIEW.json"), JSON.stringify(record, null, 2) + "\n")
    fs.renameSync(staging, output)
    return record
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error }
}
module.exports = { retainCandidate, requirePassedValidation, collectRuntimeNotices }
