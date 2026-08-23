// after-pack is build-critical: it thins and signs the engine that ships in
// the installer. these tests drive it against a real temp tree of real mach-o
// headers, with the external commands (lipo, codesign) injected, so the
// failure paths can be exercised without a mac toolchain or a 124 MB engine.
//
// the invariant under test throughout: anything the packaged app cannot run
// without must ABORT the build rather than warn and continue.

const fs = require("fs")
const fsp = require("fs").promises
const os = require("os")
const path = require("path")

const afterPack = require("../scripts/after-pack")
const {
  prepareMacOS,
  prepareWindows,
  prepareLinux,
  collectBinaries,
  requireEngineDir,
  requireEngineExecutable,
  resolveTargetArch,
  thinYtdlpEngine,
  signYtdlpEngine,
  auditYtdlpEngine,
  lipoArchs,
  adhocSign,
  isMachO
} = afterPack

// electron-builder's Arch enum
const ARCH_X64 = 1
const ARCH_ARM64 = 3
const ARCH_UNIVERSAL = 4

// 64-bit mach-o, big-endian magic as isMachO reads it
const MACH_O_HEADER = Buffer.from([0xfe, 0xed, 0xfa, 0xcf])

let workspaces = []

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "after-pack-test-"))
  workspaces.push(root)
  return root
}

/**
 * an engine tree whose files carry genuine mach-o magic
 * @param {Object} layout - relative path -> {machO, size} or true for a default mach-o
 * @returns {string} the engine directory
 */
function makeEngine(layout) {
  const engineDir = path.join(makeWorkspace(), "binaries", "ytdlp")

  for (const [relative, spec] of Object.entries(layout)) {
    const full = path.join(engineDir, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })

    const isMacho = spec === true || spec?.machO !== false
    const padding = Buffer.alloc((spec && spec.size) || 32)

    fs.writeFileSync(
      full,
      isMacho ? Buffer.concat([MACH_O_HEADER, padding]) : Buffer.from("not a binary")
    )
    fs.chmodSync(full, (spec && spec.mode) || 0o644)
  }

  return engineDir
}

/**
 * write a file, creating its parents
 * @param {string} full - absolute path
 * @param {boolean} machO - give it real mach-o magic
 */
function writeFile(full, machO = false) {
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(
    full,
    machO ? Buffer.concat([MACH_O_HEADER, Buffer.alloc(32)]) : Buffer.from("x")
  )
  fs.chmodSync(full, 0o644)
}

/**
 * a packaged app tree as electron-builder would leave it
 *
 * @param {string} platform - node platform key
 * @param {Object} options - {engine: relative->machO map, binaries: string[]}
 * @returns {Object} {appOutDir, resourcesPath, packager}
 */
function makePackage(platform, { engine = {}, binaries = [] } = {}) {
  const appOutDir = makeWorkspace()
  const resourcesPath =
    platform === "darwin"
      ? path.join(appOutDir, "Cliply.app", "Contents", "Resources")
      : path.join(appOutDir, "resources")

  fs.mkdirSync(path.join(resourcesPath, "binaries", "ytdlp"), { recursive: true })

  for (const [relative, machO] of Object.entries(engine)) {
    writeFile(path.join(resourcesPath, "binaries", "ytdlp", relative), machO !== false)
  }

  for (const relative of binaries) {
    writeFile(path.join(resourcesPath, "binaries", relative))
  }

  return {
    appOutDir,
    resourcesPath,
    packager: { appInfo: { productFilename: "Cliply" } }
  }
}

// the full set of helper binaries each platform must ship
const FULL_BINARIES = {
  darwin: ["ffmpeg", path.join("deno", "deno")],
  win32: ["ffmpeg.exe", path.join("deno", "deno.exe")],
  linux: ["ffmpeg", path.join("deno", "deno")]
}

/**
 * a fake lipo/codesign pair
 *
 * @param {Object} options - {archs, thin, sign, verify} - each a map or fn
 * @returns {Object} tools with a recorded call log
 */
