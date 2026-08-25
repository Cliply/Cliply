/**
 * fetching the PO token payload into userData/pot.
 *
 * the whole point of this service is that it can fail without anyone noticing,
 * so these are about the three ways that promise could quietly break: bytes we
 * did not vouch for getting installed, a half-written payload becoming visible
 * at the live path, and a failure escaping into the operation that triggered it.
 */

const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { makeZip } = require("./helpers/zip-fixture")
const {
  PotInstaller,
  VERSION_MARKER,
  POT_CHECKSUMS,
  payloadAssetFor
} = require("../src/main/services/pot-installer")

let root
let potDir

// a payload with both of the halves getPotPaths() insists on
const PAYLOAD_ENTRIES = [
  { name: "plugin/bgutil-plugin.zip", data: Buffer.from("not really a zip") },
  { name: "server/src/generate_once.ts", data: Buffer.from("console.log(1)") },
  { name: "server/package.json", data: Buffer.from('{"version":"1.3.2"}') }
]

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex")

// every file under a directory, ignoring the version marker the installer adds
function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0

  let total = 0

  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name !== VERSION_MARKER) total++
  }

  return total
}

/**
 * an installer whose engine reports the payload the way the real one does -
 * by looking on disk for both halves - so the presence checks under test are
 * answered by the filesystem rather than by a flag the test sets
 */
function createInstaller({ archive, download } = {}) {
  const engine = {
    getUserDataPath: () => root,
    getPotPaths: () => {
      const pluginDir = path.join(potDir, "plugin")
      const serverHome = path.join(potDir, "server")

      return fs.existsSync(pluginDir) && fs.existsSync(serverHome)
        ? { pluginDir, serverHome }
        : null
    }
  }

  const http = {
    download:
      download ||
      jest.fn(async (_url, destPath) => {
        fs.writeFileSync(destPath, archive)
        return sha256(archive)
      })
  }

  return { installer: new PotInstaller({ engine, http }), http, engine }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-pot-"))
  potDir = path.join(root, "pot")
  process.env.CLIPLY_POT_SHA256 = sha256(makeZip(PAYLOAD_ENTRIES))
})

afterEach(() => {
  delete process.env.CLIPLY_POT_SHA256
  delete process.env.CLIPLY_POT_BASE_URL
  fs.rmSync(root, { recursive: true, force: true })
})

test("installs a payload whose bytes match what we vouched for", async () => {
  const { installer } = createInstaller({ archive: makeZip(PAYLOAD_ENTRIES) })

  const result = await installer.ensureInstalled()

  expect(result.installed).toBe(true)
  expect(fs.existsSync(path.join(potDir, "plugin"))).toBe(true)
  expect(fs.existsSync(path.join(potDir, "server"))).toBe(true)
})

// not in scope to refresh it, but the version has to be readable by whatever
// eventually does - the plugin and the generator are version-locked, so
// replacing them means first knowing what is there
test("records what it installed", async () => {
  const { installer } = createInstaller({ archive: makeZip(PAYLOAD_ENTRIES) })

  await installer.ensureInstalled()

  const marker = JSON.parse(
    fs.readFileSync(path.join(potDir, VERSION_MARKER), "utf8")
  )
  expect(marker.version).toBe("1.3.2")
})

