// unit tests for the yt-dlp updater: version comparison, directory seeding and
// the owned update pipeline (tag -> checksum -> staged unpack -> probe -> swap)
//
// the http layer is faked, but everything below it is real: real zips on disk,
// really unpacked, really renamed into place

const crypto = require("crypto")
const fs = require("fs")
const net = require("net")
const os = require("os")
const path = require("path")

const {
  YtdlpUpdater,
  compareVersions,
  releaseAssetFor,
  httpGet,
  resolveAddresses,
  withAddressFallback
} = require("../src/main/services/ytdlp-updater")
const {
  OperationGate,
  executableCandidates,
  resolveExecutableIn,
  legacyBinaryName,
  ENGINE_DIR_NAME
} = require("../src/main/services/ytdlp-engine")
const { makeEngineZip } = require("./helpers/zip-fixture")

const EXECUTABLE = executableCandidates()[0]
const ASSET = releaseAssetFor()
const LATEST = "2026.09.01"

// a stand-in engine: real directories on disk, scripted --version answers
function createFakeEngine(root, versions = {}) {
  const engineDir = path.join(root, "userData", "engine")
  const installedDir = path.join(engineDir, ENGINE_DIR_NAME)
  const bundledDir = path.join(root, "resources", "binaries", ENGINE_DIR_NAME)

  return {
    engineDir,
    installedDir,
    bundledDir,
    installedExecutable: path.join(installedDir, EXECUTABLE),
    bundledExecutable: path.join(bundledDir, EXECUTABLE),
    stagedExecutable: (tag) =>
      path.join(engineDir, `.staging-${tag}`, EXECUTABLE),
    versions,
    defaultVersion: "2026.01.01",
    invalidated: 0,
    probed: [],
    // lets a test park a probe until the operation is aborted, the way a real
    // first run of a freshly unpacked engine can
    probeHangs: null,
    onProbeStart: null,
    gate: new OperationGate(),
    getEngineDir: () => engineDir,
    getInstalledEngineDir: () => installedDir,
    getBundledEngineDir: () => bundledDir,
    getInstalledBinaryPath() {
      return resolveExecutableIn(installedDir) || this.installedExecutable
    },
    getBinaryPath() {
      return resolveExecutableIn(installedDir) || this.bundledExecutable
    },
    invalidateVersion() {
      this.invalidated += 1
    },
    hasActiveOperations() {
      return this.gate.readers > 0
    },
    // like the real probe, the answer follows the *bytes* at that path - the
    // fixtures write their version into the executable. scripted entries win,
    // which is how a binary that refuses to run is modelled
    async probeVersion(binaryPath, options = {}) {
      if (!binaryPath || !fs.existsSync(binaryPath)) return null

      this.probed.push(binaryPath)

      // the real probe resolves null once an abort has killed the child
      if (this.probeHangs && this.probeHangs(binaryPath)) {
        if (this.onProbeStart) this.onProbeStart(binaryPath)

        return new Promise((resolve) => {
          const signal = options.signal
          if (!signal) return
          if (signal.aborted) {
            resolve(null)
            return
          }
          signal.addEventListener("abort", () => resolve(null))
        })
      }

      if (this.versions[binaryPath] !== undefined) {
        return this.versions[binaryPath]
      }

      const stamped = fs.readFileSync(binaryPath, "utf8").match(/\d{4}\.\d{2}\.\d{2}(\.\d+)?/)
      return stamped ? stamped[0] : this.defaultVersion
    }
  }
}