function makeTools({ archs = () => ["arm64"], thin, sign, verify } = {}) {
  const calls = []

  const resolveArchs = (file) => {
    const value = typeof archs === "function" ? archs(file) : archs[path.basename(file)]
    if (value instanceof Error) throw value
    return value === undefined ? ["arm64"] : value
  }

  const tools = {
    calls,
    // what lipo would report next time it is asked
    archState: new Map(),

    async output(cmd, args) {
      calls.push([cmd, ...args])

      if (cmd === "lipo" && args[0] === "-archs") {
        const file = args[1]

        if (tools.archState.has(file)) {
          return `${tools.archState.get(file).join(" ")}\n`
        }

        return `${resolveArchs(file).join(" ")}\n`
      }

      throw new Error(`unexpected output command: ${cmd}`)
    },

    async run(cmd, args) {
      calls.push([cmd, ...args])

      if (cmd === "lipo" && args[0] === "-thin") {
        const [, target, source, , output] = args
        if (thin) await thin(source, target)
        // a real lipo writes the thinned copy to -output
        await fsp.copyFile(source, output)
        tools.archState.set(source, [target])
        return
      }

      if (cmd === "codesign" && args[0] === "--force") {
        const file = args[args.length - 1]
        if (sign) await sign(file)
        tools.signed = tools.signed || new Set()
        tools.signed.add(path.basename(file))
        return
      }

      if (cmd === "codesign" && args[0] === "--verify") {
        const file = args[args.length - 1]
        if (verify) await verify(file)
        return
      }

      throw new Error(`unexpected run command: ${cmd} ${args.join(" ")}`)
    }
  }

  return tools
}

afterEach(() => {
  for (const dir of workspaces) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  workspaces = []
})

describe("isMachO", () => {
  it("recognises a mach-o header and rejects ordinary files", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true, "README.txt": { machO: false } })

    expect(await isMachO(path.join(engineDir, "yt-dlp_macos"))).toBe(true)
    expect(await isMachO(path.join(engineDir, "README.txt"))).toBe(false)
  })
})

describe("requireEngineDir", () => {
  it("fails the build when the engine was never fetched", async () => {
    const resources = makeWorkspace()

    await expect(requireEngineDir(resources)).rejects.toThrow(/no yt-dlp engine/)
  })

  it("rejects a file standing where the engine directory should be", async () => {
    const resources = makeWorkspace()
    fs.mkdirSync(path.join(resources, "binaries"), { recursive: true })
    fs.writeFileSync(path.join(resources, "binaries", "ytdlp"), "oops")

    await expect(requireEngineDir(resources)).rejects.toThrow(/no yt-dlp engine/)
  })

  it("returns the directory when it is there", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const resources = path.dirname(path.dirname(engineDir))

    await expect(requireEngineDir(resources)).resolves.toBe(engineDir)
  })
})

describe("requireEngineExecutable", () => {
  // the review's blocker: a directory that merely exists is not an engine
  it("rejects an empty engine directory", async () => {
    const engineDir = path.join(makeWorkspace(), "ytdlp")
    fs.mkdirSync(engineDir, { recursive: true })

    await expect(requireEngineExecutable(engineDir, "win32")).rejects.toThrow(
      /no runnable yt-dlp executable/
    )
  })

  it("rejects an engine holding only its _internal payload", async () => {
    const engineDir = makeEngine({ "_internal/libssl.dylib": true })

    await expect(requireEngineExecutable(engineDir, "darwin")).rejects.toThrow(
      /no runnable yt-dlp executable/
    )
  })

  it("resolves each platform's entry point the way the app does", async () => {
    const mac = makeEngine({ "yt-dlp_macos": true })
    const win = makeEngine({ "yt-dlp.exe": true })
    const linux = makeEngine({ "yt-dlp_linux": true })

    await expect(requireEngineExecutable(mac, "darwin")).resolves.toBe(
      path.join(mac, "yt-dlp_macos")
    )
    await expect(requireEngineExecutable(win, "win32")).resolves.toBe(
      path.join(win, "yt-dlp.exe")
    )
    await expect(requireEngineExecutable(linux, "linux")).resolves.toBe(
      path.join(linux, "yt-dlp_linux")
    )
  })

  it("does not accept another platform's executable", async () => {
    const engineDir = makeEngine({ "yt-dlp.exe": true })

    await expect(requireEngineExecutable(engineDir, "darwin")).rejects.toThrow(
      /no runnable yt-dlp executable/
    )
  })
})