describe("nothing unverified is ever installed", () => {
  test("a payload that does not match its checksum is refused", async () => {
    const { installer } = createInstaller({ archive: makeZip(PAYLOAD_ENTRIES) })
    process.env.CLIPLY_POT_SHA256 = "0".repeat(64)

    const result = await installer.ensureInstalled()

    expect(result.installed).toBe(false)
    expect(result.reason).toBe("checksum-mismatch")
    expect(fs.existsSync(potDir)).toBe(false)
  })

  // a platform we have not published and digested a payload for must decline
  // rather than fetch whatever answers the url. every shipping platform now
  // has a digest, so the unpublished case is reached by taking this one's away
  test("an asset nobody has vouched for is never fetched at all", async () => {
    const { installer, http } = createInstaller({ archive: makeZip(PAYLOAD_ENTRIES) })
    delete process.env.CLIPLY_POT_SHA256

    const asset = payloadAssetFor()
    const pinned = POT_CHECKSUMS[asset]
    delete POT_CHECKSUMS[asset]

    try {
      expect(installer.canInstall()).toBe(false)

      const result = await installer.ensureInstalled()

      expect(result.installed).toBe(false)
      expect(result.reason).toBe("no-payload-published")
      expect(http.download).not.toHaveBeenCalled()
    } finally {
      POT_CHECKSUMS[asset] = pinned
    }
  })

  // and the platforms we do ship are pinned, or the feature is dead on arrival
  test("every platform we ship has a digest pinned", () => {
    for (const platform of [
      ["win32", "x64"],
      ["darwin", "arm64"]
    ]) {
      expect(POT_CHECKSUMS[payloadAssetFor(...platform)]).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test("an archive missing half the payload is refused", async () => {
    // the engine treats plugin-without-server as absent, so installing this
    // would leave a directory that is never used and never replaced
    const halfPayload = makeZip([PAYLOAD_ENTRIES[0]])
    const { installer } = createInstaller({ archive: halfPayload })
    process.env.CLIPLY_POT_SHA256 = sha256(halfPayload)

    const result = await installer.ensureInstalled()

    expect(result.installed).toBe(false)
    expect(result.reason).toBe("payload-layout-unexpected")
    expect(fs.existsSync(potDir)).toBe(false)
  })
})

describe("the app carries on regardless", () => {
  test("a download that throws is reported, not raised", async () => {
    const { installer } = createInstaller({
      download: jest.fn().mockRejectedValue(new Error("network is down"))
    })

    const result = await installer.ensureInstalled()

    expect(result.installed).toBe(false)
    expect(result.reason).toBe("install-failed")
    // and the engine still finds no payload, which is exactly today's behaviour
    expect(fs.existsSync(potDir)).toBe(false)
  })

  test("a failed attempt leaves nothing behind for the next one to trip on", async () => {
    const { installer } = createInstaller({
      download: jest.fn().mockRejectedValue(new Error("network is down"))
    })

    await installer.ensureInstalled()

    expect(fs.readdirSync(root)).toEqual([])
  })
})

describe("one install at a time", () => {
  test("a user retrying three times starts one download", async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const archive = makeZip(PAYLOAD_ENTRIES)

    const download = jest.fn(async (_url, destPath) => {
      await gate
      fs.writeFileSync(destPath, archive)
      return sha256(archive)
    })

    const { installer } = createInstaller({ download })

    const all = Promise.all([
      installer.ensureInstalled(),
      installer.ensureInstalled(),
      installer.ensureInstalled()
    ])

    release()
    const results = await all

    expect(download).toHaveBeenCalledTimes(1)
    expect(results.every((result) => result.installed)).toBe(true)
  })

  test("a payload that is already there costs no network at all", async () => {
    const { installer, http } = createInstaller({ archive: makeZip(PAYLOAD_ENTRIES) })

    await installer.ensureInstalled()
    http.download.mockClear()

    const again = await installer.ensureInstalled()

    expect(again.reason).toBe("already-installed")
    expect(http.download).not.toHaveBeenCalled()
  })
})

/**
 * the reason the install is a rename rather than an unpack in place.
 *
 * getPotPaths() accepts any directory holding a `plugin` and a `server`, so a
 * pot/ that is midway through being written satisfies it - and the engine
 * would then hand yt-dlp a --plugin-dirs pointing at a tree still being
 * filled in. unpacking into a staging directory means the live path only ever
 * appears complete.
 */
test("the live path never exists in a half-written state", async () => {
  // enough entries that unpacking spans many ticks of the event loop - the
  // window this is about is the one *inside* extractZip, which awaits per
  // entry, and a three-file payload closes it too fast to observe
  const wide = [
    { name: "plugin/bgutil-plugin.zip", data: Buffer.from("not really a zip") },
    ...Array.from({ length: 400 }, (_, index) => ({
      name: `server/node_modules/pkg-${index}/index.js`,
      data: Buffer.from(`module.exports = ${index}`)
    }))
  ]
  const archive = makeZip(wide)

  const { installer, engine } = createInstaller({ archive })
  process.env.CLIPLY_POT_SHA256 = sha256(archive)

  // what the engine would see, sampled throughout: is there a payload, and if
  // so is all of it there
  const seen = []
  const watch = setInterval(() => {
    seen.push({
      visible: Boolean(engine.getPotPaths()),
      files: countFiles(potDir)
    })
  }, 0)

  await installer.ensureInstalled()
  clearInterval(watch)

  // the sampler has to have actually run, or this proves nothing
  expect(seen.length).toBeGreaterThan(0)

  // the property under test: the moment the payload becomes visible to the
  // engine, all of it is there. a visible-but-short observation is the engine
  // pointing yt-dlp at a tree still being filled in
  const partial = seen.filter((sample) => sample.visible && sample.files < wide.length)
  expect(partial).toEqual([])

  expect(engine.getPotPaths()).not.toBeNull()
  expect(countFiles(potDir)).toBe(wide.length)
})
