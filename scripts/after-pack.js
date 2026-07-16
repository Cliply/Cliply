// post-build script: ensures bundled native binaries can actually run
// - macOS: chmod +x + ad-hoc codesign (stops Gatekeeper killing nested children)
// - linux: chmod +x
// - windows: nothing required

const fs = require("fs").promises
const path = require("path")
const { spawn } = require("child_process")

async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context

  console.log(`running after-pack for platform: ${electronPlatformName}`)
  console.log(`app output directory: ${appOutDir}`)

  try {
    switch (electronPlatformName) {
      case "darwin":
        await optimizeMacOS(appOutDir, packager)
        break
      case "win32":
        await optimizeWindows()
        break
      case "linux":
        await optimizeLinux(appOutDir)
        break
    }

    console.log("after-pack optimizations completed")
  } catch (error) {
    console.error("after-pack optimization failed:", error)
    // don't fail the build for optimization errors
  }
}

async function optimizeMacOS(appOutDir, packager) {
  console.log("applying macOS optimizations...")

  const appPath = path.join(
    appOutDir,
    `${packager.appInfo.productFilename}.app`
  )
  const resourcesPath = path.join(appPath, "Contents", "Resources")

  // matches APP_CONFIG.PYTHON_RUNTIME.EMBEDDED_PYTHON_DIR (mac builds are arm64-only)
  const pythonExe = path.join(
    resourcesPath,
    "python-runtime",
    "darwin-arm64",
    "bin",
    "python3"
  )
  const nativeBinaries = [
    path.join(resourcesPath, "binaries", "ffmpeg"),
    path.join(resourcesPath, "binaries", "ffprobe"),
    path.join(resourcesPath, "binaries", "deno", "deno"),
    pythonExe
  ]

  for (const bin of nativeBinaries) {
    if (!(await fileExists(bin))) continue
    await chmodExec(bin)
    // ad-hoc sign so the Hardened Runtime host process can exec these children
    // even when the app itself is unsigned (free, no Apple Developer ID needed)
    await adhocSign(bin)
  }
}

async function optimizeWindows() {
  console.log("applying windows optimizations...")
  // nothing to do: PE files don't need an executable bit,
  // and code signing (if any) happens through electron-builder's own signing step
}

async function optimizeLinux(appOutDir) {
  console.log("applying linux optimizations...")

  const resourcesPath = path.join(appOutDir, "resources")
  const nativeBinaries = [
    path.join(resourcesPath, "binaries", "ffmpeg"),
    path.join(resourcesPath, "binaries", "deno", "deno"),
    path.join(resourcesPath, "python-runtime", "linux-x64", "bin", "python3")
  ]

  for (const bin of nativeBinaries) {
    if (!(await fileExists(bin))) continue
    await chmodExec(bin)
  }
}

async function chmodExec(filePath) {
  try {
    await fs.chmod(filePath, 0o755)
    console.log(`chmod +x ${path.basename(filePath)}`)
  } catch (error) {
    console.warn(`chmod failed for ${filePath}: ${error.message}`)
  }
}

async function adhocSign(filePath) {
  try {
    await runCommand("codesign", ["--force", "--sign", "-", filePath])
    console.log(`ad-hoc signed ${path.basename(filePath)}`)
  } catch (error) {
    console.warn(`ad-hoc sign failed for ${filePath}: ${error.message}`)
  }
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit" })
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    )
    proc.on("error", reject)
  })
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

module.exports = afterPack
