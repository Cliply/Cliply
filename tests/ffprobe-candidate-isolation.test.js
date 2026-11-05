const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { prepareCandidateProject } = require("../scripts/validate-ffprobe-candidate")
const sourcePin = require("../third-party/ffprobe/source-build.json")

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-candidate-isolation-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

test.each([
  ["darwin-arm64", "macos", ""], ["linux-x64", "linux", ""], ["win32-x64", "windows", ".exe"]
])("%s evaluation replaces only its private helper and does not load production pins", (platform, directory, suffix) => {
  const sourceRoot = path.join(root, "repository"), project = path.join(root, "candidate")
  const write = (relative, contents) => {
    const file = path.join(sourceRoot, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents)
  }
  const record = { sha256: "a".repeat(64), assetId: 123,
    assetName: `ffprobe-${sourcePin.commit.slice(0, 12)}-${platform}-${"a".repeat(12)}${suffix}`,
    sourceRecord: `distributions/${platform}/SOURCE.json`, sourceRecordSha256: "b".repeat(64) }
  const published = JSON.stringify({ [platform]: record })
  write("third-party/ffprobe/published.json", published)
  write("third-party/ffprobe/source-build.json", JSON.stringify(sourcePin))
  write("third-party/ffprobe/runtime-notices.json", "{}")
  write("scripts/ffprobe-notices.js", "// fixture")
  write("scripts/fetch-helpers.js", fs.readFileSync(path.join(__dirname, "../scripts/fetch-helpers.js")))
  write("src/main/services/ytdlp-updater.js", "module.exports = {}")
  execFileSync("git", ["init", sourceRoot], { stdio: "pipe" })
  execFileSync("git", ["-C", sourceRoot, "add", "."], { stdio: "pipe" })
  // Explicit build/dependency trees are copied, unrelated user files are not.
  write("node_modules/fixture.txt", "dependency")
  write("src/main/renderer/dist/index.html", "renderer")
  const probe = `binaries/${directory}/ffprobe${suffix}`
  write(probe, "published helper")
  write(`binaries/${directory}/ffmpeg${suffix}`, "download helper")
  write(`binaries/deno/${directory}/deno${suffix}`, "deno helper")
  write("python/user-file.txt", "preserve this")
  const stagedProbe = path.join(root, "candidate-probe")
  fs.writeFileSync(stagedProbe, "new candidate")

  prepareCandidateProject({ sourceRoot, project, stagedProbe, platform })

  expect(fs.readFileSync(path.join(project, probe), "utf8")).toBe("new candidate")
  expect(fs.readFileSync(path.join(sourceRoot, probe), "utf8")).toBe("published helper")
  expect(fs.readFileSync(path.join(sourceRoot, "third-party/ffprobe/published.json"), "utf8")).toBe(published)
  expect(fs.readFileSync(path.join(project, `binaries/${directory}/ffmpeg${suffix}`), "utf8")).toBe("download helper")
  expect(fs.readFileSync(path.join(project, `binaries/deno/${directory}/deno${suffix}`), "utf8")).toBe("deno helper")
  expect(fs.existsSync(path.join(project, "python"))).toBe(false)
  expect(fs.readFileSync(path.join(sourceRoot, "python/user-file.txt"), "utf8")).toBe("preserve this")
  // A fresh verifier process must load the private manifest, while the original
  // checkout continues to enforce its published record.
  const query = `process.stdout.write(JSON.stringify(require('./scripts/fetch-helpers').ffprobeRelease(${JSON.stringify(platform)})))`
  expect(execFileSync(process.execPath, ["-e", query], { cwd: project, encoding: "utf8" })).toBe("null")
  expect(JSON.parse(execFileSync(process.execPath, ["-e", query], { cwd: sourceRoot, encoding: "utf8" }))).toEqual(record)
  expect(() => prepareCandidateProject({ sourceRoot, project: sourceRoot, stagedProbe, platform })).toThrow(/EEXIST/)
  expect(fs.readFileSync(path.join(sourceRoot, probe), "utf8")).toBe("published helper")
})
