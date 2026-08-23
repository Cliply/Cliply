// downloads the official yt-dlp onedir engine for builds
//
// BUILD_TARGET_PLATFORM / BUILD_ALL_PLATFORMS pick which platform(s) to fetch,
// matching the env vars the dist:* scripts already set
//
// the onedir zips are used rather than the single-file builds: a onefile
// yt-dlp re-extracts ~50 mb on every invocation and macos rescans it each
// time, which measured 43-108 s per run (upstream yt-dlp#10425)

const fs = require("fs").promises
const path = require("path")
const https = require("https")
const { createWriteStream } = require("fs")
const { spawn } = require("child_process")

const {
  extractZip,
  sha256File,
  parseChecksums
} = require("../src/main/utils/archive")
const {
  resolveExecutableIn,
  legacyBinaryName,
  ENGINE_DIR_NAME
} = require("../src/main/services/ytdlp-engine")

const RELEASE_LATEST_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest"
const RELEASE_DOWNLOAD_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download"
const CHECKSUM_ASSET = "SHA2-256SUMS"
const TAG_PATTERN = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/

// "win32-x64" -> "win32": which executable names to expect in the archive
function nodePlatformOf(platformKey) {
  return String(platformKey).split("-")[0]
}

class YtdlpFetcher {
  constructor() {
    this.binariesDir = path.join(__dirname, "..", "binaries")
    this.tag = null
    this.checksums = null

    // platform key -> { asset (release zip), dir (binaries subdir) }
    // every zip unpacks to <dir>/ytdlp/, holding the executable next to its
    // _internal/ payload
    this.targets = {
      "win32-x64": { asset: "yt-dlp_win.zip", dir: "windows" },
      "win32-ia32": { asset: "yt-dlp_win_x86.zip", dir: "windows" },
      "win32-arm64": { asset: "yt-dlp_win_arm64.zip", dir: "windows" },
      "darwin-x64": { asset: "yt-dlp_macos.zip", dir: "macos" },
      "darwin-arm64": { asset: "yt-dlp_macos.zip", dir: "macos" },
      "linux-x64": { asset: "yt-dlp_linux.zip", dir: "linux" },
      "linux-arm64": { asset: "yt-dlp_linux_aarch64.zip", dir: "linux" }
    }
  }

  // fetch for the requested platform(s)
  async fetch() {
    try {
      console.log("fetching yt-dlp engine...")

      const targetPlatform = process.env.BUILD_TARGET_PLATFORM
      const fetchAll =
        process.env.BUILD_ALL_PLATFORMS || process.argv.includes("--all")

      if (targetPlatform) {
        console.log(`fetching target platform: ${targetPlatform}`)
        await this.fetchPlatform(targetPlatform)
      } else if (fetchAll) {
        console.log("fetching all platforms...")
        for (const platform of Object.keys(this.targets)) {
          console.log(`\nfetching ${platform}...`)
          await this.fetchPlatform(platform)
        }
      } else {
        console.log("fetching current platform only...")
        await this.fetchPlatform(this.getPlatform())
      }

      console.log("yt-dlp fetch completed successfully")
    } catch (error) {
      console.error("yt-dlp fetch failed:", error.message)
      throw error
    }
  }

