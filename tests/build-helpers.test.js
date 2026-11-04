const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const yaml = require("js-yaml")
const { fetchHelpers } = require("../scripts/fetch-helpers")
const { verifyReleaseArtifacts } = require("../scripts/verify-release-artifacts")
const { version } = require("../package.json")
const sourcePin = require("../third-party/ffprobe/source-build.json")

let root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-build-helpers-"))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

// Only the native file headers matter to acquisition; no executable code is
// needed to exercise the staging, platform checks, or installation paths.
function executable(platform, marker = "new helper") {
  const header = Buffer.alloc(128)
  if (platform === "linux-x64") {
    Buffer.from([127, 69, 76, 70, 2, 1]).copy(header)
    header.writeUInt16LE(62, 18)
  } else if (platform === "darwin-arm64") {
    header.writeUInt32LE(0xfeedfacf, 0)
    header.writeUInt32LE(0x100000c, 4)
  } else {
    header.write("MZ")
    header.writeUInt32LE(64, 60)
    header.writeUInt32LE(0x4550, 64)
    header.writeUInt16LE(0x8664, 68)
  }
  return Buffer.concat([header, Buffer.from(marker)])
}

function fakeDownloads(platform) {
  return {
    download: jest.fn(async (url, destination) => {
      await fs.writeFile(destination, executable(platform, path.basename(url)))
    })
  }
}

async function seedLinuxHelpers() {
  const files = [path.join(root, "linux/ffmpeg"), path.join(root, "deno/linux/deno")]
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "existing helper")
  }
  return files
}

async function expectNoStaging() {
  expect((await fs.readdir(root)).filter((name) => name.startsWith(".helpers-"))).toEqual([])
}

describe("native helper acquisition", () => {
  test.each([
    ["linux-x64", "linux", ["ffmpeg-linux-x64", "deno-linux-x64"], ""],
    ["darwin-arm64", "macos", ["ffmpeg", "deno"], ""],
    ["win32-x64", "windows", ["ffmpeg.exe", "deno.exe"], ".exe"]
  ])("installs %s helpers from the expected release assets", async (platform, directory, assets, suffix) => {
    const http = fakeDownloads(platform)
    await fetchHelpers({ platform, binariesDir: root, baseUrl: "https://helpers.example/binaries", http, ffprobeRecords: {} })

    expect(http.download.mock.calls.map(([url]) => url).sort()).toEqual(
      assets.map((asset) => `https://helpers.example/binaries/${asset}`).sort()
    )
    for (const [index, file] of [
      path.join(root, directory, `ffmpeg${suffix}`),
      path.join(root, "deno", directory, `deno${suffix}`)
    ].entries()) {
      expect(await fs.readFile(file)).toEqual(executable(platform, assets[index]))
      if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o755)
    }
    await expectNoStaging()
  })

  test.each(["missing", "wrong architecture"])("a %s Linux helper preserves both existing files", async (failure) => {
    const existing = await seedLinuxHelpers()
    const http = {
      download: jest.fn(async (url, destination) => {
        if (url.endsWith("deno-linux-x64")) {
          if (failure === "missing") throw new Error("HTTP 404: helper missing")
          await fs.writeFile(destination, executable("darwin-arm64"))
        } else {
          await new Promise((resolve) => setImmediate(resolve))
          await fs.writeFile(destination, executable("linux-x64"))
        }
      })
    }

    await expect(fetchHelpers({ platform: "linux-x64", binariesDir: root, http, ffprobeRecords: {} }))
      .rejects.toThrow(failure === "missing" ? "HTTP 404" : "not a linux-x64 executable")
    for (const file of existing) expect(await fs.readFile(file, "utf8")).toBe("existing helper")
    await expectNoStaging()
  })

  test("an unsupported platform creates nothing and performs no download", async () => {
    const http = fakeDownloads("linux-x64")
    const binariesDir = path.join(root, "not-created")

    await expect(fetchHelpers({ platform: "linux-arm64", binariesDir, http }))
      .rejects.toThrow("Unsupported helper platform")
    expect(http.download).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toEqual([])
  })
})

async function makeRelease() {
  const installers = {
    windows: `Cliply-${version}-Setup-x64.exe`,
    mac: `Cliply-${version}-arm64.zip`,
    dmg: `Cliply-${version}-arm64.dmg`,
    linux: `Cliply-${version}-x64.AppImage`,
    deb: `Cliply-${version}-x64.deb`
  }
  const bytes = Buffer.from("a small installer fixture")
  for (const name of Object.values(installers)) await fs.writeFile(path.join(root, name), bytes)
  const entry = (url) => ({
    url,
    size: bytes.length,
    sha512: crypto.createHash("sha512").update(bytes).digest("base64")
  })
  for (const [name, assets] of [
    ["latest.yml", [installers.windows]],
    ["latest-mac.yml", [installers.mac]],
    ["latest-linux.yml", [installers.linux, installers.deb]]
  ]) {
    await fs.writeFile(path.join(root, name), yaml.dump({
      version,
      files: assets.map(entry),
      path: assets[0],
      sha512: entry(assets[0]).sha512
    }))
  }
  return installers
}

// The verifier may reject before or during streamed hashing.
async function verify() {
  await verifyReleaseArtifacts(root)
}

