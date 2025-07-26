// downloads and sets up portable python runtime for builds

const fs = require("fs").promises
const path = require("path")
const https = require("https")
const { pipeline } = require("stream/promises")
const { createWriteStream, createReadStream } = require("fs")
const { createGunzip } = require("zlib")
const tar = require("tar")

class PythonRuntimeSetup {
  constructor() {
    this.runtimeDir = path.join(__dirname, "..", "python-runtime")
    this.cacheDir = path.join(__dirname, "..", ".python-cache")

    // updated python standalone builds urls (latest stable)
    this.runtimeUrls = {
      "win32-x64":
        "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-x86_64-pc-windows-msvc-shared-install_only.tar.gz",
      "win32-ia32":
        "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-i686-pc-windows-msvc-shared-install_only.tar.gz",
      "darwin-x64":
        "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-x86_64-apple-darwin-install_only.tar.gz",
      "darwin-arm64":
        "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-aarch64-apple-darwin-install_only.tar.gz",
      "linux-x64":
        "https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-x86_64-unknown-linux-gnu-install_only.tar.gz"
    }
  }

  // setup python runtime for current platform or all platforms
  async setup() {
    try {
      console.log("setting up python runtime...")

      // check if we're in ci/build environment (setup all platforms)
      const setupAll =
        process.env.CI ||
        process.env.BUILD_ALL_PLATFORMS ||
        process.argv.includes("--all")

      // check if a specific target platform is requested
      const targetPlatform = process.env.BUILD_TARGET_PLATFORM

      if (setupAll) {
        console.log(
          "ci/build environment detected - setting up all platforms..."
        )
        await this.setupAllPlatforms()
      } else if (targetPlatform) {
        console.log(`setting up target platform: ${targetPlatform}`)
        await this.setupPlatform(targetPlatform)
      } else {
        console.log("setting up current platform only...")
        await this.setupCurrentPlatform()
      }

      console.log("python runtime setup completed successfully")
    } catch (error) {
      console.error("python runtime setup failed:", error.message)
      throw error
    }
  }

  // setup python runtime for current platform only
  async setupCurrentPlatform() {
    const platform = this.getPlatform()
    await this.setupPlatform(platform)
  }

  // setup python runtime for all platforms (for ci/build servers)
  async setupAllPlatforms() {
    const platforms = Object.keys(this.runtimeUrls)

    for (const platform of platforms) {
      console.log(`\nsetting up ${platform}...`)
      await this.setupPlatform(platform)
    }
  }

  // setup python runtime for a specific platform
  async setupPlatform(platform) {
    const url = this.runtimeUrls[platform]

    if (!url) {
      throw new Error(`Unsupported platform: ${platform}`)
    }

    // create platform-specific directories
    const platformCacheDir = path.join(this.cacheDir, platform)
    const platformRuntimeDir = path.join(this.runtimeDir, platform)

    await fs.mkdir(platformCacheDir, { recursive: true })
    await fs.mkdir(platformRuntimeDir, { recursive: true })

    // check if already set up
    const extractedMarker = path.join(platformRuntimeDir, ".python-ready")
    if (await this.fileExists(extractedMarker)) {
      console.log(`${platform} python runtime already set up`)
      return
    }

    // download runtime
    const cacheFile = path.join(platformCacheDir, `python-${platform}.tar.gz`)
    if (!(await this.fileExists(cacheFile))) {
      console.log(`downloading python runtime for ${platform}...`)
      await this.downloadFile(url, cacheFile)
    } else {
      console.log(`using cached python runtime for ${platform}`)
    }

    // extract runtime
    console.log(`extracting python runtime for ${platform}...`)
    await this.extractRuntime(cacheFile, platformRuntimeDir)

    // install python dependencies (skip for cross-platform builds)
    console.log(`installing python dependencies for ${platform}...`)
    await this.installDependencies(platform, platformRuntimeDir)

    // copy requirements.txt for runtime installation (cross-platform builds)
    await this.copyRequirements(platformRuntimeDir)

    // optimize runtime (remove unnecessary files)
    console.log(`optimizing python runtime for ${platform}...`)
    await this.optimizeRuntime(platformRuntimeDir, platform)

    // mark as ready
    await fs.writeFile(
      extractedMarker,
      JSON.stringify(
        {
          platform,
          setupDate: new Date().toISOString(),
          pythonVersion: "3.11.9"
        },
        null,
        2
      )
    )

    console.log(`${platform} python runtime setup completed`)
  }