// write an unpacked engine directory: executable plus its _internal payload
function writeEngineDir(directory, contents) {
  fs.mkdirSync(path.join(directory, "_internal"), { recursive: true })
  fs.writeFileSync(path.join(directory, "_internal", "payload.bin"), `${contents} payload`)
  fs.writeFileSync(path.join(directory, EXECUTABLE), contents)
  fs.chmodSync(path.join(directory, EXECUTABLE), 0o755)
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

/**
 * a fake github: hands out a tag, a checksum listing and a real zip
 * @param {Object} options - {tag, zip, checksum, onDownload, failTag}
 * @returns {Object} the http client the updater takes
 */
function createFakeHttp(options = {}) {
  const tag = options.tag || LATEST
  const zip = options.zip || makeEngineZip(EXECUTABLE, tag)
  const checksum = options.checksum || sha256(zip)

  const http = {
    tag,
    zip,
    calls: { tag: 0, text: 0, download: 0 },

    async getRedirectLocation() {
      http.calls.tag += 1

      if (options.failTag) {
        throw new Error("network is unreachable")
      }

      return options.location !== undefined
        ? options.location
        : `https://github.com/yt-dlp/yt-dlp/releases/tag/${tag}`
    },

    async getText() {
      http.calls.text += 1
      return `${checksum}  ${ASSET}\ndeadbeef  ignored\n`
    },

    async download(url, destPath, downloadOptions = {}) {
      http.calls.download += 1

      if (options.onDownload) {
        await options.onDownload(downloadOptions)
      }

      fs.writeFileSync(destPath, zip)
      return sha256(fs.readFileSync(destPath))
    }
  }

  return http
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe("version comparison", () => {
  test("orders date-based versions", () => {
    expect(compareVersions("2026.08.19", "2026.08.18")).toBe(1)
    expect(compareVersions("2026.08.18", "2026.08.19")).toBe(-1)
    expect(compareVersions("2026.08.19", "2026.08.19")).toBe(0)
  })

  test("handles nightly-style build suffixes", () => {
    expect(compareVersions("2026.08.19.232357", "2026.08.19")).toBe(1)
    expect(compareVersions("2026.08.19", "2026.08.19.232357")).toBe(-1)
  })

  test("treats missing or junk versions as oldest", () => {
    expect(compareVersions("2026.08.19", "")).toBe(1)
    expect(compareVersions(null, undefined)).toBe(0)
  })
})

describe("release assets", () => {
  test("picks the onedir zip for each platform and arch", () => {
    expect(releaseAssetFor("darwin", "arm64")).toBe("yt-dlp_macos.zip")
    expect(releaseAssetFor("win32", "x64")).toBe("yt-dlp_win.zip")
    expect(releaseAssetFor("win32", "ia32")).toBe("yt-dlp_win_x86.zip")
    expect(releaseAssetFor("win32", "arm64")).toBe("yt-dlp_win_arm64.zip")
    expect(releaseAssetFor("linux", "x64")).toBe("yt-dlp_linux.zip")
    expect(releaseAssetFor("linux", "arm64")).toBe("yt-dlp_linux_aarch64.zip")
    expect(releaseAssetFor("aix", "ppc")).toBeNull()
  })
})

// github's release host answers on four anycast addresses. when one of them is
// blackholed - which is a thing that happens on real networks - node's own
// resolution picks a single address and stays there, so the update never lands
describe("reaching a host that has more than one address", () => {
  // TEST-NET-3: reserved for documentation, so it is never routable anywhere
  const UNROUTABLE = ["203.0.113.1", "203.0.113.2"]
  const lookupOf = (...addresses) => async () =>
    addresses.map((address) => ({ address, family: 4 }))

  const connectFailure = () => {
    const error = new Error("connect ETIMEDOUT")
    error.connectFailed = true
    return error
  }

  describe("choosing when to move to the next address", () => {
    test("stops at the first address that answers", async () => {
      const tried = []
      const attempt = async (address) => {
        tried.push(address)
        return `response from ${address}`
      }

      expect(await withAddressFallback(["a", "b", "c"], attempt)).toBe(
        "response from a"
      )
      expect(tried).toEqual(["a"])
    })

    test("moves past an address it could not connect to", async () => {
      const tried = []
      const attempt = async (address) => {
        tried.push(address)
        if (address !== "c") throw connectFailure()
        return "response from c"
      }

      expect(await withAddressFallback(["a", "b", "c"], attempt)).toBe(
        "response from c"
      )
      expect(tried).toEqual(["a", "b", "c"])
    })

    test("gives up on a failure the next address would repeat", async () => {
      const tried = []
      const attempt = async (address) => {
        tried.push(address)
        throw new Error("certificate has expired")
      }

      await expect(withAddressFallback(["a", "b", "c"], attempt)).rejects.toThrow(
        "certificate has expired"
      )
      // a bad certificate or a 404 is the host's answer, not the address's
      expect(tried).toEqual(["a"])
    })

    test("surfaces the last failure when no address works", async () => {
      const attempt = async (address) => {
        const error = connectFailure()
        error.message = `no route to ${address}`
        throw error
      }

      await expect(withAddressFallback(["a", "b"], attempt)).rejects.toThrow(
        "no route to b"
      )
    })
  })

  describe("resolving", () => {
    test("returns every address the resolver offers", async () => {
      const addresses = await resolveAddresses("cliply.test", {
        lookup: lookupOf("185.199.108.133", "185.199.109.133")
      })

      expect(addresses).toEqual(["185.199.108.133", "185.199.109.133"])
    })

    test("goes through the os resolver, so hosts-file names still work", async () => {
      const addresses = await resolveAddresses("localhost")

      expect(addresses.length).toBeGreaterThan(0)
      expect(addresses.every((address) => net.isIP(address) !== 0)).toBe(true)
    })

    test("refuses a hostname that resolves to nothing", async () => {
      await expect(
        resolveAddresses("cliply.test", { lookup: lookupOf() })
      ).rejects.toThrow("could not resolve cliply.test")
    })
  })

  // real sockets, no server: these prove how a genuine connect failure is
  // classified, which is what decides whether the next address gets a turn
  describe("classifying a real failure", () => {
    test("an unreachable address is treated as worth retrying elsewhere", async () => {
      await expect(
        httpGet("https://cliply.test/latest", {
          lookup: lookupOf(UNROUTABLE[0]),
          connectTimeoutMs: 50
        })
      ).rejects.toMatchObject({ connectFailed: true })
    })

    test("a cancelled request is not blamed on the address", async () => {
      const controller = new AbortController()
      controller.abort()

      const error = await httpGet("https://cliply.test/latest", {
        lookup: lookupOf(...UNROUTABLE),
        connectTimeoutMs: 50,
        signal: controller.signal
      }).catch((caught) => caught)

      // retrying the other address would only abort again
      expect(error.connectFailed).toBe(false)
      expect(error.name).toBe("AbortError")
    })
  })
})

describe("seeding", () => {
  let root

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-updater-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("copies the whole bundled directory when userData has none", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")

    const result = await new YtdlpUpdater({ engine }).seed()

    expect(result.seeded).toBe(true)
    expect(result.reason).toBe("missing")
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toBe("bundled engine")
    // the executable is useless without the payload beside it
    expect(
      fs.readFileSync(path.join(engine.installedDir, "_internal", "payload.bin"), "utf8")
    ).toBe("bundled engine payload")
  })

  test("makes the seeded executable executable", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")

    await new YtdlpUpdater({ engine }).seed()

    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(engine.installedExecutable).mode & 0o111).toBeTruthy()
  })

  test("deletes the single-file engine older builds installed", async () => {
    const engine = createFakeEngine(root)
    const legacy = path.join(engine.engineDir, legacyBinaryName())

    writeEngineDir(engine.bundledDir, "bundled engine")
    fs.mkdirSync(engine.engineDir, { recursive: true })
    fs.writeFileSync(legacy, "the old self-extracting build")

    const result = await new YtdlpUpdater({ engine }).seed()

    expect(result.seeded).toBe(true)
    expect(fs.existsSync(legacy)).toBe(false)
    expect(fs.existsSync(engine.installedExecutable)).toBe(true)
  })

  test("clears the stale single file even when the engine is already current", async () => {
    const engine = createFakeEngine(root)
    const legacy = path.join(engine.engineDir, legacyBinaryName())

    writeEngineDir(engine.bundledDir, "bundled engine")
    writeEngineDir(engine.installedDir, "installed engine")
    fs.writeFileSync(legacy, "the old self-extracting build")

    const result = await new YtdlpUpdater({ engine }).seed()

    expect(result.reason).toBe("up-to-date")
    expect(fs.existsSync(legacy)).toBe(false)
  })

  test("leaves a newer installed engine alone", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")
    writeEngineDir(engine.installedDir, "updated engine")

    engine.versions[engine.bundledExecutable] = "2026.08.01"
    engine.versions[engine.installedExecutable] = "2026.08.19"

    const result = await new YtdlpUpdater({ engine }).seed()

    expect(result.seeded).toBe(false)
    expect(result.reason).toBe("up-to-date")
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toBe("updated engine")
  })

  test("overwrites when the bundled engine is newer", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")
    writeEngineDir(engine.installedDir, "old engine")

    engine.versions[engine.bundledExecutable] = "2026.08.19"
    engine.versions[engine.installedExecutable] = "2026.01.01"

    const result = await new YtdlpUpdater({ engine }).seed()

    expect(result.seeded).toBe(true)
    expect(result.reason).toBe("bundled-newer")
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toBe("bundled engine")
  })

  test("reseeds when the installed engine no longer runs", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")
    writeEngineDir(engine.installedDir, "corrupt")

    // a failed --version probe is how a half-finished swap shows up
    engine.versions[engine.installedExecutable] = null

    const result = await new YtdlpUpdater({ engine }).seed()

    expect(result.seeded).toBe(true)
    expect(result.reason).toBe("corrupt")
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toBe("bundled engine")
  })

  test("reports when there is nothing to seed from", async () => {
    const engine = createFakeEngine(root)

    const result = await new YtdlpUpdater({ engine }).seed()

    expect(result.seeded).toBe(false)
    expect(result.reason).toBe("no-binary-available")
  })

  test("only runs the packaged engine once, then remembers its version", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")
    writeEngineDir(engine.installedDir, "installed engine")

    const probed = []
    const inner = engine.probeVersion.bind(engine)
    engine.probeVersion = async (binaryPath, options) => {
      probed.push(binaryPath)
      return inner(binaryPath, options)
    }

    const updater = new YtdlpUpdater({ engine })
    await updater.seed()
    await updater.seed()

    // the copy in the app bundle has never run, so its first --version pays an
    // os scan - doing that on every launch is what this avoids
    expect(probed.filter((probe) => probe === engine.bundledExecutable)).toHaveLength(1)
    expect(probed.filter((probe) => probe === engine.installedExecutable).length).toBeGreaterThan(1)
  })

  test("reads the packaged engine again once the app has been updated", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")
    writeEngineDir(engine.installedDir, "installed engine")
    engine.versions[engine.bundledExecutable] = "2026.08.01"
    engine.versions[engine.installedExecutable] = "2026.08.19"

    const updater = new YtdlpUpdater({ engine })
    expect((await updater.seed()).reason).toBe("up-to-date")

    // an app update replaces the packaged engine with a newer one
    fs.writeFileSync(engine.bundledExecutable, "bundled engine, newer build")
    engine.versions[engine.bundledExecutable] = "2026.09.01"

    const result = await updater.seed()

    expect(result.reason).toBe("bundled-newer")
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toBe(
      "bundled engine, newer build"
    )
  })

  test("a directory with no executable in it is not an engine", async () => {
    const engine = createFakeEngine(root)
    fs.mkdirSync(path.join(engine.installedDir, "_internal"), { recursive: true })
    writeEngineDir(engine.bundledDir, "bundled engine")

    const result = await new YtdlpUpdater({ engine }).seed()

    expect(result.reason).toBe("missing")
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toBe("bundled engine")
  })
})