describe("collectBinaries", () => {
  it.each(["darwin", "win32", "linux"])(
    "returns the required binaries on %s when all are present",
    async (platform) => {
      const { resourcesPath } = makePackage(platform, {
        binaries: FULL_BINARIES[platform]
      })

      const found = await collectBinaries(
        path.join(resourcesPath, "binaries"),
        platform
      )

      expect(found).toHaveLength(2)
    }
  )

  it.each(["darwin", "win32", "linux"])(
    "aborts on %s when ffmpeg is missing",
    async (platform) => {
      const { resourcesPath } = makePackage(platform, {
        binaries: [FULL_BINARIES[platform][1]]
      })

      await expect(
        collectBinaries(path.join(resourcesPath, "binaries"), platform)
      ).rejects.toThrow(/missing required binaries: ffmpeg/)
    }
  )

  it.each(["darwin", "win32", "linux"])(
    "aborts on %s when deno is missing",
    async (platform) => {
      const { resourcesPath } = makePackage(platform, {
        binaries: [FULL_BINARIES[platform][0]]
      })

      await expect(
        collectBinaries(path.join(resourcesPath, "binaries"), platform)
      ).rejects.toThrow(/missing required binaries: deno/)
    }
  )

  it("names every missing required binary at once", async () => {
    const { resourcesPath } = makePackage("darwin")

    await expect(
      collectBinaries(path.join(resourcesPath, "binaries"), "darwin")
    ).rejects.toThrow(/ffmpeg .*, deno /)
  })

  it("treats a missing ffprobe as fine, and picks it up when present", async () => {
    const without = makePackage("darwin", { binaries: FULL_BINARIES.darwin })
    await expect(
      collectBinaries(path.join(without.resourcesPath, "binaries"), "darwin")
    ).resolves.toHaveLength(2)

    const withIt = makePackage("darwin", {
      binaries: [...FULL_BINARIES.darwin, "ffprobe"]
    })
    await expect(
      collectBinaries(path.join(withIt.resourcesPath, "binaries"), "darwin")
    ).resolves.toHaveLength(3)
  })
})

describe("prepareWindows", () => {
  it("aborts when the windows package has no engine", async () => {
    const appOutDir = makeWorkspace()

    await expect(prepareWindows(appOutDir)).rejects.toThrow(
      /missing required binaries|no yt-dlp engine/
    )
  })

  // the review's blocker: an empty engine directory used to pass
  it("aborts on an engine directory with no executable in it", async () => {
    const { appOutDir } = makePackage("win32", { binaries: FULL_BINARIES.win32 })

    await expect(prepareWindows(appOutDir)).rejects.toThrow(
      /no runnable yt-dlp executable/
    )
  })

  it("aborts when ffmpeg is missing even though the engine is fine", async () => {
    const { appOutDir } = makePackage("win32", {
      engine: { "yt-dlp.exe": true },
      binaries: [path.join("deno", "deno.exe")]
    })

    await expect(prepareWindows(appOutDir)).rejects.toThrow(
      /missing required binaries: ffmpeg/
    )
  })

  it("accepts a complete windows package", async () => {
    const { appOutDir } = makePackage("win32", {
      engine: { "yt-dlp.exe": true },
      binaries: FULL_BINARIES.win32
    })

    await expect(prepareWindows(appOutDir)).resolves.toBeUndefined()
  })
})

