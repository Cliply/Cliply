const fs = require("node:fs/promises")
const path = require("node:path")
const { MediaError } = require("./errors")

const TARGETS = {
  "darwin-arm64": { directory: "macos", executable: "ffprobe", asset: "ffprobe" },
  "win32-x64": { directory: "windows", executable: "ffprobe.exe", asset: "ffprobe.exe" },
  "linux-x64": { directory: "linux", executable: "ffprobe", asset: "ffprobe-linux-x64" }
}

// No PATH fallback and no runtime download. The override is explicit development
// injection, ignored by packaged apps. Shared release assets are still pending.
async function resolveFfprobe({
  isPackaged = true,
  resourcesPath = process.resourcesPath,
  projectRoot = path.resolve(__dirname, "../../../.."),
  platform = process.platform,
  arch = process.arch,
  developmentPath
} = {}) {
  const target = TARGETS[`${platform}-${arch}`]
  if (!target) throw new MediaError("PROBE_MISSING")
  const candidate = isPackaged
    ? resourcesPath && path.join(resourcesPath, "binaries", target.executable)
    : developmentPath || path.join(projectRoot, "binaries", target.directory, target.executable)
  try {
    if (!candidate || !path.isAbsolute(candidate)) throw new Error()
    if (!(await fs.stat(candidate)).isFile()) throw new Error()
    await fs.access(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)
    return candidate
  } catch {
    throw new MediaError("PROBE_MISSING")
  }
}

module.exports = { TARGETS, resolveFfprobe }