describe("update guards", () => {
  let root

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-updater-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("refuses to check while a download holds the gate", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")
    await engine.gate.acquireRead()

    const http = createFakeHttp()
    const result = await new YtdlpUpdater({ engine, http }).checkForUpdate()

    expect(result).toEqual({ started: false, reason: "busy" })
    expect(http.calls.tag).toBe(0)
  })

  test("refuses to update now while a download holds the gate", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")
    await engine.gate.acquireRead()
    await engine.gate.acquireRead()

    const result = await new YtdlpUpdater({ engine, http: createFakeHttp() }).updateNow()

    expect(result).toEqual({ updated: false, reason: "busy" })
  })

  test("refuses to seed while a download holds the gate", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine")
    const release = await engine.gate.acquireRead()

    const updater = new YtdlpUpdater({ engine })
    expect(await updater.seed()).toEqual({ seeded: false, reason: "busy" })

    // once the download finishes, seeding goes through
    release()
    expect((await updater.seed()).seeded).toBe(true)
  })

  test("refuses when there is no engine at all", async () => {
    const engine = createFakeEngine(root)

    expect(
      await new YtdlpUpdater({ engine, http: createFakeHttp() }).checkForUpdate()
    ).toEqual({ started: false, reason: "no-binary-available" })
  })

  test("refuses on a platform yt-dlp does not publish for", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.installedDir, "installed engine")

    const http = createFakeHttp()
    const updater = new YtdlpUpdater({ engine, http, releaseAsset: null })
    const result = await updater.updateNow()

    expect(result.reason).toBe("unsupported-platform")
    expect(http.calls.download).toBe(0)
  })

  test("requires an engine", () => {
    expect(() => new YtdlpUpdater({})).toThrow(/requires a YtdlpEngine/)
  })
})

