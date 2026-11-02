// Evaluation only: native source-built FFprobe; never changes project helpers.
// Clean pinned source, internal codecs only, and explicit native toolchains.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process"), { parseArgs } = require("node:util"), { createHash } = require("node:crypto")
const sourcePin = require("../third-party/ffprobe/source-build.json")
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
// Preserve the reviewed Mac configure options/ordering and -O1 artifact.
const common = ["--disable-everything", "--disable-autodetect", "--disable-network", "--disable-doc", "--disable-debug", "--disable-shared", "--enable-static", "--enable-ffprobe", "--enable-demuxers", "--enable-parsers", "--enable-decoders", "--enable-protocol=file,pipe,fd", "--disable-avdevice", "--disable-avfilter", "--disable-swscale", "--disable-swresample", "--optflags=-O1"]
function configurationFor(platform) {
  if (platform === "darwin-arm64") return [...common, "--extra-cflags=-mmacosx-version-min=13.0", "--extra-ldflags=-mmacosx-version-min=13.0"]
  // Pinned configure still probes libc iconv with autodetection disabled.
  // Keep the no-external-library contract explicit on glibc hosts.
  if (platform === "linux-x64") return [...common, "--disable-iconv", "--arch=x86_64", "--target-os=linux", "--cc=/usr/bin/gcc-13", "--x86asmexe=/usr/bin/nasm", "--extra-cflags=-march=x86-64"]
  // UCRT64 GCC's runtime can pull winpthreads even with FFmpeg pthreads off.
  // Select static runtime archives; the system-only DLL audit still applies.
  if (platform === "win32-x64") return [...common, "--arch=x86_64", "--target-os=mingw32", "--cc=/ucrt64/bin/gcc", "--x86asmexe=/ucrt64/bin/nasm", "--disable-pthreads", "--enable-w32threads", "--extra-cflags=-march=x86-64", "--extra-ldflags=-static -static-libgcc -Wl,--no-insert-timestamp"]
  throw new Error("Unsupported native source-build host: " + platform)
}
function inspectConfiguration(configure, makefile) {
  const enabled = new Set([...makefile.matchAll(/^CONFIG_(\w+)=yes$/gm)].map(match => match[1]))
  function words(name) {
    const match = configure.match(new RegExp("^" + name + '="([^"]*)"', "m"))
    assert(match, "missing pinned configure list: " + name)
    return match[1].trim().split(/\s+/).flatMap(word => word.startsWith("$") ? words(word.slice(1)) : [word])
  }
  const external = [...new Set(["EXTERNAL_LIBRARY_LIST", "EXTERNAL_AUTODETECT_LIBRARY_LIST", "HWACCEL_LIBRARY_LIST", "HWACCEL_AUTODETECT_LIBRARY_LIST"].flatMap(words))]
  const externalEnabled = external.filter(name => enabled.has(name.toUpperCase()))
  assert.deepEqual(externalEnabled, [], "unexpected external library/hardware dependency")
  for (const name of ["GPL", "GPLV3", "VERSION3", "NONFREE", "NETWORK", "SHARED", "FFMPEG", "FFPLAY", "AVDEVICE", "AVFILTER", "SWSCALE", "SWRESAMPLE"]) assert(!enabled.has(name), "unexpected enabled configuration: " + name)
  for (const name of ["STATIC", "FFPROBE", "AVCODEC", "AVFORMAT", "AVUTIL", "H264_DECODER", "AAC_DECODER"]) assert(enabled.has(name), "missing required configuration: " + name)
  const protocols = [...enabled].filter(name => name.endsWith("_PROTOCOL")).sort()
  assert.deepEqual(protocols, ["FD_PROTOCOL", "FILE_PROTOCOL", "PIPE_PROTOCOL"])
  return { externalLibrariesChecked: external.length, externalEnabled, protocols, enabled: [...enabled].sort() }
}
function inspectLibraries(platform, listing) {
  let libraries
  if (platform === "darwin-arm64") {
    libraries = [...listing.matchAll(/^\s+(\S+) \(compatibility version/gm)].map(match => match[1])
    const allowed = new Set(["/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation", "/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo", "/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia"])
    assert(libraries.length && libraries.every(name => allowed.has(name)), "unexpected Mac library")
  } else if (platform === "linux-x64") {
    libraries = [...listing.matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/g)].map(match => match[1])
    assert(libraries.length && libraries.every(name => /^(lib(c|m|pthread|dl|rt)\.so\.[0-9]+|libgcc_s\.so\.1|ld-linux-x86-64\.so\.2)$/.test(name)), "unexpected Linux library")
  } else {
    libraries = [...listing.matchAll(/DLL Name:\s*(\S+)/gi)].map(match => match[1].toLowerCase())
    assert(libraries.length && libraries.every(name => /^(kernel32|msvcrt|ucrtbase|advapi32|bcrypt|ole32|oleaut32|user32|ws2_32|winmm|secur32|shell32)\.dll$/.test(name) || /^api-ms-win-crt-[a-z0-9-]+\.dll$/.test(name)), "unexpected Windows DLL (do not bundle an unreviewed runtime)")
  }
  return libraries
}
function inspectArchitecture(platform, data) {
  if (platform === "darwin-arm64") assert(data.length >= 8 && data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === 0x0100000c, "expected thin ARM64 Mach-O")
  else if (platform === "linux-x64") assert(data.length >= 20 && data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && data[4] === 2 && data[5] === 1 && data.readUInt16LE(18) === 62, "expected x86-64 little-endian ELF64")
  else {
    assert(data.length >= 64 && data.toString("ascii", 0, 2) === "MZ", "expected PE executable")
    const offset = data.readUInt32LE(60)
    assert(offset + 26 <= data.length && data.readUInt32LE(offset) === 0x4550 && data.readUInt16LE(offset + 4) === 0x8664 && data.readUInt16LE(offset + 24) === 0x20b, "expected x64 PE32+")
  }
}
function exportSourceArchive(source, archive, revision) {
  // Git for Windows defaults to CRLF conversion, including `git archive`.
  // Export the pinned LF source and canonical modes without changing Git config.
  const result = spawnSync("git", ["-C", source, "-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "tar.umask=0002",
    "archive", "--format=tar", "--output=" + archive, revision], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
}
function build({ source, archive: inputArchive, output, msysRoot = process.env.CLIPLY_FFPROBE_MSYS2 }) {
  const platform = process.platform + "-" + process.arch, configuration = configurationFor(platform)
  const recipeSha256 = hash(__filename), sourcePinSha256 = hash(path.join(__dirname, "../third-party/ffprobe/source-build.json"))
  assert(Boolean(source) !== Boolean(inputArchive), "pass exactly one of --source or --archive")
  assert(output && path.isAbsolute(output) && path.isAbsolute(source || inputArchive), "use absolute paths")
  if (source) {
    const revision = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" })
    assert.equal(revision.status, 0, revision.stderr)
    assert.equal(revision.stdout.trim(), sourcePin.commit, "use the exact pinned upstream checkout")
  }
  const windows = process.platform === "win32", mac = process.platform === "darwin"
  if (windows) assert(msysRoot && path.isAbsolute(msysRoot) && fs.existsSync(path.join(msysRoot, "usr/bin/bash.exe")), "pass the native MSYS2 UCRT64 root with --msys-root")
  fs.mkdirSync(output)
  const tree = path.join(output, "source"); fs.mkdirSync(tree)
  const env = { ...process.env, LC_ALL: "C" }
  for (const key of Object.keys(env)) if (/^(CC|CXX|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|SDKROOT|MACOSX_DEPLOYMENT_TARGET|PKG_CONFIG_PATH|CPATH|LIBRARY_PATH|FFREPORT|MSYS2_ARG_CONV_EXCL|PATH)$/i.test(key)) delete env[key]
  env.PATH = windows ? path.join(msysRoot, "ucrt64/bin") + ";" + path.join(msysRoot, "usr/bin") + ";" + path.join(process.env.SystemRoot, "System32") : "/usr/bin:/bin:/usr/sbin:/sbin"
  const msysPath = value => {
    const unix = value.replace(/\\/g, "/")
    assert(/^[A-Za-z]:\//.test(unix), "MSYS builds require a local drive path")
    return "/" + unix[0].toLowerCase() + unix.slice(2)
  }
  const nativePath = value => windows ? msysPath(value) : value
  function run(name, exe, args, cwd = tree) {
    const command = mac ? "/usr/bin/arch" : windows ? path.join(msysRoot, "usr/bin/bash.exe") : exe
    const argv = mac ? ["-arm64", exe, ...args] : windows ? ["-c", 'export PATH=/ucrt64/bin:/usr/bin; exec "$@"', "--", exe, ...args] : args
    const result = spawnSync(command, argv, { cwd, env: { ...env, ...(windows ? { MSYSTEM: "UCRT64" } : {}) }, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
    fs.writeFileSync(path.join(output, name + ".log"), (result.stdout || "") + (result.stderr || ""))
    assert.equal(result.status, 0, name + " failed: " + (result.error?.message || result.stderr?.slice(-800)))
    return result.stdout
  }
  const archive = path.join(output, "source.tar")
  if (inputArchive) fs.copyFileSync(inputArchive, archive, fs.constants.COPYFILE_EXCL)
  else {
    // Native Git acquisition is read-only. Every build child below uses the
    // explicit platform launcher; Mac never inherits an Intel preference.
    exportSourceArchive(source, archive, sourcePin.commit)
  }
  assert.equal(hash(archive), sourcePin.archiveSha256, "source archive checksum mismatch")
  run("extract", "tar", ["-xf", nativePath(archive), "-C", nativePath(tree)])
  for (const [file, digest] of Object.entries(sourcePin.licenseFiles)) assert.equal(hash(path.join(tree, file)), digest, "upstream notice/source changed: " + file)
  const childArchitecture = run("child-architecture", "uname", ["-m"]).trim()
  assert.equal(childArchitecture, mac ? "arm64" : "x86_64", "unexpected child architecture")
  const cc = mac ? "/usr/bin/gcc" : windows ? "/ucrt64/bin/gcc" : "/usr/bin/gcc-13"
  const compiler = run("compiler", cc, ["--version"]), compilerTarget = run("compiler-target", cc, ["-dumpmachine"]).trim()
  assert.match(compilerTarget, mac ? /^arm64-apple-darwin[\d.]+$/ : windows ? /^x86_64-w64-mingw32$/ : /^x86_64-linux-gnu$/, "unexpected native compiler target")
  if (mac) assert.match(compiler, /^Apple clang version /, "expected Apple clang")
  else assert.match(compiler, /gcc|GCC/, "expected the configured native GCC")
  const toolchain = { node: process.version, make: run("make-version", "make", ["--version"]), imageVersion: process.env.ImageVersion || null, files: {} }
  if (mac) {
    toolchain.sdk = run("sdk", "xcrun", ["--show-sdk-version"]).trim()
    const sdkPath = run("sdk-path", "xcrun", ["--show-sdk-path"]).trim()
    toolchain.files["SDKSettings.json"] = hash(path.join(sdkPath, "SDKSettings.json"))
    for (const name of ["clang", "ld", "ar"]) {
      const file = run("tool-path-" + name, "xcrun", ["--find", name]).trim()
      toolchain.files[name] = { path: file, sha256: hash(file) }
    }
  } else {
    toolchain.nasm = run("nasm", windows ? "/ucrt64/bin/nasm" : "/usr/bin/nasm", ["-v"])
    toolchain.linker = run("linker", windows ? "/ucrt64/bin/ld" : "/usr/bin/ld", ["--version"])
    for (const name of [windows ? "gcc" : "gcc-13", "nasm", "ld"]) {
      const file = windows ? path.join(msysRoot, "ucrt64/bin", name + ".exe") : "/usr/bin/" + name
      toolchain.files[name] = { path: file, sha256: hash(file) }
    }
    toolchain.packages = windows ? run("tool-packages", "/usr/bin/pacman", ["-Q"]) : run("tool-packages", "/usr/bin/dpkg-query", ["-W", "gcc-13", "libgcc-13-dev", "libc6-dev", "binutils", "nasm", "make"])
  }
  run("configure", "./configure", configuration)
  const configPath = path.join(tree, "ffbuild/config.mak")
  const configAudit = inspectConfiguration(fs.readFileSync(path.join(tree, "configure"), "utf8"), fs.readFileSync(configPath, "utf8"))
  run("make", "make", ["-j4", "ffprobe" + (windows ? ".exe" : "")])
  const executable = path.join(output, "ffprobe" + (windows ? ".exe" : ""))
  fs.copyFileSync(path.join(tree, path.basename(executable)), executable)
  inspectArchitecture(platform, fs.readFileSync(executable))
  const target = nativePath(executable)
  const libraries = mac ? run("libraries", "otool", ["-L", target]) : windows ? run("libraries", "/ucrt64/bin/objdump", ["-p", target]) : run("libraries", "/usr/bin/readelf", ["-d", target])
  const systemLibraries = inspectLibraries(platform, libraries)
  const loadCommands = mac ? run("load-commands", "otool", ["-l", target]) : windows ? run("load-commands", "/ucrt64/bin/objdump", ["-f", target]) : run("load-commands", "/usr/bin/readelf", ["-h", "-V", target])
  if (mac) assert.match(loadCommands, /minos 13\.0\b/, "unexpected Mac deployment target")
  if (process.platform === "linux") assert.doesNotMatch(run("library-resolution", "/usr/bin/ldd", [target]), /not found/)
  const license = run("license", target, ["-L"])
  assert.match(license, /GNU Lesser General Public\s+License.*version 2\.1/s, "unexpected FFprobe license")
  const facts = { evaluationOnly: true, publicationReady: false, platform, source: sourcePin.source, commit: sourcePin.commit, configuration, compiler, compilerTarget, childArchitecture, executableArchitecture: process.arch,
    toolchain, recipeSha256, sourcePinSha256, archiveSha256: hash(archive), executableSha256: hash(executable), bytes: fs.statSync(executable).size,
    configSha256: hash(configPath), configAudit, license, buildconf: run("buildconf", target, ["-buildconf"]), version: run("version", target, ["-version"]), systemLibraries, libraries, loadCommands }
  fs.writeFileSync(path.join(output, "prototype.json"), JSON.stringify(facts, null, 2) + "\n")
  return facts
}
if (require.main === module) {
  const { values } = parseArgs({ options: { source: { type: "string" }, archive: { type: "string" }, output: { type: "string" }, "msys-root": { type: "string" } } })
  console.log(JSON.stringify(build({ ...values, msysRoot: values["msys-root"] }), null, 2))
}
module.exports = { build, sourcePin, configurationFor, inspectConfiguration, inspectLibraries, inspectArchitecture, exportSourceArchive, hash }