describe("prepareMacOS", () => {
  // the review's blocker: an internal dylib used to satisfy the engine gate
  it("aborts when the engine has _internal but no entry point", async () => {
    const { appOutDir, packager } = makePackage("darwin", {
      engine: { "_internal/libssl.dylib": true },
      binaries: FULL_BINARIES.darwin
    })

    await expect(
      prepareMacOS(appOutDir, packager, ARCH_ARM64, makeTools())
    ).rejects.toThrow(/no runnable yt-dlp executable/)
  })

  it("aborts when ffmpeg is missing", async () => {
    const { appOutDir, packager } = makePackage("darwin", {
      engine: { "yt-dlp_macos": true },
      binaries: [path.join("deno", "deno")]
    })

    await expect(
      prepareMacOS(appOutDir, packager, ARCH_ARM64, makeTools())
    ).rejects.toThrow(/missing required binaries: ffmpeg/)
  })

  it("aborts when deno is missing", async () => {
    const { appOutDir, packager } = makePackage("darwin", {
      engine: { "yt-dlp_macos": true },
      binaries: ["ffmpeg"]
    })

    await expect(
      prepareMacOS(appOutDir, packager, ARCH_ARM64, makeTools())
    ).rejects.toThrow(/missing required binaries: deno/)
  })

  it("aborts when the entry point is not a mach-o", async () => {
    const { appOutDir, packager, resourcesPath } = makePackage("darwin", {
      binaries: FULL_BINARIES.darwin
    })
    writeFile(path.join(resourcesPath, "binaries", "ytdlp", "yt-dlp_macos"), false)
    writeFile(
      path.join(resourcesPath, "binaries", "ytdlp", "_internal", "libssl.dylib"),
      true
    )

    await expect(
      prepareMacOS(appOutDir, packager, ARCH_ARM64, makeTools())
    ).rejects.toThrow(/is not a mach-o executable/)
  })

  it("thins, signs and audits a complete package", async () => {
    const { appOutDir, packager } = makePackage("darwin", {
      engine: { "yt-dlp_macos": true, "_internal/libssl.dylib": true },
      binaries: FULL_BINARIES.darwin
    })
    // only the engine ships universal, thin-on-build mach-o files - ffmpeg and
    // deno have only ever been bundled arm64-only, same as a real build
    const tools = makeTools({
      archs: (file) => (file.includes("ytdlp") ? ["x86_64", "arm64"] : ["arm64"])
    })

    await expect(
      prepareMacOS(appOutDir, packager, ARCH_ARM64, tools)
    ).resolves.toBeUndefined()

    // the two helper binaries plus both engine mach-o files got signed
    expect(
      tools.calls.filter((c) => c[0] === "codesign" && c[1] === "--force")
    ).toHaveLength(4)

    // and the helpers were strictly re-verified, not just adhoc-signed
    expect(
      tools.calls.filter((c) => c[0] === "codesign" && c[1] === "--verify")
    ).toHaveLength(4)
  })

  it("rejects a helper binary that is the wrong architecture", async () => {
    const { appOutDir, packager } = makePackage("darwin", {
      engine: { "yt-dlp_macos": true },
      binaries: FULL_BINARIES.darwin
    })
    // ffmpeg somehow ended up x86_64-only in an arm64 build - adhocSign()
    // would still sign it happily, since signing does not check architecture
    const tools = makeTools({
      archs: (file) => (file.includes("ffmpeg") ? ["x86_64"] : ["arm64"])
    })

    await expect(
      prepareMacOS(appOutDir, packager, ARCH_ARM64, tools)
    ).rejects.toThrow(/ffmpeg: is x86_64, expected exactly arm64/)
  })

  it("rejects a helper binary whose signature does not verify", async () => {
    const { appOutDir, packager } = makePackage("darwin", {
      engine: { "yt-dlp_macos": true },
      binaries: FULL_BINARIES.darwin
    })
    const tools = makeTools({
      archs: () => ["arm64"],
      verify: (file) => {
        if (file.includes("deno")) {
          throw new Error("code object is not signed at all")
        }
      }
    })

    await expect(
      prepareMacOS(appOutDir, packager, ARCH_ARM64, tools)
    ).rejects.toThrow(/deno: signature does not verify/)
  })
})

describe("prepareLinux", () => {
  it("aborts when deno is missing", async () => {
    const { appOutDir } = makePackage("linux", {
      engine: { "yt-dlp_linux": true },
      binaries: ["ffmpeg"]
    })

    await expect(prepareLinux(appOutDir)).rejects.toThrow(
      /missing required binaries: deno/
    )
  })

  it("aborts when the engine has no entry point", async () => {
    const { appOutDir } = makePackage("linux", {
      engine: { "_internal/libssl.so": true },
      binaries: FULL_BINARIES.linux
    })

    await expect(prepareLinux(appOutDir)).rejects.toThrow(
      /no runnable yt-dlp executable/
    )
  })

  it("makes the entry point executable on a complete package", async () => {
    const { appOutDir, resourcesPath } = makePackage("linux", {
      engine: { "yt-dlp_linux": true },
      binaries: FULL_BINARIES.linux
    })

    await expect(prepareLinux(appOutDir)).resolves.toBeUndefined()

    const entry = path.join(resourcesPath, "binaries", "ytdlp", "yt-dlp_linux")
    expect(fs.statSync(entry).mode & 0o111).toBeTruthy()
  })
})

