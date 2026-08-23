// engine path resolution for the onedir layout: the engine is a directory
// whose executable is named after the release asset it came from

const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  YtdlpEngine,
  executableCandidates,
  resolveExecutableIn,
  nominalExecutableIn,
  legacyBinaryName,
  ENGINE_DIR_NAME
} = require("../src/main/services/ytdlp-engine")

const EXECUTABLE = executableCandidates()[0]
const PLATFORM_DIRS = { darwin: "macos", win32: "windows", linux: "linux" }
const PLATFORM_DIR = PLATFORM_DIRS[process.platform] || process.platform

function writeEngine(directory, name = EXECUTABLE) {
  fs.mkdirSync(path.join(directory, "_internal"), { recursive: true })
  fs.writeFileSync(path.join(directory, "_internal", "payload.bin"), "payload")
  fs.writeFileSync(path.join(directory, name), "engine")
  return path.join(directory, name)
}

describe("executable resolution", () => {
  let root

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-paths-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("finds the executable next to the _internal payload", () => {
    const expected = writeEngine(root)

    expect(resolveExecutableIn(root)).toBe(expected)
  })

  test("returns null for a directory with no executable in it", () => {
    fs.mkdirSync(path.join(root, "_internal"), { recursive: true })

    expect(resolveExecutableIn(root)).toBeNull()
    expect(resolveExecutableIn(null)).toBeNull()
  })

  test("looks for the names of the platform it is asked about", () => {
    writeEngine(root, "yt-dlp.exe")

    // the build script unpacks engines for platforms it is not running on
    expect(resolveExecutableIn(root, "win32")).toBe(path.join(root, "yt-dlp.exe"))
    expect(resolveExecutableIn(root, "darwin")).toBeNull()
  })

  test("every platform has candidates, best first", () => {
    expect(executableCandidates("darwin")[0]).toBe("yt-dlp_macos")
    expect(executableCandidates("win32")[0]).toBe("yt-dlp.exe")
    expect(executableCandidates("linux")[0]).toBe("yt-dlp_linux")
    // an unknown platform still gets a usable list rather than undefined
    expect(executableCandidates("aix").length).toBeGreaterThan(0)
  })

  test("names a path even when nothing is unpacked yet", () => {
    expect(nominalExecutableIn(root)).toBe(path.join(root, EXECUTABLE))
  })

  test("knows what older builds installed", () => {
    expect(legacyBinaryName("win32")).toBe("yt-dlp.exe")
    expect(legacyBinaryName("darwin")).toBe("yt-dlp")
    expect(legacyBinaryName("linux")).toBe("yt-dlp")
  })
})

describe("engine paths", () => {
  let root
  let userDataPath
  let resourcesPath

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-paths-"))
    userDataPath = path.join(root, "userData")
    resourcesPath = path.join(root, "resources")
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.mkdirSync(resourcesPath, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function createEngine() {
    return new YtdlpEngine({ userDataPath, resourcesPath })
  }

  test("the installed engine is a directory under userData/engine", () => {
    const engine = createEngine()

    expect(engine.getEngineDir()).toBe(path.join(userDataPath, "engine"))
    expect(engine.getInstalledEngineDir()).toBe(
      path.join(userDataPath, "engine", ENGINE_DIR_NAME)
    )
  })

  test("the installed binary path resolves the unpacked executable", () => {
    const engine = createEngine()
    const expected = writeEngine(engine.getInstalledEngineDir())

    expect(engine.getInstalledBinaryPath()).toBe(expected)
    expect(engine.getBinaryPath()).toBe(expected)
  })

  test("the installed binary path names where it would go before it exists", () => {
    const engine = createEngine()

    expect(engine.getInstalledBinaryPath()).toBe(
      path.join(userDataPath, "engine", ENGINE_DIR_NAME, EXECUTABLE)
    )
  })

  test("falls back to the packaged engine when userData has none", () => {
    const engine = createEngine()
    const bundled = writeEngine(path.join(resourcesPath, "binaries", ENGINE_DIR_NAME))

    expect(engine.getBundledEngineDir()).toBe(
      path.join(resourcesPath, "binaries", ENGINE_DIR_NAME)
    )
    expect(engine.getBinaryPath()).toBe(bundled)
  })

  test("finds the engine in the dev repo layout too", () => {
    const engine = createEngine()
    const bundled = writeEngine(
      path.join(resourcesPath, "binaries", PLATFORM_DIR, ENGINE_DIR_NAME)
    )

    expect(engine.getBundledBinaryPath()).toBe(bundled)
    expect(engine.getBinaryPath()).toBe(bundled)
  })

  test("the userData engine wins over the packaged one", () => {
    const engine = createEngine()
    writeEngine(path.join(resourcesPath, "binaries", ENGINE_DIR_NAME))
    const installed = writeEngine(engine.getInstalledEngineDir())

    expect(engine.getBinaryPath()).toBe(installed)
  })

  test("a leftover single-file binary is not mistaken for an engine", () => {
    const engine = createEngine()
    fs.mkdirSync(engine.getEngineDir(), { recursive: true })
    fs.writeFileSync(
      path.join(engine.getEngineDir(), legacyBinaryName()),
      "the old self-extracting build"
    )
    const bundled = writeEngine(path.join(resourcesPath, "binaries", ENGINE_DIR_NAME))

    expect(engine.getBinaryPath()).toBe(bundled)
  })
})
