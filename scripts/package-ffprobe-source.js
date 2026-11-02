// Deterministic source/notice evaluation packets for explicitly reviewed inputs.
// Never publishes or modifies project binaries. Windows runtime review is pending.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict")
const { parseArgs } = require("node:util")
const { sourcePin, hash, configurationFor, inspectArchitecture, inspectConfiguration, inspectLibraries } = require("./build-ffprobe-prototype")
const repo = path.resolve(__dirname, "..")
const runtimePins = require("../third-party/ffprobe/runtime-notices.json")
const checks = ["package", "helpers", "libraries", "inspection", "export", "tracks", "remux", "trim", "packaged-ui", "normal-startup", "download-recovery", "url-media"]
function requirePassedValidation(evidence, facts) {
  const commands = JSON.parse(fs.readFileSync(path.join(evidence, "commands.json"), "utf8"))
  assert(commands.length && commands.every(command => command.status === 0 && !command.error), "cannot retain a failed validation")
  for (const name of checks) assert.equal(commands.filter(command => command.name === name).length, 1, "missing or repeated validation: " + name)
  const artifact = JSON.parse(fs.readFileSync(path.join(evidence, "artifact.json"), "utf8"))
  assert.equal(artifact.evidenceKind, "source-built")
  assert.equal(artifact.platform, facts.platform)
  assert.equal(artifact.inputSha256, facts.executableSha256, "validation used a different source-built helper")
  return artifact
}
function readBuild(directory, { validationDirectory } = {}) {
  assert(path.isAbsolute(directory), "use an absolute source-build directory")
  const facts = JSON.parse(fs.readFileSync(path.join(directory, "prototype.json"), "utf8"))
  const platform = facts.platform
  // Source assembly may use verified retained native inputs on another host;
  // it never executes that target. Normal validation still requires a native host.
  if (validationDirectory) requirePassedValidation(validationDirectory, facts)
  else assert.equal(platform, process.platform + "-" + process.arch, "source build must match the native validation host")
  assert.equal(facts.commit, sourcePin.commit)
  assert.equal(facts.archiveSha256, sourcePin.archiveSha256)
  assert.equal(hash(path.join(directory, "source.tar")), sourcePin.archiveSha256)
  assert.equal(facts.recipeSha256, hash(path.join(__dirname, "build-ffprobe-prototype.js")), "build recipe changed; rebuild")
  assert.equal(facts.sourcePinSha256, hash(path.join(repo, "third-party/ffprobe/source-build.json")))
  assert.deepEqual(facts.configuration, configurationFor(platform))
  const executable = path.join(directory, platform.startsWith("win32") ? "ffprobe.exe" : "ffprobe")
  assert.equal(hash(executable), facts.executableSha256, "built executable changed")
  assert.equal(fs.statSync(executable).size, facts.bytes)
  inspectArchitecture(platform, fs.readFileSync(executable))
  const makefile = path.join(directory, "source/ffbuild/config.mak")
  assert.equal(hash(makefile), facts.configSha256)
  assert.deepEqual(inspectConfiguration(fs.readFileSync(path.join(directory, "source/configure"), "utf8"), fs.readFileSync(makefile, "utf8")), facts.configAudit)
  assert.deepEqual(inspectLibraries(platform, facts.libraries), facts.systemLibraries)
  for (const [name, digest] of Object.entries(sourcePin.licenseFiles)) assert.equal(hash(path.join(directory, "source", name)), digest)
  return { facts, executable }
}
function verifyRuntimeNotices(facts, directory) {
  if (facts.platform === "darwin-arm64") return null
  const pin = runtimePins[facts.platform]
  assert(pin, "native runtime notice review is required before extending source packets")
  assert(directory && path.isAbsolute(directory), "pass exact native runtime notice inputs")
  assert.deepEqual([...facts.systemLibraries].sort(), pin.systemLibraries, "runtime imports changed; review required")
  assert.equal(facts.toolchain.packages, pin.toolchainPackages, "native toolchain packages changed; review required")
  for (const [name, digest] of Object.entries(pin.toolchainHashes)) assert.equal(facts.toolchain.files[name]?.sha256, digest, "native tool changed: " + name)
  for (const [name, digest] of Object.entries(pin.files)) {
    assert(fs.lstatSync(path.join(directory, name)).isFile(), "runtime notice must be a regular file")
    assert.equal(hash(path.join(directory, name)), digest, "runtime notice changed: " + name)
  }
  return pin
}
async function packageSource({ buildDirectory, output, runtimeDirectory, validationDirectory }) {
  const { facts } = readBuild(buildDirectory, { validationDirectory })
  const runtime = verifyRuntimeNotices(facts, runtimeDirectory)
  assert(path.isAbsolute(output)); fs.mkdirSync(output)
  const packet = path.join(output, "packet"); fs.mkdirSync(packet)
  function copy(input, relative) {
    const destination = path.join(packet, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(input, destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, 0o644)
  }
  copy(path.join(buildDirectory, "source.tar"), "upstream/source.tar")
  copy(path.join(repo, "LICENSE"), "licenses/Cliply-GPL-3.0.txt")
  for (const file of ["scripts/build-ffprobe-prototype.js", "scripts/package-ffprobe-source.js", "third-party/ffprobe/source-build.json", "third-party/ffprobe/runtime-notices.json", "third-party/ffprobe/NOTICE.source-build.txt", "third-party/ffprobe/source-build.md"]) copy(path.join(repo, file), file)
  for (const file of Object.keys(sourcePin.licenseFiles)) copy(path.join(buildDirectory, "source", file), "notices/" + file)
  if (runtime) for (const name of Object.keys(runtime.files)) copy(path.join(runtimeDirectory, name), "runtime-notices/" + name)
  // Fixed inputs => fixed packet. Remove task-specific path spelling, not toolchain
  // versions, hashes, configuration, licenses or library identities.
  const normalize = text => text.split(buildDirectory).join("$BUILD")
  fs.mkdirSync(path.join(packet, "build"))
  fs.writeFileSync(path.join(packet, "build/record.json"), normalize(JSON.stringify(facts, null, 2)) + "\n", { mode: 0o644 })
  fs.writeFileSync(path.join(packet, "build/config.mak"), normalize(fs.readFileSync(path.join(buildDirectory, "source/ffbuild/config.mak"), "utf8")), { mode: 0o644 })
  fs.writeFileSync(path.join(packet, "REPRODUCE.txt"), "Draft evaluation source packet; no publication approval.\n\nInstall the recorded native " + facts.platform + " toolchain and Node 22. Extract this packet.\nFrom its root, rebuild offline into a NEW absolute directory:\nnode scripts/build-ffprobe-prototype.js --archive /absolute/packet/upstream/source.tar --output /absolute/new-build\n\nNo Cliply dependencies, Python, external codec library or network is needed for that build.\nCompare source, recipe, toolchain, configuration and executable hashes in build/record.json.\nThe full original upstream source, including all per-file license notices, is in upstream/source.tar.\nSee third-party/ffprobe/source-build.md for distribution and packaging prerequisites.\n", { mode: 0o644 })
  function files(root, prefix = "") {
    return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
      const name = prefix ? prefix + "/" + entry.name : entry.name
      assert(!entry.isSymbolicLink(), "packet contains no symlinks")
      return entry.isDirectory() ? files(root, name) : [name]
    }).sort()
  }
  const entries = files(packet), checksums = Object.fromEntries(entries.map(name => [name, hash(path.join(packet, name))]))
  const tar = require("tar") // existing developer dependency via electron-builder; not an app dependency
  const manifest = { schema: 1, evaluationOnly: true, publicationReady: false, platform: facts.platform, sourceCommit: facts.commit, executableSha256: facts.executableSha256,
    packing: { node: process.version, zlib: process.versions.zlib, tar: require("tar/package.json").version, portable: true, mtime: 0, gzipLevel: 9, sortedEntries: true }, files: checksums }
  fs.writeFileSync(path.join(packet, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 })
  const archive = path.join(output, "source-packet.tar.gz"), packetFiles = files(packet)
  for (const name of packetFiles) fs.chmodSync(path.join(packet, name), 0o644)
  await tar.c({ cwd: packet, file: archive, portable: true, mtime: new Date(0), gzip: { level: 9 }, noDirRecurse: true }, packetFiles)
  const sha256 = hash(archive)
  // A notice/recipe revision can leave executable bytes unchanged. Include the
  // packet digest so a future NEW source asset cannot collide with that revision.
  const assetName = "ffprobe-source-" + facts.commit.slice(0, 12) + "-" + facts.platform + "-" + facts.executableSha256.slice(0, 12) + "-" + sha256.slice(0, 12) + ".tar.gz"
  fs.renameSync(archive, path.join(output, assetName))
  const result = { assetName, bytes: fs.statSync(path.join(output, assetName)).size, sha256, manifest, noticeBytes: Object.keys(sourcePin.licenseFiles).reduce((sum, name) => sum + fs.statSync(path.join(buildDirectory, "source", name)).size, 0) }
  fs.writeFileSync(path.join(output, "source-packet.json"), JSON.stringify(result, null, 2) + "\n")
  return result
}
function stageInstalledNotices({ buildDirectory, packetDirectory, output, validationDirectory }) {
  const { facts } = readBuild(buildDirectory, { validationDirectory })
  const packet = JSON.parse(fs.readFileSync(path.join(packetDirectory, "source-packet.json"), "utf8"))
  assert.equal(packet.manifest.executableSha256, facts.executableSha256)
  assert.equal(packet.manifest.sourceCommit, facts.commit)
  assert.equal(packet.manifest.platform, facts.platform)
  assert.equal(path.basename(packet.assetName), packet.assetName)
  assert.equal(hash(path.join(packetDirectory, packet.assetName)), packet.sha256, "source packet changed")
  const inputs = { "NOTICE.txt": "third-party/ffprobe/NOTICE.source-build.txt", "COPYING.LGPLv2.1": "notices/COPYING.LGPLv2.1" }
  const runtime = verifyRuntimeNotices(facts, path.join(packetDirectory, "packet/runtime-notices"))
  if (runtime) {
    inputs["COPYING.GPLv3"] = "notices/COPYING.GPLv3"
    for (const [name, input] of Object.entries(runtime.installedFiles)) inputs[name] = "runtime-notices/" + input
  }
  assert(path.isAbsolute(output)); fs.mkdirSync(output)
  const files = {}
  for (const [name, relative] of Object.entries(inputs)) {
    const input = path.join(packetDirectory, "packet", relative)
    assert.equal(hash(input), packet.manifest.files[relative], "packet notice changed")
    fs.copyFileSync(input, path.join(output, name), fs.constants.COPYFILE_EXCL)
    files[name] = hash(input)
  }
  const record = { schema: 1, evaluationOnly: true, platform: facts.platform, binarySha256: facts.executableSha256,
    sourceCommit: facts.commit, sourceArchiveSha256: facts.archiveSha256,
    sourceAsset: { name: packet.assetName, sha256: packet.sha256, url: null, assetId: null }, files }
  const recordFile = path.join(output, "SOURCE.json")
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n", { flag: "wx" })
  return recordFile
}
if (require.main === module) {
  const { values } = parseArgs({ options: { build: { type: "string" }, output: { type: "string" }, "runtime-notices": { type: "string" }, validation: { type: "string" } } })
  packageSource({ buildDirectory: values.build, output: values.output, runtimeDirectory: values["runtime-notices"], validationDirectory: values.validation }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { readBuild, packageSource, stageInstalledNotices, requirePassedValidation, verifyRuntimeNotices }
