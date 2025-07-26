// installs python deps to embedded runtime

const { spawn } = require("child_process")
const path = require("path")
const fs = require("fs")

async function installDependencies() {
  const platform = process.platform
  const arch = process.arch

  // get platform-specific runtime path
  let runtimePath
  if (platform === "darwin") {
    runtimePath =
      arch === "arm64"
        ? "python-runtime/darwin-arm64"
        : "python-runtime/darwin-x64"
  } else if (platform === "win32") {
    runtimePath =
      arch === "x64" ? "python-runtime/win32-x64" : "python-runtime/win32-ia32"
  } else {
    runtimePath = "python-runtime/linux-x64"
  }

  const pythonExe =
    platform === "win32"
      ? path.join(runtimePath, "python.exe")
      : path.join(runtimePath, "bin", "python3")

  // check if python runtime exists
  if (!fs.existsSync(pythonExe)) {
    console.log(`python runtime not found: ${pythonExe}`)
    console.log("run: npm run setup:python-runtime")
    process.exit(1)
  }

  console.log(`installing dependencies to: ${pythonExe}`)

  // install packages directly (no --user flag)
  const packages = ["fastapi", "uvicorn", "yt-dlp", "pydantic"]

  for (const pkg of packages) {
    console.log(`installing ${pkg}...`)

    await new Promise((resolve, reject) => {
      const pip = spawn(pythonExe, ["-m", "pip", "install", pkg], {
        stdio: "inherit"
      })

      pip.on("close", (code) => {
        if (code === 0) {
          console.log(`${pkg} installed`)
          resolve()
        } else {
          console.error(`failed to install ${pkg}`)
          reject(new Error(`pip install ${pkg} failed`))
        }
      })
    })
  }

  console.log("all dependencies installed successfully")
}

installDependencies().catch(console.error)