describe("resolveTargetArch", () => {
  it("maps the known enums", () => {
    expect(resolveTargetArch(ARCH_ARM64)).toBe("arm64")
    expect(resolveTargetArch(ARCH_X64)).toBe("x86_64")
  })

  it("lets only the universal enum keep every slice", () => {
    expect(resolveTargetArch(ARCH_UNIVERSAL)).toBeNull()
  })

  // the review's P2: an unknown arch used to silently disable the whole gate
  it.each([[99], [undefined], [null], ["arm64"]])(
    "refuses to skip thinning for unmapped arch %p",
    (arch) => {
      expect(() => resolveTargetArch(arch)).toThrow(/unrecognised target architecture/)
    }
  )
})

describe("lipoArchs", () => {
  it("throws when the file cannot be inspected, rather than reporting nothing", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => new Error("lipo: can't open input file") })

    await expect(
      lipoArchs(path.join(engineDir, "yt-dlp_macos"), tools)
    ).rejects.toThrow(/could not read the architectures/)
  })

  it("throws when lipo reports an empty architecture list", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => [] })

    await expect(
      lipoArchs(path.join(engineDir, "yt-dlp_macos"), tools)
    ).rejects.toThrow(/no architectures/)
  })
})

describe("thinYtdlpEngine", () => {
  it("thins universal files and confirms the result on disk", async () => {
    const engineDir = makeEngine({
      "yt-dlp_macos": { size: 4096 },
      "_internal/libssl.dylib": { size: 2048 },
      "_internal/notes.txt": { machO: false }
    })
    const tools = makeTools({ archs: () => ["x86_64", "arm64"] })

    await expect(thinYtdlpEngine(engineDir, ARCH_ARM64, tools)).resolves.toBe("arm64")

    const thinCalls = tools.calls.filter((c) => c[0] === "lipo" && c[1] === "-thin")
    expect(thinCalls).toHaveLength(2)
    // the non-mach-o file is never handed to lipo
    expect(thinCalls.some((c) => c[3].endsWith("notes.txt"))).toBe(false)
    // every thinned file is re-inspected afterwards
    expect(
      tools.calls.filter((c) => c[0] === "lipo" && c[1] === "-archs").length
    ).toBeGreaterThanOrEqual(4)
  })

  it("leaves a correctly thin file alone", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => ["arm64"] })

    await expect(thinYtdlpEngine(engineDir, ARCH_ARM64, tools)).resolves.toBe("arm64")
    expect(tools.calls.filter((c) => c[1] === "-thin")).toHaveLength(0)
  })

  // the review's blocker: this used to be skipped as "already thin"
  it("aborts on a wrong-arch single-slice file instead of shipping it", async () => {
    const engineDir = makeEngine({
      "yt-dlp_macos": true,
      "_internal/legacy.dylib": true
    })
    const tools = makeTools({
      archs: (file) => (file.endsWith("legacy.dylib") ? ["x86_64"] : ["arm64"])
    })

    await expect(thinYtdlpEngine(engineDir, ARCH_ARM64, tools)).rejects.toThrow(
      /legacy\.dylib is x86_64-only in a arm64 build/
    )
  })

  it("aborts when inspection fails, instead of treating it as already thin", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => new Error("lipo: truncated file") })

    await expect(thinYtdlpEngine(engineDir, ARCH_ARM64, tools)).rejects.toThrow(
      /could not read the architectures/
    )
  })

  it("aborts on a fat file with no slice for this build", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => ["x86_64", "i386"] })

    await expect(thinYtdlpEngine(engineDir, ARCH_ARM64, tools)).rejects.toThrow(
      /has no arm64 slice/
    )
  })

  it("aborts when lipo itself fails, and leaves no scratch file behind", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({
      archs: () => ["x86_64", "arm64"],
      thin: () => {
        throw new Error("lipo: output file busy")
      }
    })

    await expect(thinYtdlpEngine(engineDir, ARCH_ARM64, tools)).rejects.toThrow(
      /could not thin .* output file busy/
    )
    expect(fs.readdirSync(engineDir)).toEqual(["yt-dlp_macos"])
  })

  it("aborts when the thinned output is not the arch we asked for", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => ["x86_64", "arm64"] })

    // lipo "succeeds" but the bytes on disk are still universal
    tools.run = new Proxy(tools.run, {
      apply: async (target, thisArg, args) => {
        const result = await Reflect.apply(target, thisArg, args)
        if (args[0] === "lipo" && args[1][0] === "-thin") {
          tools.archState.set(args[1][2], ["x86_64", "arm64"])
        }
        return result
      }
    })

    await expect(thinYtdlpEngine(engineDir, ARCH_ARM64, tools)).rejects.toThrow(
      /after thinning, expected arm64/
    )
  })

  it("leaves a universal build fat", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => ["x86_64", "arm64"] })

    await expect(thinYtdlpEngine(engineDir, ARCH_UNIVERSAL, tools)).resolves.toBeNull()
    expect(tools.calls).toHaveLength(0)
  })

  it("thins an x64 build to x86_64", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => ["x86_64", "arm64"] })

    await expect(thinYtdlpEngine(engineDir, ARCH_X64, tools)).resolves.toBe("x86_64")
  })

  it("aborts on an unmapped arch rather than quietly skipping the gate", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools()

    await expect(thinYtdlpEngine(engineDir, 99, tools)).rejects.toThrow(
      /unrecognised target architecture/
    )
    expect(tools.calls).toHaveLength(0)
  })
})