  // download, verify and unpack the engine for one platform
  async fetchPlatform(platform) {
    const target = this.targets[platform]

    if (!target) {
      throw new Error(`Unsupported platform: ${platform}`)
    }

    const tag = await this.getLatestTag()
    const nodePlatform = nodePlatformOf(platform)
    const platformDir = path.join(this.binariesDir, target.dir)
    const engineDir = path.join(platformDir, ENGINE_DIR_NAME)

    await fs.mkdir(platformDir, { recursive: true })

    const force = process.argv.includes("--force")

    if (!force && resolveExecutableIn(engineDir, nodePlatform)) {
      const existing = await this.probeVersion(engineDir, platform)

      if (existing === tag) {
        console.log(`${platform} yt-dlp already at ${tag}`)
        return
      }

      if (platform !== this.getPlatform()) {
        console.log(`${platform} yt-dlp already present (cannot probe from here)`)
        return
      }

      console.log(
        `${platform} yt-dlp is ${existing || "unusable"}, replacing with ${tag}`
      )
    }

    const workDir = path.join(platformDir, `.${ENGINE_DIR_NAME}-download`)
    const stagingDir = path.join(platformDir, `.${ENGINE_DIR_NAME}-staging`)

    try {
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.rm(stagingDir, { recursive: true, force: true })
      await fs.mkdir(workDir, { recursive: true })

      const zipPath = path.join(workDir, target.asset)
      console.log(`downloading ${target.asset} (${tag}) for ${platform}...`)
      await this.downloadFile(`${this.releaseBase(tag)}/${target.asset}`, zipPath)

      const stats = await fs.stat(zipPath)
      if (stats.size < 1024 * 1024) {
        throw new Error(
          `downloaded ${target.asset} is too small (${stats.size} bytes)`
        )
      }

      const expected = (await this.getChecksums(tag)).get(target.asset)
      if (!expected) {
        throw new Error(`${target.asset} is not listed in ${CHECKSUM_ASSET}`)
      }

      const digest = await sha256File(zipPath)
      if (digest !== expected) {
        throw new Error(
          `${target.asset} checksum mismatch: ${digest} != ${expected}`
        )
      }
      console.log("checksum verified")

      await extractZip(zipPath, stagingDir)

      const staged = resolveExecutableIn(stagingDir, nodePlatform)
      if (!staged) {
        throw new Error(`${target.asset} did not contain a yt-dlp executable`)
      }
      await fs.chmod(staged, 0o755)

      await fs.rm(engineDir, { recursive: true, force: true })
      await fs.rename(stagingDir, engineDir)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }

    // builds before the onedir switch left a single self-extracting file here
    await this.removeLegacyOnefile(platformDir, nodePlatform)

    const version = await this.probeVersion(engineDir, platform)
    console.log(
      version
        ? `installed yt-dlp ${version} -> ${engineDir}`
        : `installed yt-dlp ${tag} -> ${engineDir}`
    )
  }

  releaseBase(tag) {
    return `${RELEASE_DOWNLOAD_BASE}/${encodeURIComponent(tag)}`
  }