describe("update pipeline", () => {
  let root
  let warn

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-updater-"))
    // several of these drive failure paths on purpose
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    warn.mockRestore()
  })

  // an engine that is installed, runnable and out of date
  function installedEngine(version = "2026.08.19") {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.installedDir, `installed engine ${version}`)
    return engine
  }

  function stagingDirs(engine) {
    return fs
      .readdirSync(engine.engineDir)
      .filter((name) => name.startsWith(".staging") || name.startsWith(".download"))
  }

  test("downloads, verifies, probes and swaps in a newer release", async () => {
    const engine = installedEngine()
    const http = createFakeHttp()

    const updater = new YtdlpUpdater({ engine, http })
    const result = await updater.updateNow()

    expect(result).toMatchObject({
      updated: true,
      reason: "completed",
      from: "2026.08.19",
      tag: LATEST
    })

    // the unpacked archive is what is now installed, payload and all
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(LATEST)
    expect(
      fs.readFileSync(path.join(engine.installedDir, "_internal", "payload.bin"), "utf8")
    ).toBe(`payload for ${LATEST}`)

    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(engine.installedExecutable).mode & 0o111).toBeTruthy()
    expect(engine.invalidated).toBeGreaterThan(0)
    expect(stagingDirs(engine)).toEqual([])
    expect(engine.gate.isBusy()).toBe(false)
  })

  test("does not download anything when the installed engine is current", async () => {
    const engine = installedEngine(LATEST)
    const http = createFakeHttp()

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result).toMatchObject({ updated: false, reason: "up-to-date", to: LATEST })
    expect(http.calls.download).toBe(0)
    expect(http.calls.text).toBe(0)
  })

  test("does not download when the installed engine is newer than the tag", async () => {
    const engine = installedEngine("2026.12.31")
    const http = createFakeHttp()

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result.reason).toBe("up-to-date")
    expect(http.calls.download).toBe(0)
  })

  test("a checksum mismatch never reaches the engine", async () => {
    const engine = installedEngine()
    const http = createFakeHttp({ checksum: "0".repeat(64) })

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result).toMatchObject({ updated: false, reason: "checksum-mismatch" })
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain("installed engine")
    expect(stagingDirs(engine)).toEqual([])
    expect(engine.gate.isBusy()).toBe(false)
  })

  test("an asset missing from the checksum listing is not installed", async () => {
    const engine = installedEngine()
    const http = createFakeHttp()
    http.getText = async () => "deadbeef  something-else.zip\n"

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result.reason).toBe("checksum-missing")
    expect(http.calls.download).toBe(0)
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain("installed engine")
  })

  test("a staged engine that cannot report a version is thrown away", async () => {
    const engine = installedEngine()
    const http = createFakeHttp()

    // the unpacked engine does not run on this machine
    engine.versions[engine.stagedExecutable(LATEST)] = null

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result).toMatchObject({ updated: false, reason: "probe-failed" })
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain("installed engine")
    expect(stagingDirs(engine)).toEqual([])
  })

  test("an archive without a yt-dlp executable in it is thrown away", async () => {
    const engine = installedEngine()
    const http = createFakeHttp({
      zip: require("./helpers/zip-fixture").makeZip([
        { name: "_internal/payload.bin", data: "payload but no engine" }
      ])
    })

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result.reason).toBe("asset-layout-unexpected")
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain("installed engine")
    expect(stagingDirs(engine)).toEqual([])
  })

  test("a corrupt archive is thrown away", async () => {
    const engine = installedEngine()
    const http = createFakeHttp({ zip: Buffer.from("not a zip file at all") })

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result.reason).toBe("download-failed")
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain("installed engine")
    expect(stagingDirs(engine)).toEqual([])
  })

  test("a failed tag lookup leaves the engine alone", async () => {
    const engine = installedEngine()
    const http = createFakeHttp({ failTag: true })

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result).toMatchObject({ updated: false, reason: "check-failed", to: "2026.08.19" })
    expect(http.calls.download).toBe(0)
    expect(engine.gate.isBusy()).toBe(false)
  })

  test("a redirect that does not name a release tag is refused", async () => {
    const engine = installedEngine()
    const http = createFakeHttp({ location: "https://github.com/login?return_to=%2Fyt-dlp" })

    const result = await new YtdlpUpdater({ engine, http }).updateNow()

    expect(result.reason).toBe("check-failed")
    expect(http.calls.download).toBe(0)
  })

  test("an interrupted download releases the gate and leaves the engine untouched", async () => {
    const engine = installedEngine()
    let started = null
    const downloadStarted = new Promise((resolve) => {
      started = resolve
    })

    const http = createFakeHttp({
      onDownload: ({ signal }) =>
        new Promise((_resolve, reject) => {
          started()
          signal.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        })
    })

    const updater = new YtdlpUpdater({ engine, http })
    const running = updater.updateNow()

    await downloadStarted
    expect(updater.terminateUpdate()).toBe(true)

    const result = await running

    expect(result).toMatchObject({ updated: false, reason: "cancelled" })
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain("installed engine")
    expect(stagingDirs(engine)).toEqual([])
    expect(engine.gate.isBusy()).toBe(false)
    expect(updater.updating).toBe(false)
  })

  test("a download that never finishes is aborted by the timeout", async () => {
    const engine = installedEngine()
    const http = createFakeHttp({
      onDownload: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        })
    })

    const updater = new YtdlpUpdater({ engine, http, updateTimeoutMs: 20 })
    const result = await updater.updateNow()

    expect(result.reason).toBe("cancelled")
    expect(engine.gate.isBusy()).toBe(false)

    // nothing is left running that could reopen the gate later
    await wait(40)
    expect(engine.gate.isBusy()).toBe(false)
  })

  test("terminateUpdate says so when there is nothing to abort", () => {
    const engine = installedEngine()

    expect(new YtdlpUpdater({ engine }).terminateUpdate()).toBe(false)
  })

  test("the gate stays shut for the whole update and reopens after it", async () => {
    const engine = installedEngine()

    let granted = false
    let release = null

    const http = createFakeHttp({
      onDownload: async () => {
        // a download arrives while the update is mid-flight
        engine.gate.acquireRead().then((grant) => {
          granted = true
          release = grant
        })
        await wait(10)
        expect(granted).toBe(false)
      }
    })

    const updater = new YtdlpUpdater({ engine, http })
    await updater.updateNow()
    await wait(0)

    expect(granted).toBe(true)
    expect(updater.updating).toBe(false)
    release()
  })

  test("checkForUpdate reports what the update did", async () => {
    const engine = installedEngine()

    const updater = new YtdlpUpdater({ engine, http: createFakeHttp() })
    const result = await updater.checkForUpdate()

    expect(result).toMatchObject({ started: true, updated: true, to: LATEST })
    expect(updater.lastCheck).toEqual(expect.any(String))
    expect(updater.getStatus().lastResult).toMatchObject({ updated: true, to: LATEST })
    expect(engine.gate.isBusy()).toBe(false)
  })

  test("seeds before updating, so a fresh install updates from the bundled engine", async () => {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.bundledDir, "bundled engine 2026.08.19")

    const result = await new YtdlpUpdater({ engine, http: createFakeHttp() }).updateNow()

    expect(result).toMatchObject({ updated: true, from: "2026.08.19", to: LATEST })
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(LATEST)
  })

  test("reseeds when the swap somehow leaves an engine that will not run", async () => {
    const engine = installedEngine()
    writeEngineDir(engine.bundledDir, "bundled engine 2026.08.19")

    // the staged engine probes fine, but the one at the installed path does not
    engine.versions[engine.installedExecutable] = null

    const result = await new YtdlpUpdater({ engine, http: createFakeHttp() }).updateNow()

    expect(result).toMatchObject({ updated: false, reason: "repaired" })
    expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain("bundled engine")
    expect(engine.gate.isBusy()).toBe(false)
  })
})