describe("adhocSign", () => {
  it("falls back to an out-of-place sign, restoring mode and cleaning up", async () => {
    const engineDir = makeEngine({ "Python.framework/Python": { mode: 0o755 } })
    const file = path.join(engineDir, "Python.framework", "Python")

    const scratchPaths = []
    const tools = makeTools({
      sign: (signed) => {
        // codesign refuses the file where it lies, exactly like the real
        // "bundle format is ambiguous" failure
        if (signed === file) {
          throw new Error("bundle format is ambiguous (could be app or framework)")
        }
        scratchPaths.push(signed)
      }
    })

    await expect(adhocSign(file, tools)).resolves.toBeUndefined()

    expect(scratchPaths).toHaveLength(1)
    expect(scratchPaths[0]).not.toBe(file)
    // the signed bytes came back and the mode survived
    expect(fs.statSync(file).mode & 0o777).toBe(0o755)
    // nothing left in temp
    expect(fs.existsSync(path.dirname(scratchPaths[0]))).toBe(false)
  })

  it("fails the build when both signing attempts fail", async () => {
    const engineDir = makeEngine({ "_internal/libcrypto.dylib": true })
    const file = path.join(engineDir, "_internal", "libcrypto.dylib")
    const tools = makeTools({
      sign: () => {
        throw new Error("codesign exited with code 1")
      }
    })

    await expect(adhocSign(file, tools)).rejects.toThrow(/could not sign/)
  })
})

describe("signYtdlpEngine", () => {
  it("signs every mach-o deepest first", async () => {
    const engineDir = makeEngine({
      "yt-dlp_macos": true,
      "_internal/libssl.dylib": true,
      "_internal/Python.framework/Python": true,
      "_internal/notes.txt": { machO: false }
    })
    const tools = makeTools()

    await signYtdlpEngine(engineDir, tools)

    const signed = tools.calls
      .filter((c) => c[0] === "codesign" && c[1] === "--force")
      .map((c) => c[c.length - 1])

    expect(signed).toHaveLength(3)
    expect(signed.some((f) => f.endsWith("notes.txt"))).toBe(false)
    // the framework binary is deeper than the top-level executable
    expect(signed.indexOf(path.join(engineDir, "_internal", "Python.framework", "Python")))
      .toBeLessThan(signed.indexOf(path.join(engineDir, "yt-dlp_macos")))
  })

  it("fails when a signature cannot be applied", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({
      sign: () => {
        throw new Error("codesign exited with code 1")
      }
    })

    await expect(signYtdlpEngine(engineDir, tools)).rejects.toThrow(/could not sign/)
  })

  it("fails when the engine holds no mach-o at all", async () => {
    const engineDir = makeEngine({ "README.txt": { machO: false } })
    const tools = makeTools()

    await expect(signYtdlpEngine(engineDir, tools)).rejects.toThrow(/looks empty/)
  })

  it("fails when a file cannot be made executable", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools()
    const file = path.join(engineDir, "yt-dlp_macos")

    const chmod = jest.spyOn(fsp, "chmod").mockRejectedValueOnce(new Error("EPERM"))

    await expect(signYtdlpEngine(engineDir, tools)).rejects.toThrow(/chmod failed/)

    chmod.mockRestore()
    expect(file).toBeTruthy()
  })
})