  // get current platform identifier
  getPlatform() {
    const platform = process.platform
    const arch = process.arch

    if (platform === "win32") {
      return arch === "x64" ? "win32-x64" : "win32-ia32"
    } else if (platform === "darwin") {
      return arch === "arm64" ? "darwin-arm64" : "darwin-x64"
    } else if (platform === "linux") {
      return "linux-x64"
    }

    throw new Error(`Unsupported platform: ${platform}-${arch}`)
  }

  // download file from url with progress and resume support
  async downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(destination)

      const request = https.get(url, (response) => {
        // handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close()
          fs.unlink(destination).catch(() => {})
          return this.downloadFile(response.headers.location, destination)
            .then(resolve)
            .catch(reject)
        }

        if (response.statusCode !== 200) {
          file.close()
          fs.unlink(destination).catch(() => {})
          reject(
            new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`)
          )
          return
        }

        const totalSize = parseInt(response.headers["content-length"], 10)
        let downloadedSize = 0

        response.on("data", (chunk) => {
          downloadedSize += chunk.length
          if (totalSize > 0) {
            const percent = ((downloadedSize / totalSize) * 100).toFixed(1)
            const downloaded = this.formatBytes(downloadedSize)
            const total = this.formatBytes(totalSize)
            process.stdout.write(
              `\rdownloading... ${percent}% (${downloaded}/${total})`
            )
          }
        })

        response.pipe(file)

        file.on("finish", () => {
          file.close()
          console.log("\ndownload completed")
          resolve()
        })

        file.on("error", (error) => {
          file.close()
          fs.unlink(destination).catch(() => {})
          reject(error)
        })
      })

      request.on("error", (error) => {
        file.close()
        fs.unlink(destination).catch(() => {})
        reject(error)
      })

      request.setTimeout(30000, () => {
        request.destroy()
        file.close()
        fs.unlink(destination).catch(() => {})
        reject(new Error("Download timeout"))
      })
    })
  }

  // extract python runtime archive
  async extractRuntime(archivePath, extractPath) {
    // clear existing runtime
    await fs.rm(extractPath, { recursive: true, force: true })
    await fs.mkdir(extractPath, { recursive: true })

    // extract tar.gz with proper error handling
    try {
      await pipeline(
        createReadStream(archivePath),
        createGunzip(),
        tar.extract({
          cwd: extractPath,
          strip: 1,
          filter: (path) => {
            // skip unnecessary files during extraction
            return (
              !path.includes("__pycache__") &&
              !path.includes(".pyc") &&
              !path.includes("/test/") &&
              !path.includes("/tests/")
            )
          }
        })
      )
    } catch (error) {
      throw new Error(`Failed to extract Python runtime: ${error.message}`)
    }
  }

  // install python dependencies directly into the portable runtime
  // no venv needed - portable python is already isolated
  async installDependencies(platform, runtimePath) {
    const currentPlatform = this.getPlatform()

    // skip dependency installation for cross-platform builds
    if (platform !== currentPlatform) {
      console.log(
        `skipping dependency installation for ${platform} (cross-platform build from ${currentPlatform})`
      )
      console.log(
        "   dependencies will be installed at runtime by the application"
      )
      return
    }

    const pythonExe = this.getPythonExecutable(platform, runtimePath)
    const requirementsFile = path.join(
      __dirname,
      "..",
      "python",
      "requirements.txt"
    )

    if (!(await this.fileExists(requirementsFile))) {
      console.log(
        "no requirements.txt found, skipping dependency installation"
      )
      return
    }

    // verify python executable exists
    if (!(await this.fileExists(pythonExe))) {
      throw new Error(`Python executable not found: ${pythonExe}`)
    }

    console.log("installing dependencies into portable python runtime...")

    // first ensure pip is available and upgraded
    await this.ensurePip(pythonExe, runtimePath, platform)

    // install dependencies directly into the portable python
    await this.installRequirements(pythonExe, requirementsFile)

    console.log("dependencies installed successfully")
  }

  // ensure pip is available in the portable python runtime
  async ensurePip(pythonExe, runtimePath, platform) {
    console.log("ensuring pip is available...")

    const { spawn } = require("child_process")

    // first try to upgrade pip if it exists
    try {
      await new Promise((resolve, reject) => {
        const pipProcess = spawn(pythonExe, ["-m", "pip", "--version"], {
          stdio: ["pipe", "pipe", "pipe"]
        })

        pipProcess.on("close", (code) => {
          if (code === 0) {
            console.log("pip is available")
            resolve()
          } else {
            reject(new Error("Pip not available"))
          }
        })

        pipProcess.on("error", reject)
      })

      // upgrade pip
      await this.upgradePip(pythonExe)
    } catch (error) {
      console.log("installing pip...")
      await this.installPip(pythonExe, runtimePath, platform)
    }
  }

  // install pip using get-pip.py
  async installPip(pythonExe, runtimePath, _platform) {
    // download get-pip.py
    const getPipUrl = "https://bootstrap.pypa.io/get-pip.py"
    const getPipPath = path.join(runtimePath, "get-pip.py")

    try {
      await this.downloadFile(getPipUrl, getPipPath)

      const { spawn } = require("child_process")

      return new Promise((resolve, reject) => {
        console.log("installing pip...")

        const pipInstallProcess = spawn(pythonExe, [getPipPath, "--user"], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: runtimePath,
          env: { ...process.env, PYTHONUNBUFFERED: "1" }
        })

        let stderr = ""

        pipInstallProcess.stdout.on("data", (_data) => {
          process.stdout.write(".")
        })

        pipInstallProcess.stderr.on("data", (data) => {
          stderr += data.toString()
        })

        pipInstallProcess.on("close", (code) => {
          console.log("\n")

          // clean up get-pip.py
          fs.unlink(getPipPath).catch(() => {})

          if (code === 0) {
            console.log("pip installed successfully")
            resolve()
          } else {
            console.error("pip installation stderr:", stderr)
            reject(
              new Error(`Pip installation failed with code ${code}: ${stderr}`)
            )
          }
        })

        pipInstallProcess.on("error", (error) => {
          reject(new Error(`Failed to install pip: ${error.message}`))
        })
      })
    } catch (error) {
      throw new Error(`Failed to download/install pip: ${error.message}`)
    }
  }

  // upgrade pip to latest version
  async upgradePip(pythonExe) {
    const { spawn } = require("child_process")

    return new Promise((resolve) => {
      console.log("upgrading pip...")

      const pipProcess = spawn(
        pythonExe,
        ["-m", "pip", "install", "--upgrade", "pip", "--user"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PYTHONUNBUFFERED: "1" }
        }
      )

      pipProcess.on("close", (code) => {
        if (code === 0) {
          console.log("pip upgraded successfully")
        } else {
          console.log("pip upgrade failed, continuing...")
        }
        resolve() // don't fail the build for pip upgrade issues
      })

      pipProcess.on("error", () => {
        console.log("pip upgrade error, continuing...")
        resolve() // don't fail the build
      })
    })
  }

  // install requirements directly into portable python
  async installRequirements(pythonExe, requirementsFile) {
    const { spawn } = require("child_process")

    return new Promise((resolve, reject) => {
      console.log("installing requirements...")

      const args = [
        "-m",
        "pip",
        "install",
        "--user", // install to user directory within portable python
        "--no-warn-script-location",
        "--no-cache-dir",
        "--disable-pip-version-check",
        "--upgrade", // upgrade existing packages
        "-r",
        requirementsFile
      ]

      console.log(`running: ${pythonExe} ${args.join(" ")}`)

      const pipProcess = spawn(pythonExe, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          // ensure packages install to portable python user directory
          PYTHONUSERBASE: path.dirname(pythonExe)
        }
      })

      let stdout = ""
      let stderr = ""

      pipProcess.stdout.on("data", (data) => {
        const output = data.toString()
        stdout += output

        // show installation progress
        if (output.includes("Collecting") || output.includes("Installing")) {
          const lines = output.split("\n").filter((line) => line.trim())
          if (lines.length > 0) {
            console.log(`${lines[lines.length - 1].trim()}`)
          }
        } else {
          process.stdout.write(".")
        }
      })

      pipProcess.stderr.on("data", (data) => {
        stderr += data.toString()
      })

      pipProcess.on("close", (code) => {
        console.log("\n")
        if (code === 0) {
          console.log("requirements installed successfully")

          // show what was installed
          const installedPackages = stdout.match(/Successfully installed (.+)/g)
          if (installedPackages) {
            console.log(
              "installed packages:",
              installedPackages[installedPackages.length - 1]
            )
          }

          resolve()
        } else {
          console.error("pip install stderr:", stderr)
          console.error("pip install stdout:", stdout)
          reject(new Error(`pip install failed with code ${code}: ${stderr}`))
        }
      })

      pipProcess.on("error", (error) => {
        reject(new Error(`Failed to run pip install: ${error.message}`))
      })
    })
  }

  // copy requirements.txt to runtime directory for potential runtime installation
  async copyRequirements(runtimePath) {
    const requirementsFile = path.join(
      __dirname,
      "..",
      "python",
      "requirements.txt"
    )
    const targetFile = path.join(runtimePath, "requirements.txt")

    if (await this.fileExists(requirementsFile)) {
      await fs.copyFile(requirementsFile, targetFile)
      console.log("copied requirements.txt to runtime directory")
    }
  }

  // optimize python runtime by removing unnecessary files
  async optimizeRuntime(runtimePath, _platform) {
    console.log("optimizing python runtime...")

    try {
      const directories = await fs.readdir(runtimePath, { withFileTypes: true })

      for (const dir of directories) {
        if (dir.isDirectory()) {
          const dirPath = path.join(runtimePath, dir.name)

          // remove common unnecessary directories
          if (
            ["test", "tests", "doc", "docs", "__pycache__"].includes(dir.name)
          ) {
            await fs.rm(dirPath, { recursive: true, force: true })
            console.log(`removed ${dir.name}`)
          }
        }
      }

      // clean up .pyc files
      await this.cleanPycFiles(runtimePath)

      console.log("runtime optimization completed")
    } catch (error) {
      console.warn("runtime optimization failed:", error.message)
      // don't fail the build for optimization errors
    }
  }

  // clean up .pyc files recursively
  async cleanPycFiles(dirPath) {
    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true })

      for (const item of items) {
        const fullPath = path.join(dirPath, item.name)

        if (item.isDirectory()) {
          // recurse into directories
          await this.cleanPycFiles(fullPath)

          // remove __pycache__ directories
          if (item.name === "__pycache__") {
            await fs.rm(fullPath, { recursive: true, force: true })
          }
        } else if (item.name.endsWith(".pyc") || item.name.endsWith(".pyo")) {
          // remove compiled python files
          await fs.unlink(fullPath)
        }
      }
    } catch (error) {
      // ignore errors during cleanup
    }
  }

  // get python executable path for specific platform
  getPythonExecutable(platform, runtimePath) {
    if (platform.startsWith("win32")) {
      return path.join(runtimePath, "python.exe")
    } else {
      return path.join(runtimePath, "bin", "python3")
    }
  }

  // check if file exists
  async fileExists(filePath) {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  // format bytes for display
  formatBytes(bytes) {
    if (bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }

  // clean up cache files (for ci optimization)
  async cleanup() {
    if (process.env.CI) {
      console.log("cleaning up cache files...")
      await fs.rm(this.cacheDir, { recursive: true, force: true })
      console.log("cache cleanup completed")
    }
  }
}

// main execution
async function main() {
  const setup = new PythonRuntimeSetup()

  try {
    await setup.setup()

    if (process.env.CLEANUP_CACHE) {
      await setup.cleanup()
    }

    console.log("\npython runtime setup completed successfully")
    console.log("runtime location:", setup.runtimeDir)

    // show directory size
    const { spawn } = require("child_process")
    if (process.platform !== "win32") {
      spawn("du", ["-sh", setup.runtimeDir], { stdio: "inherit" })
    }
  } catch (error) {
    console.error("\nsetup failed:", error.message)
    process.exit(1)
  }
}

// run if called directly
if (require.main === module) {
  main()
}

module.exports = PythonRuntimeSetup
