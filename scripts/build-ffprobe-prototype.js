// Evaluation only: native macOS ARM64 FFprobe, no external codec libraries.
// Export a pinned clean source tree and build in-source for stable __FILE__ paths.
// No project helper, production manifest, global dependency or release is touched.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process"), { parseArgs } = require("node:util"), { createHash } = require("node:crypto")
const commit = "9047fa1b084f76b1b4d065af2d743df1b40dfb56" // FFmpeg n8.1
// Apple's clang 16 emitted variable vectorized code at the default -O3 in
// repeated identical builds. -O1 retains deterministic tested decoding here.
const configuration = ["--disable-everything", "--disable-autodetect", "--disable-network", "--disable-doc", "--disable-debug", "--disable-shared", "--enable-static", "--enable-ffprobe", "--enable-demuxers", "--enable-parsers", "--enable-decoders", "--enable-protocol=file,pipe,fd", "--disable-avdevice", "--disable-avfilter", "--disable-swscale", "--disable-swresample", "--optflags=-O1", "--extra-cflags=-mmacosx-version-min=13.0", "--extra-ldflags=-mmacosx-version-min=13.0"]
function build({ source, output }) {
  assert(process.platform === "darwin" && process.arch === "arm64", "prototype recipe is macOS ARM64 only")
  assert(source && output && path.isAbsolute(source) && path.isAbsolute(output))
  const revision = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" })
  assert.equal(revision.stdout.trim(), commit, "use the exact pinned upstream checkout")
  fs.mkdirSync(output)
  const tree = path.join(output, "source"); fs.mkdirSync(tree)
  const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }
  for (const key of ["CC", "CXX", "CFLAGS", "CPPFLAGS", "LDFLAGS", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET", "PKG_CONFIG_PATH", "FFREPORT"]) delete env[key]
  function run(name, exe, args, cwd = tree) {
    // An ARM64 Node can inherit an Intel preference for universal children.
    // Pin the launch architecture for configure, make and their toolchain too.
    const result = spawnSync("/usr/bin/arch", ["-arm64", exe, ...args], { cwd, env, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
    fs.writeFileSync(path.join(output, name + ".log"), (result.stdout || "") + (result.stderr || ""))
    assert.equal(result.status, 0, `${name} failed: ${result.error?.message || result.stderr?.slice(-500)}`)
    return result.stdout
  }
  const archive = path.join(output, "source.tar")
  run("archive", "git", ["-C", source, "archive", "--format=tar", "--output=" + archive, commit])
  run("extract", "tar", ["-xf", archive, "-C", tree])
  const childArchitecture = run("child-architecture", "/usr/bin/uname", ["-m"]).trim()
  assert.equal(childArchitecture, "arm64", "build children must execute as ARM64")
  const compiler = run("compiler", "/usr/bin/gcc", ["--version"]), sdk = run("sdk", "xcrun", ["--show-sdk-version"])
  const compilerTarget = run("compiler-target", "/usr/bin/gcc", ["-dumpmachine"]).trim()
  assert.match(compiler, /^Apple clang version /, "use the existing Apple clang toolchain")
  assert.match(compilerTarget, /^arm64-apple-darwin[\d.]+$/, "Apple compiler must target ARM64 Darwin")
  run("configure", "./configure", configuration)
  run("make", "make", ["-j4", "ffprobe"])
  const executable = path.join(output, "ffprobe"); fs.copyFileSync(path.join(tree, "ffprobe"), executable)
  const executableArchitecture = run("executable-architecture", "/usr/bin/lipo", ["-archs", executable]).trim()
  assert.equal(executableArchitecture, "arm64", "prototype output must be a thin ARM64 executable")
  const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  const facts = { evaluationOnly: true, publicationReady: false, source: "https://github.com/FFmpeg/FFmpeg", commit, configuration, compiler, sdk,
    childArchitecture, compilerTarget, executableArchitecture,
    archiveSha256: hash(archive), executableSha256: hash(executable), bytes: fs.statSync(executable).size,
    license: run("license", executable, ["-L"]), buildconf: run("buildconf", executable, ["-buildconf"]),
    libraries: run("libraries", "otool", ["-L", executable]), loadCommands: run("load-commands", "otool", ["-l", executable]) }
  fs.writeFileSync(path.join(output, "prototype.json"), JSON.stringify(facts, null, 2) + "\n")
  return facts
}
if (require.main === module) {
  const { values } = parseArgs({ options: { source: { type: "string" }, output: { type: "string" } } })
  console.log(JSON.stringify(build(values), null, 2))
}
module.exports = { build }
