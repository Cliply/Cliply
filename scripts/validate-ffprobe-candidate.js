// Explicit prepublication validation. Never writes production pins or project
// binaries: all candidate inputs, packages and media live in an owned copy.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const { parseArgs } = require("node:util")
const { stageFfprobe, hash } = require("./stage-ffprobe")
const { createHttpClient } = require("../src/main/services/ytdlp-updater")
const candidates = require("../third-party/ffprobe/candidates.json")
const repo = path.resolve(__dirname, "..")

async function validate({ archive, evidence }) {
  const platform = `${process.platform}-${process.arch}`, candidate = candidates[platform]
  assert(candidate, `Unsupported native host: ${platform}`)
  assert(evidence && path.isAbsolute(evidence), "Pass a new absolute --evidence directory")
  fs.mkdirSync(evidence) // Never overwrite an existing evidence packet.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-candidate-"))
  const manifest = path.join(repo, "third-party/ffprobe/published.json"), initialManifest = await hash(manifest)
  const commands = []
  function run(name, executable, args, env = {}) {
    const result = spawnSync(executable, args, { cwd: repo, env: { ...process.env, ...env }, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
    fs.writeFileSync(path.join(evidence, name + ".log"), (result.stdout || "") + (result.stderr || ""))
    commands.push({ name, executable, args, status: result.status, error: result.error?.message })
    assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr?.slice(-2000)}`)
    return result.stdout
  }
  try {
    if (!archive) {
      archive = path.join(scratch, candidate.url.endsWith(".zip") ? "candidate.zip" : "candidate.tar.xz")
      await createHttpClient().download(candidate.url, archive, { signal: AbortSignal.timeout(10 * 60 * 1000) })
    }
    const staged = path.join(scratch, "staged")
    const facts = await stageFfprobe({ platform, archive: path.resolve(archive), output: staged })
    assert(facts.nativeExecution, "native execution is required")
    fs.writeFileSync(path.join(evidence, "candidate.json"), JSON.stringify(facts, null, 2) + "\n")
    const project = path.join(scratch, "project"); fs.mkdirSync(project)
    // Copy only tracked project inputs, then explicit built/dependency/helper
    // trees. Never copy unrelated untracked user files (such as python/).
    const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" })
    assert.equal(tracked.status, 0)
    for (const relative of new Set([...tracked.stdout.split("\0").filter(Boolean), "third-party/ffprobe/published.json"])) {
      const destination = path.join(project, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(repo, relative), destination)
    }
    const directory = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform]
    for (const relative of ["node_modules", "src/main/renderer/dist", `binaries/${directory}`, `binaries/deno/${directory}`]) {
      fs.cpSync(path.join(repo, relative), path.join(project, relative), { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE })
    }
    const suffix = process.platform === "win32" ? ".exe" : ""
    const probe = path.join(project, "binaries", directory, "ffprobe" + suffix)
    fs.copyFileSync(path.join(staged, facts.asset), probe, fs.constants.COPYFILE_EXCL)
    const config = { ...require("../package.json").build, extends: null, npmRebuild: false,
      electronDist: path.join(repo, "node_modules/electron/dist"), directories: { ...require("../package.json").build.directories, output: path.join(scratch, "package") } }
    const configFile = path.join(scratch, "build.json"); fs.writeFileSync(configFile, JSON.stringify(config))
    run("package", process.execPath, [path.join(repo, "node_modules/electron-builder/cli.js"), "--projectDir", project, "--config", configFile, "--dir", { darwin: "--mac", linux: "--linux", win32: "--win" }[process.platform], "--publish", "never"], {
      CSC_IDENTITY_AUTO_DISCOVERY: "false", CLIPLY_REQUIRE_FFPROBE: "1", ELECTRON_BUILDER_CACHE: path.join(scratch, "builder-cache")
    })
    const resources = path.join(scratch, "package", ...({ darwin: ["mac-arm64", "Cliply.app", "Contents", "Resources"], linux: ["linux-unpacked", "resources"], win32: ["win-unpacked", "resources"] }[process.platform]))
    const ffmpeg = path.join(resources, "binaries", "ffmpeg" + suffix), ffprobe = path.join(resources, "binaries", "ffprobe" + suffix)
    run("helpers", process.execPath, ["scripts/verify-packaged-helpers.js", "--resources", resources, "--require-ffprobe"])
    if (process.platform === "darwin") run("libraries", "otool", ["-L", ffprobe])
    if (process.platform === "linux") run("libraries", "ldd", [ffprobe])
    if (process.platform === "win32") {
      const vswhere = path.join(process.env["ProgramFiles(x86)"], "Microsoft Visual Studio", "Installer", "vswhere.exe")
      const dumpbin = run("find-dll-inspector", vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-find", "VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe"]).trim().split(/\r?\n/)[0]
      assert(dumpbin && fs.existsSync(dumpbin), "native Visual Studio dumpbin is required for DLL evidence")
      run("libraries", dumpbin, ["/dependents", ffprobe])
    }
    run("inspection", process.execPath, ["scripts/smoke-local-media.js", "--ffprobe", ffprobe, "--ffmpeg", ffmpeg])
    for (const [name, json] of [["export", "extraction"], ["tracks", "tracks"], ["remux", "remux"], ["trim", "trim"]]) {
      const media = path.join(scratch, name)
      run(name, process.execPath, [`scripts/smoke-local-${name}.js`, media, ffmpeg, ffprobe])
      fs.copyFileSync(path.join(media, `${json}-evidence.json`), path.join(evidence, `${name}.json`))
    }
    run("packaged-ui", process.execPath, ["scripts/smoke-packaged-local-media.js", "--resources", resources], { CLIPLY_SMOKE_EVIDENCE: path.join(evidence, "ui") })
    run("normal-startup", process.execPath, ["scripts/smoke-packaged-local-media.js", "--resources", resources, "--normal-startup"])
    run("download-recovery", process.execPath, ["scripts/smoke-download-recovery.js", "--resources", resources, "--local-media"])
    run("url-media", process.execPath, ["scripts/smoke-media.js", "--resources", resources])
    console.log(`Native candidate validation passed for ${platform}; this is not publication approval`)
  } finally {
    fs.writeFileSync(path.join(evidence, "commands.json"), JSON.stringify(commands, null, 2) + "\n")
    fs.rmSync(scratch, { recursive: true, force: true })
    assert.equal(await hash(manifest), initialManifest, "production manifest unchanged")
  }
}
if (require.main === module) {
  const { values } = parseArgs({ options: { archive: { type: "string" }, evidence: { type: "string" } } })
  validate(values).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { validate }