describe("auditYtdlpEngine", () => {
  it("passes a correctly thinned and signed engine", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true, "_internal/libssl.dylib": true })
    const tools = makeTools({ archs: () => ["arm64"] })

    await expect(auditYtdlpEngine(engineDir, "arm64", tools)).resolves.toBeUndefined()
  })

  it("catches a universal straggler no earlier step touched", async () => {
    const engineDir = makeEngine({
      "yt-dlp_macos": true,
      "_internal/late-arrival.dylib": true
    })
    const tools = makeTools({
      archs: (file) => (file.includes("late-arrival") ? ["x86_64", "arm64"] : ["arm64"])
    })

    await expect(auditYtdlpEngine(engineDir, "arm64", tools)).rejects.toThrow(
      /late-arrival\.dylib: is x86_64, arm64, expected exactly arm64/
    )
  })

  it("catches an unsigned straggler", async () => {
    const engineDir = makeEngine({
      "yt-dlp_macos": true,
      "_internal/unsigned.dylib": true
    })
    const tools = makeTools({
      archs: () => ["arm64"],
      verify: (file) => {
        if (file.includes("unsigned")) {
          throw new Error("code object is not signed at all")
        }
      }
    })

    await expect(auditYtdlpEngine(engineDir, "arm64", tools)).rejects.toThrow(
      /signature does not verify/
    )
  })

  it("reports every problem at once rather than only the first", async () => {
    const engineDir = makeEngine({ "a.dylib": true, "b.dylib": true })
    const tools = makeTools({
      archs: () => ["arm64"],
      verify: () => {
        throw new Error("code object is not signed at all")
      }
    })

    await expect(auditYtdlpEngine(engineDir, "arm64", tools)).rejects.toThrow(
      /failed for 2 of 2 file\(s\)/
    )
  })

  it("accepts a signature that only verifies out of place", async () => {
    const engineDir = makeEngine({ "Python.framework/Python": true })
    const file = path.join(engineDir, "Python.framework", "Python")
    const tools = makeTools({
      archs: () => ["arm64"],
      verify: (checked) => {
        if (checked === file) {
          throw new Error("bundle format is ambiguous (could be app or framework)")
        }
      }
    })

    await expect(auditYtdlpEngine(engineDir, "arm64", tools)).resolves.toBeUndefined()
  })

  it("skips the arch check on a universal build but still checks signatures", async () => {
    const engineDir = makeEngine({ "yt-dlp_macos": true })
    const tools = makeTools({ archs: () => ["x86_64", "arm64"] })

    await expect(auditYtdlpEngine(engineDir, null, tools)).resolves.toBeUndefined()
    expect(tools.calls.filter((c) => c[1] === "-archs")).toHaveLength(0)
    expect(tools.calls.filter((c) => c[1] === "--verify")).toHaveLength(1)
  })
})

describe("afterPack", () => {
  it("propagates a failure instead of returning success", async () => {
    const appOutDir = makeWorkspace()

    // an empty output directory fails the very first required-input gate
    await expect(
      afterPack({
        electronPlatformName: "win32",
        appOutDir,
        packager: { appInfo: { productFilename: "Cliply" } },
        arch: ARCH_X64
      })
    ).rejects.toThrow(/missing required binaries/)
  })

  it("propagates a missing engine through the hook", async () => {
    const { appOutDir } = makePackage("win32", { binaries: FULL_BINARIES.win32 })
    fs.rmSync(path.join(appOutDir, "resources", "binaries", "ytdlp"), {
      recursive: true,
      force: true
    })

    await expect(
      afterPack({
        electronPlatformName: "win32",
        appOutDir,
        packager: { appInfo: { productFilename: "Cliply" } },
        arch: ARCH_X64
      })
    ).rejects.toThrow(/no yt-dlp engine/)
  })

  it("does nothing for an unknown platform", async () => {
    await expect(
      afterPack({
        electronPlatformName: "aix",
        appOutDir: makeWorkspace(),
        packager: { appInfo: { productFilename: "Cliply" } },
        arch: ARCH_X64
      })
    ).resolves.toBeUndefined()
  })
})
