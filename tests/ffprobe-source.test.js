const fs = require("node:fs"), os = require("node:os"), path = require("node:path")
const { inspectArchitecture, inspectConfiguration, inspectLibraries, configurationFor, exportSourceArchive } = require("../scripts/build-ffprobe-prototype")
const { execFileSync } = require("node:child_process")
const { validate } = require("../scripts/validate-ffprobe-candidate")
const configure = 'EXTERNAL_LIBRARY_GPL_LIST="\n libx264\n"\nEXTERNAL_LIBRARY_LIST="\n $EXTERNAL_LIBRARY_GPL_LIST\n"\nEXTERNAL_AUTODETECT_LIBRARY_LIST="\n zlib\n"\nHWACCEL_LIBRARY_LIST="\n libmfx\n"\nHWACCEL_AUTODETECT_LIBRARY_LIST="\n videotoolbox\n"\n'
const required = ["STATIC", "FFPROBE", "AVCODEC", "AVFORMAT", "AVUTIL", "H264_DECODER", "AAC_DECODER", "FD_PROTOCOL", "FILE_PROTOCOL", "PIPE_PROTOCOL"]
const config = required.map(name => "CONFIG_" + name + "=yes").join("\n") + "\n!CONFIG_GPL=yes\n"
test("final configuration rejects optional external libraries including nested GPL lists", () => {
  expect(inspectConfiguration(configure, config).externalLibrariesChecked).toBe(4)
  for (const name of ["LIBX264", "ZLIB", "LIBMFX", "VIDEOTOOLBOX"]) expect(() => inspectConfiguration(configure, config + "CONFIG_" + name + "=yes\n")).toThrow(/external/)
})
test.each(["GPL", "VERSION3", "NONFREE", "NETWORK", "SHARED", "FFMPEG", "FFPLAY", "AVFILTER"])("final configuration refuses %s", flag => {
  expect(() => inspectConfiguration(configure, config + "CONFIG_" + flag + "=yes\n")).toThrow(/unexpected/)
})
test("final configuration requires fd access and leading-video decode, and refuses other protocols", () => {
  expect(() => inspectConfiguration(configure, config.replace("CONFIG_H264_DECODER=yes", "!CONFIG_H264_DECODER=yes"))).toThrow(/H264_DECODER/)
  expect(() => inspectConfiguration(configure, config.replace("CONFIG_FD_PROTOCOL=yes", "!CONFIG_FD_PROTOCOL=yes"))).toThrow()
  expect(() => inspectConfiguration(configure, config + "CONFIG_HTTP_PROTOCOL=yes\n")).toThrow()
})
test("actual native headers reject wrong target or truncated executable", () => {
  const mach = Buffer.alloc(32); mach.writeUInt32LE(0xfeedfacf); mach.writeUInt32LE(0x0100000c, 4)
  expect(() => inspectArchitecture("darwin-arm64", mach)).not.toThrow()
  mach.writeUInt32LE(0x01000007, 4); expect(() => inspectArchitecture("darwin-arm64", mach)).toThrow()
  const elf = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18)
  expect(() => inspectArchitecture("linux-x64", elf)).not.toThrow()
  elf.writeUInt16LE(183, 18); expect(() => inspectArchitecture("linux-x64", elf)).toThrow()
  const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(0x20b, 88)
  expect(() => inspectArchitecture("win32-x64", pe)).not.toThrow()
  pe.writeUInt16LE(0x14c, 68); expect(() => inspectArchitecture("win32-x64", pe)).toThrow()
  expect(() => inspectArchitecture("win32-x64", pe.subarray(0, 65))).toThrow()
})
test("library gates permit recorded system imports and reject codec or developer runtime DLLs", () => {
  expect(inspectLibraries("darwin-arm64", "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)")).toHaveLength(1)
  expect(() => inspectLibraries("darwin-arm64", "\t/opt/homebrew/lib/libavcodec.dylib (compatibility version 1.0.0)")).toThrow()
  expect(inspectLibraries("linux-x64", "(NEEDED) Shared library: [libc.so.6]")).toEqual(["libc.so.6"])
  expect(() => inspectLibraries("linux-x64", "(NEEDED) Shared library: [libx264.so.164]")).toThrow()
  expect(inspectLibraries("win32-x64", "DLL Name: KERNEL32.dll\nDLL Name: api-ms-win-crt-runtime-l1-1-0.dll")).toHaveLength(2)
  for (const name of ["msys-2.0.dll", "libgcc_s_seh-1.dll", "libwinpthread-1.dll", "avcodec-62.dll"]) expect(() => inspectLibraries("win32-x64", "DLL Name: " + name)).toThrow()
})
test("unsupported build host cannot silently cross-build", () => {
  expect(() => configurationFor("darwin-x64")).toThrow(/Unsupported/)
  expect(() => configurationFor("linux-arm64")).toThrow(/Unsupported/)
})
test("Linux explicitly disables libc iconv without relaxing the final dependency audit", () => {
  expect(configurationFor("linux-x64")).toContain("--disable-iconv")
  const libcConfigure = configure.replace(" zlib", " iconv\n zlib")
  expect(() => inspectConfiguration(libcConfigure, config + "CONFIG_ICONV=yes\n")).toThrow(/external/)
  expect(inspectConfiguration(libcConfigure, config + "!CONFIG_ICONV=yes\n").externalEnabled).toEqual([])
})
test("Windows requests static compiler runtimes while the DLL gate still rejects winpthread", () => {
  const flags = configurationFor("win32-x64").find(option => option.startsWith("--extra-ldflags=")).slice("--extra-ldflags=".length).split(" ")
  expect(flags).toContain("-static")
  expect(() => inspectLibraries("win32-x64", "DLL Name: KERNEL32.dll\nDLL Name: libwinpthread-1.dll")).toThrow(/unexpected Windows DLL/)
})
test("source export overrides Windows CRLF and tar mode defaults without changing local Git settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-source-archive-"))
  const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  try {
    git(["init"])
    git(["config", "core.autocrlf", "false"])
    fs.writeFileSync(path.join(root, "source.c"), "first line\nsecond line\n")
    git(["add", "source.c"])
    const tree = git(["write-tree"])
    git(["config", "core.autocrlf", "true"])
    git(["config", "core.eol", "crlf"])
    git(["config", "tar.umask", "0000"])
    const archive = path.join(root, "source.tar"), extracted = path.join(root, "extracted")
    exportSourceArchive(root, archive, tree)
    fs.mkdirSync(extracted)
    await require("tar").x({ file: archive, cwd: extracted })
    expect(fs.readFileSync(path.join(extracted, "source.c"), "utf8")).toBe("first line\nsecond line\n")
    // tar header mode, independent of Windows filesystem permission semantics.
    expect(parseInt(fs.readFileSync(archive).toString("ascii", 100, 108), 8) & 0o777).toBe(0o664)
    expect(git(["config", "core.autocrlf"])).toBe("true")
    expect(git(["config", "core.eol"])).toBe("crlf")
    expect(git(["config", "tar.umask"])).toBe("0000")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test("source and supplier selection cannot be mixed or create an evidence directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-source-test-")), evidence = path.join(root, "evidence")
  try {
    await expect(validate({ archive: "supplier.zip", sourceBuild: root, evidence })).rejects.toThrow(/choose/)
    expect(fs.existsSync(evidence)).toBe(false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test("native workflow modes remain read-only and exclusive, with supplier priority", () => {
  const yaml = require("js-yaml")
  const ci = yaml.load(fs.readFileSync(path.join(__dirname, "../.github/workflows/ci.yml"), "utf8"))
  const source = yaml.load(fs.readFileSync(path.join(__dirname, "../.github/workflows/validate-ffprobe-source.yml"), "utf8"))
  expect(source.permissions).toEqual({ contents: "read" })
  expect(source.on.workflow_call.inputs.retain_artifacts).toEqual({ type: "boolean", default: false })
  expect(ci.on.workflow_dispatch.inputs.ffprobe_retain_artifacts.default).toBe(false)
  const retainedUpload = source.jobs.source.steps.find(step => step.name === "Retain validated helper and source inputs for review only")
  expect(retainedUpload.if).toBe("success() && inputs.retain_artifacts")
  expect(retainedUpload.with["retention-days"]).toBe(2)
  const jobs = ci.jobs, names = ["validate-ffprobe-candidate", "validate-ffprobe-source", "stage-linux-helpers", "check"]
  for (const candidate of [false, true]) for (const built of [false, true]) for (const staging of [false, true]) {
    const inputs = { ffprobe_candidate_check: candidate, ffprobe_source_check: built, stage_linux_helpers: staging }
    const active = names.filter(name => {
      const expression = jobs[name].if.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      return Function("github", "inputs", "return (" + expression + ")")({ event_name: "workflow_dispatch" }, inputs)
    })
    expect(active).toEqual([candidate ? names[0] : built ? names[1] : staging ? names[2] : names[3]])
  }
  expect(jobs["validate-ffprobe-source"].uses).toBe("./.github/workflows/validate-ffprobe-source.yml")
  expect(JSON.stringify(source)).not.toMatch(/contents":"write|--publish always|Build Release/)
})