  // the /releases/latest redirect names the newest stable tag
  async getLatestTag() {
    if (this.tag) {
      return this.tag
    }

    const response = await this.request(RELEASE_LATEST_URL)
    response.resume()

    const location = response.headers.location || ""
    const tag = decodeURIComponent(
      location.split(/[?#]/)[0].split("/").filter(Boolean).pop() || ""
    )

    if (!TAG_PATTERN.test(tag)) {
      throw new Error(`could not read the latest yt-dlp tag (${location || "no redirect"})`)
    }

    console.log(`latest stable yt-dlp: ${tag}`)
    this.tag = tag
    return tag
  }

  async getChecksums(tag) {
    if (this.checksums) {
      return this.checksums
    }

    const response = await this.requestWithRedirects(
      `${this.releaseBase(tag)}/${CHECKSUM_ASSET}`
    )

    let body = ""
    response.setEncoding("utf8")
    for await (const chunk of response) {
      body += chunk
    }

    this.checksums = parseChecksums(body)
    return this.checksums
  }

  // the platform-specific executable name lives inside the unpacked dir, so
  // the probe resolves it rather than assuming one
  async probeVersion(engineDir, platform) {
    if (platform !== this.getPlatform()) {
      return null
    }

    const binaryPath = resolveExecutableIn(engineDir, nodePlatformOf(platform))

    if (!binaryPath) {
      return null
    }

    return new Promise((resolve) => {
      let output = ""

      const child = spawn(binaryPath, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"]
      })

      // a freshly unpacked engine is scanned by the os on its first run
      const timeout = setTimeout(() => {
        child.kill("SIGKILL")
        resolve(null)
      }, 120000)

      child.stdout.on("data", (data) => {
        output += data.toString()
      })

      child.on("close", (code) => {
        clearTimeout(timeout)
        resolve(code === 0 ? output.trim() : null)
      })

      child.on("error", () => {
        clearTimeout(timeout)
        resolve(null)
      })
    })
  }

  async removeLegacyOnefile(platformDir, nodePlatform) {
    const legacy = path.join(platformDir, legacyBinaryName(nodePlatform))

    try {
      const stats = await fs.stat(legacy)

      if (stats.isFile()) {
        await fs.rm(legacy, { force: true })
        console.log(`removed the legacy single-file engine at ${legacy}`)
      }
    } catch {
      // nothing to clean up
    }
  }

  // detect the platform key for the current machine
  getPlatform() {
    const platform = process.platform
    const arch = process.arch

    if (platform === "win32") {
      if (arch === "arm64") return "win32-arm64"
      return arch === "x64" ? "win32-x64" : "win32-ia32"
    } else if (platform === "darwin") {
      return arch === "arm64" ? "darwin-arm64" : "darwin-x64"
    } else if (platform === "linux") {
      return arch === "arm64" ? "linux-arm64" : "linux-x64"
    }

    throw new Error(`Unsupported platform: ${platform}-${arch}`)
  }

  // download file from url with progress
  // redirects are resolved before the destination file is touched, so an
  // aborted redirect chain can never clobber an already-written file
  async downloadFile(url, destination) {
    const response = await this.requestWithRedirects(url)

    return new Promise((resolve, reject) => {
      const file = createWriteStream(destination)

      const fail = (error) => {
        response.destroy()
        file.close()
        fs.rm(destination, { force: true }).catch(() => {})
        reject(error)
      }

      const totalSize = parseInt(response.headers["content-length"], 10)
      let downloadedSize = 0
      let lastPercent = -1

      response.on("data", (chunk) => {
        downloadedSize += chunk.length
        if (totalSize > 0) {
          const percent = Math.floor((downloadedSize / totalSize) * 100)
          if (percent > lastPercent) {
            lastPercent = percent
            process.stdout.write(
              `\rdownloading... ${percent}% (${this.formatBytes(
                downloadedSize
              )}/${this.formatBytes(totalSize)})`
            )
          }
        }
      })

      response.on("error", fail)
      file.on("error", fail)

      file.on("finish", () => {
        file.close()
        console.log("\ndownload completed")
        resolve()
      })

      response.pipe(file)
    })
  }

  // one request, redirects left to the caller
  request(url) {
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        { headers: { "user-agent": "Cliply-Build", accept: "*/*" } },
        resolve
      )

      request.on("error", reject)

      request.setTimeout(120000, () => {
        request.destroy(new Error("request timeout"))
      })
    })
  }

  // follow redirects and hand back the final 200 response stream
  async requestWithRedirects(url, redirects = 0) {
    if (redirects > 5) {
      throw new Error("too many redirects while downloading yt-dlp")
    }

    const response = await this.request(url)

    // github release assets always redirect to a cdn url
    if (
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      response.headers.location
    ) {
      response.resume()
      return this.requestWithRedirects(
        new URL(response.headers.location, url).toString(),
        redirects + 1
      )
    }

    if (response.statusCode !== 200) {
      response.resume()
      throw new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`)
    }

    return response
  }

  formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB"]
    let value = bytes
    let unit = 0

    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit++
    }

    return `${value.toFixed(1)}${units[unit]}`
  }
}

// run when invoked directly
if (require.main === module) {
  new YtdlpFetcher().fetch().catch(() => {
    process.exit(1)
  })
}

module.exports = YtdlpFetcher
