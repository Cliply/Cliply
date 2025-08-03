// post-build script to fix platform specific stuff
// delete this later

const fs = require("fs").promises
const path = require("path")

async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context

  console.log(`running after-pack for platform: ${electronPlatformName}`)
  console.log(`app output directory: ${appOutDir}`)

  try {
    // platform-specific optimizations
    switch (electronPlatformName) {
      case "darwin":
        await optimizeMacOS(appOutDir, packager)
        break
      case "win32":
        await optimizeWindows(appOutDir, packager)
        break
      case "linux":
        await optimizeLinux(appOutDir, packager)
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
  const pythonRuntimePath = path.join(resourcesPath, "python-runtime")

  // set executable permissions for python binaries
  try {
    const pythonExe = path.join(pythonRuntimePath, "bin", "python3")
    if (await fileExists(pythonExe)) {
      const { spawn } = require("child_process")
      await new Promise((resolve, reject) => {
        const chmod = spawn("chmod", ["+x", pythonExe], { stdio: "inherit" })
        chmod.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`chmod failed: ${code}`))
        )
        chmod.on("error", reject)
      })
      console.log("set executable permissions for python")
    }
  } catch (error) {
    console.warn("failed to set python permissions:", error.message)
  }
}

async function optimizeWindows(appOutDir, packager) {
  console.log("applying windows optimizations...")

  const resourcesPath = path.join(appOutDir, "resources")
  const pythonRuntimePath = path.join(resourcesPath, "python-runtime")

  // windows specific optimizations
  // could add windows defender exclusions, etc.
  console.log("windows python runtime path:", pythonRuntimePath)
}

async function optimizeLinux(appOutDir, packager) {
  console.log("applying linux optimizations...")

  const resourcesPath = path.join(appOutDir, "resources")
  const pythonRuntimePath = path.join(resourcesPath, "python-runtime")

  // set executable permissions for python binaries
  try {
    const pythonExe = path.join(pythonRuntimePath, "bin", "python3")
    if (await fileExists(pythonExe)) {
      const { spawn } = require("child_process")
      await new Promise((resolve, reject) => {
        const chmod = spawn("chmod", ["+x", pythonExe], { stdio: "inherit" })
        chmod.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`chmod failed: ${code}`))
        )
        chmod.on("error", reject)
      })
      console.log("set executable permissions for python")
    }
  } catch (error) {
    console.warn("failed to set python permissions:", error.message)
  }
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