describe("release attachment verification", () => {
  test("accepts genuine manifests matching every platform's attachments", async () => {
    await makeRelease()
    await expect(verify()).resolves.toBeUndefined()
  })

  test("rejects a manifest that references an unattached Linux installer", async () => {
    const installers = await makeRelease()
    await fs.rm(path.join(root, installers.linux))
    await expect(verify()).rejects.toThrow("references a missing attachment")
  })

  test("detects corrupted installer bytes even when the size is unchanged", async () => {
    const installers = await makeRelease()
    const file = path.join(root, installers.deb)
    const bytes = await fs.readFile(file)
    bytes[0] ^= 0xff
    await fs.writeFile(file, bytes)
    await expect(verify()).rejects.toThrow("SHA512 differs from manifest")
  })

  test("rejects placeholder update metadata", async () => {
    await makeRelease()
    await fs.writeFile(path.join(root, "latest-linux.yml"), yaml.dump({ version, files: [] }))
    await expect(verify()).rejects.toThrow("not real update metadata")
  })

  test("rejects a release missing its Linux update manifest", async () => {
    await makeRelease()
    await fs.rm(path.join(root, "latest-linux.yml"))
    await expect(verify()).rejects.toThrow("Missing release manifest: latest-linux.yml")
  })
})

describe("published FFprobe acquisition", () => {
  const records = (platform, bytes = executable(platform, "probe")) => {
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex")
    return { [platform]: { assetId: 123, assetName: `ffprobe-${sourcePin.commit.slice(0, 12)}-${platform}-${sha256.slice(0, 12)}${platform === "win32-x64" ? ".exe" : ""}`,
      sourceRecord: `distributions/${platform}/SOURCE.json`, sourceRecordSha256: "a".repeat(64), sha256 } }
  }
  test.each([["darwin-arm64", "macos", ""], ["linux-x64", "linux", ""], ["win32-x64", "windows", ".exe"]])("pins and stages %s in its target tree", async (platform, directory, suffix) => {
    const manifest = records(platform), asset = manifest[platform].assetName
    const http = { download: jest.fn(async (url, destination) => fs.writeFile(destination, executable(platform, url.endsWith(asset) ? "probe" : "other"))) }
    await fetchHelpers({ platform, binariesDir: root, http, ffprobeRecords: manifest, requireFfprobe: true })
    expect(await fs.readFile(path.join(root, directory, `ffprobe${suffix}`))).toEqual(executable(platform, "probe"))
    expect(http.download.mock.calls.some(([url]) => url.endsWith(`/binaries/${asset}`))).toBe(true)
    await expectNoStaging()
  })
  test.each(["missing", "digest", "architecture"])("%s failure preserves every existing helper and removes staging", async failure => {
    const existing = await seedLinuxHelpers(), probe = path.join(root, "linux/ffprobe")
    await fs.writeFile(probe, "existing probe"); existing.push(probe)
    const wrong = executable("darwin-arm64", "probe")
    const manifest = records("linux-x64", failure === "architecture" ? wrong : undefined)
    const http = { download: jest.fn(async (url, destination) => {
      if (url.endsWith(manifest["linux-x64"].assetName)) {
        if (failure === "missing") throw new Error("HTTP 404")
        return fs.writeFile(destination, wrong)
      }
      await new Promise(setImmediate); return fs.writeFile(destination, executable("linux-x64"))
    }) }
    await expect(fetchHelpers({ platform: "linux-x64", binariesDir: root, http, ffprobeRecords: manifest })).rejects.toThrow(
      failure === "missing" ? "HTTP 404" : failure === "digest" ? "SHA256 differs" : "not a linux-x64 executable")
    for (const file of existing) expect(await fs.readFile(file, "utf8")).toBe(file === probe ? "existing probe" : "existing helper")
    await expectNoStaging()
  })
  test("required capability refuses unpublished records before network or filesystem work", async () => {
    const http = fakeDownloads("linux-x64"), binariesDir = path.join(root, "absent")
    await expect(fetchHelpers({ platform: "linux-x64", binariesDir, http, ffprobeRecords: {}, requireFfprobe: true })).rejects.toThrow("No verified published FFprobe")
    expect(http.download).not.toHaveBeenCalled(); expect(await fs.readdir(root)).toEqual([])
  })
  test.each([{ sha256: "latest", assetId: 1, sourceRecord: "source" }, { sha256: "a".repeat(64), sourceRecord: "source" }, { sha256: "a".repeat(64), assetId: 1 }])("malformed publication record fails closed %p", record => {
    expect(() => require("../scripts/fetch-helpers").ffprobeRelease("linux-x64", { "linux-x64": record })).toThrow()
  })
  test.each([
    ["assetName", undefined], ["assetName", "ffprobe-linux-x64"], ["assetName", "../ffprobe"],
    ["assetName", "https://example.com/ffprobe"], ["assetName", "ffprobe-000000000000-linux-x64-000000000000"],
    ["assetId", 0], ["assetId", 1.5], ["sourceRecord", "../SOURCE.json"],
    ["sourceRecord", "distributions/darwin-arm64/SOURCE.json"], ["sourceRecordSha256", undefined],
    ["sourceRecordSha256", "A".repeat(64)], ["sha256", 123]
  ])("invalid %s=%s fails before downloading or creating directories", async (field, value) => {
    const manifest = records("linux-x64"), http = fakeDownloads("linux-x64")
    manifest["linux-x64"][field] = value
    await expect(fetchHelpers({ platform: "linux-x64", binariesDir: path.join(root, "absent"), http, ffprobeRecords: manifest })).rejects.toThrow("Invalid published FFprobe record")
    expect(http.download).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toEqual([])
  })
  test.each([null, false, 0, ""])("an explicitly present invalid record %p is not treated as unpublished", record => {
    expect(() => require("../scripts/fetch-helpers").ffprobeRelease("linux-x64", { "linux-x64": record })).toThrow("Invalid published FFprobe record")
  })
})