// the fixup review's three P1 boundaries: cancellation reaching the probe, the
// staged engine having to be the release we asked for, and a rename chain that
// strands the previous engine
describe("update pipeline safety", () => {
  let root
  let warn
  let error
  let renameSpy

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-updater-"))
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    error = jest.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    if (renameSpy) {
      renameSpy.mockRestore()
      renameSpy = null
    }
    fs.rmSync(root, { recursive: true, force: true })
    warn.mockRestore()
    error.mockRestore()
  })

  function installedEngine(version = "2026.08.19") {
    const engine = createFakeEngine(root)
    writeEngineDir(engine.installedDir, `installed engine ${version}`)
    return engine
  }

  function leftovers(engine) {
    return fs
      .readdirSync(engine.engineDir)
      .filter((name) => name.startsWith(".staging") || name.startsWith(".download"))
  }

  // make rename fail only where a test wants it to, leaving the rest real
  function failRenamesWhen(predicate) {
    const real = fs.promises.rename.bind(fs.promises)

    renameSpy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        if (predicate(String(from), String(to))) {
          throw Object.assign(new Error("EIO: rename failed"), { code: "EIO" })
        }

        return real(from, to)
      })

    return renameSpy
  }

  describe("cancellation reaches the staged probe", () => {
    test("cancelling during the probe leaves the engine alone", async () => {
      const engine = installedEngine()
      let probeStarted = null
      const started = new Promise((resolve) => {
        probeStarted = resolve
      })

      // the probe of the freshly unpacked engine hangs until it is aborted
      engine.probeHangs = (binaryPath) => binaryPath.includes(".staging-")
      engine.onProbeStart = () => probeStarted()

      const updater = new YtdlpUpdater({ engine, http: createFakeHttp() })
      const running = updater.updateNow()

      await started
      expect(updater.terminateUpdate()).toBe(true)

      const result = await running

      expect(result).toMatchObject({ updated: false, reason: "cancelled" })
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "installed engine"
      )
      expect(leftovers(engine)).toEqual([])
      expect(engine.gate.isBusy()).toBe(false)
      expect(updater.updating).toBe(false)
    })

    test("the timeout aborts a probe that never answers", async () => {
      const engine = installedEngine()
      engine.probeHangs = (binaryPath) => binaryPath.includes(".staging-")

      const updater = new YtdlpUpdater({
        engine,
        http: createFakeHttp(),
        updateTimeoutMs: 30
      })

      const result = await updater.updateNow()

      expect(result.reason).toBe("cancelled")
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "installed engine"
      )
      expect(leftovers(engine)).toEqual([])
      expect(engine.gate.isBusy()).toBe(false)
    })

    test("a cancel landing after the probe still stops the swap", async () => {
      const engine = installedEngine()
      const updater = new YtdlpUpdater({ engine, http: createFakeHttp() })

      // stand in for a cancel that lands in the gap between "the staged engine
      // checks out" and the renames: the staged result carries an aborted
      // signal, which is the last thing checked before the swap
      const realStageRelease = updater.stageRelease.bind(updater)
      updater.stageRelease = async (tag) => {
        const staged = await realStageRelease(tag)
        const controller = new AbortController()
        controller.abort()
        return { ...staged, signal: controller.signal }
      }

      const result = await updater.updateNow()

      expect(result).toMatchObject({ updated: false, reason: "cancelled" })
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "installed engine"
      )
      expect(leftovers(engine)).toEqual([])
      expect(engine.gate.isBusy()).toBe(false)
    })

    test("a download waiting behind the update is only granted once it ends", async () => {
      const engine = installedEngine()
      let probeStarted = null
      const started = new Promise((resolve) => {
        probeStarted = resolve
      })

      engine.probeHangs = (binaryPath) => binaryPath.includes(".staging-")
      engine.onProbeStart = () => probeStarted()

      const updater = new YtdlpUpdater({ engine, http: createFakeHttp() })
      const running = updater.updateNow()

      await started

      let granted = false
      const queued = engine.gate.acquireRead().then((release) => {
        granted = true
        return release
      })

      await wait(10)
      expect(granted).toBe(false)

      updater.terminateUpdate()
      await running

      const release = await queued
      expect(granted).toBe(true)
      release()
    })
  })

  describe("the staged engine must be the release we asked for", () => {
    test("an archive reporting a different version is refused", async () => {
      const engine = installedEngine()

      // checksum-valid, unpacks fine, but it is not what the tag promised
      const http = createFakeHttp({ zip: makeEngineZip(EXECUTABLE, "2025.01.01") })

      const result = await new YtdlpUpdater({ engine, http }).updateNow()

      expect(result).toMatchObject({
        updated: false,
        reason: "version-mismatch",
        error: expect.stringContaining("2025.01.01"),
        tag: LATEST
      })
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "installed engine 2026.08.19"
      )
      expect(leftovers(engine)).toEqual([])
      expect(engine.gate.isBusy()).toBe(false)
    })

    test("an archive older than what is installed cannot downgrade it", async () => {
      const engine = installedEngine()
      const http = createFakeHttp({ zip: makeEngineZip(EXECUTABLE, "2020.01.01") })

      const result = await new YtdlpUpdater({ engine, http }).updateNow()

      expect(result.reason).toBe("version-mismatch")
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "installed engine 2026.08.19"
      )
    })

    test("the matching release is still installed", async () => {
      const engine = installedEngine()

      const result = await new YtdlpUpdater({ engine, http: createFakeHttp() }).updateNow()

      expect(result).toMatchObject({ updated: true, reason: "completed", to: LATEST })
    })
  })

  describe("a failed swap never leaves the engine stranded", () => {
    test("a failure retiring the live engine leaves it exactly where it was", async () => {
      const engine = installedEngine()
      failRenamesWhen((_from, to) => to.includes(".retired-"))

      const result = await new YtdlpUpdater({ engine, http: createFakeHttp() }).updateNow()

      expect(result).toMatchObject({ updated: false, reason: "swap-failed" })
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "installed engine"
      )
      expect(leftovers(engine)).toEqual([])
      expect(engine.gate.isBusy()).toBe(false)
    })

    test("a failure moving the new engine in rolls the old one back", async () => {
      const engine = installedEngine()
      failRenamesWhen((from) => from.includes(".staging-"))

      const result = await new YtdlpUpdater({ engine, http: createFakeHttp() }).updateNow()

      expect(result).toMatchObject({
        updated: false,
        reason: "swap-failed",
        to: "2026.08.19"
      })
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "installed engine 2026.08.19"
      )
      expect(fs.readdirSync(engine.engineDir).filter((n) => n.includes("retired"))).toEqual([])
      expect(engine.gate.isBusy()).toBe(false)
    })

    test("a failed rollback is repaired from the packaged engine", async () => {
      const engine = installedEngine()
      writeEngineDir(engine.bundledDir, "bundled engine 2026.08.19")

      // both the swap and the attempt to put the old engine back fail
      failRenamesWhen(
        (from) => from.includes(".staging-") || from.includes(".retired-")
      )

      const result = await new YtdlpUpdater({ engine, http: createFakeHttp() }).updateNow()

      expect(result).toMatchObject({ updated: false, reason: "repaired" })
      // the point of the finding: something runnable is back where the engine
      // looks for it, rather than the gate reopening onto an empty path
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "bundled engine"
      )
      expect(engine.gate.isBusy()).toBe(false)
    })

    test("with nothing left to repair from, the stranded copy is kept and reported", async () => {
      const engine = installedEngine()

      // no bundled engine to fall back on: the live engine moves out of the
      // way, and then nothing can be moved back in
      failRenamesWhen((_from, to) => !to.includes(".retired-"))

      const result = await new YtdlpUpdater({ engine, http: createFakeHttp() }).updateNow()

      expect(result).toMatchObject({ updated: false, reason: "swap-stranded", to: null })
      expect(result.strandedAt).toEqual(expect.stringContaining(".retired-"))

      // the user's only engine is still on disk, and we said where
      expect(fs.existsSync(path.join(result.strandedAt, EXECUTABLE))).toBe(true)
      expect(error).toHaveBeenCalledWith(expect.stringContaining("stranded"))
      expect(engine.gate.isBusy()).toBe(false)
    })
  })

  describe("the packaged-engine version cache", () => {
    test("a failed probe is not remembered, so the next launch retries", async () => {
      const engine = createFakeEngine(root)
      writeEngineDir(engine.bundledDir, "bundled engine")
      writeEngineDir(engine.installedDir, "installed engine")
      engine.versions[engine.installedExecutable] = "2026.01.01"

      // a one-off failure: a scanner holding the file, a timeout, anything
      engine.versions[engine.bundledExecutable] = null

      const updater = new YtdlpUpdater({ engine })
      expect((await updater.seed()).reason).toBe("up-to-date")
      expect(fs.existsSync(path.join(engine.engineDir, ".bundled-engine.json"))).toBe(false)

      // the same file, unchanged - it must be probed again rather than written off
      engine.versions[engine.bundledExecutable] = "2026.08.19"

      const result = await updater.seed()

      expect(result.reason).toBe("bundled-newer")
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toBe("bundled engine")
    })

    test("a marker holding junk instead of a version is ignored", async () => {
      const engine = createFakeEngine(root)
      writeEngineDir(engine.bundledDir, "bundled engine 2026.08.19")
      writeEngineDir(engine.installedDir, "installed engine 2026.01.01")

      const stats = fs.statSync(engine.bundledExecutable)
      fs.writeFileSync(
        path.join(engine.engineDir, ".bundled-engine.json"),
        JSON.stringify({
          path: engine.bundledExecutable,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          // non-empty, but no version at all - it would compare as the oldest
          // release there has ever been and suppress every bundled upgrade
          version: "not-a-version"
        })
      )

      const result = await new YtdlpUpdater({ engine }).seed()

      expect(result.reason).toBe("bundled-newer")
      expect(fs.readFileSync(engine.installedExecutable, "utf8")).toContain(
        "bundled engine"
      )
    })

    test("junk is never written to the marker in the first place", async () => {
      const engine = createFakeEngine(root)
      writeEngineDir(engine.bundledDir, "bundled engine")
      writeEngineDir(engine.installedDir, "installed engine")
      engine.versions[engine.bundledExecutable] = "yt-dlp is not feeling well"

      await new YtdlpUpdater({ engine }).seed()

      expect(fs.existsSync(path.join(engine.engineDir, ".bundled-engine.json"))).toBe(false)
    })

    test("a marker with no usable version in it is ignored", async () => {
      const engine = createFakeEngine(root)
      writeEngineDir(engine.bundledDir, "bundled engine 2026.08.19")
      writeEngineDir(engine.installedDir, "installed engine 2026.01.01")

      const stats = fs.statSync(engine.bundledExecutable)
      fs.writeFileSync(
        path.join(engine.engineDir, ".bundled-engine.json"),
        JSON.stringify({
          path: engine.bundledExecutable,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          version: null
        })
      )

      const result = await new YtdlpUpdater({ engine }).seed()

      expect(result.reason).toBe("bundled-newer")
    })
  })
})
