/**
 * where the engine, its payloads and its executables live on each platform
 */

const fs = require("fs")
const path = require("path")

// the official builds are pyinstaller *onedir* bundles: a directory holding
// the executable next to its _internal/ payload. the onefile builds cost
// 43-108 s per invocation on macos (they re-extract ~50 mb every run), which is
// why the engine lives in a directory now
const ENGINE_DIR_NAME = "ytdlp"

// the PO token payload sits beside the engine rather than inside it: the
// updater replaces the engine directory wholesale on every upgrade, and
// upstream's archives carry no plugins, so anything kept in there is deleted
// the next time yt-dlp updates itself
const POT_DIR_NAME = "pot"

// the executable keeps the release asset's own name, and that name differs per
// platform and per arch - never assume one
const EXECUTABLE_NAMES = {
  darwin: ["yt-dlp_macos", "yt-dlp"],
  win32: ["yt-dlp.exe", "yt-dlp_x86.exe", "yt-dlp_arm64.exe"],
  linux: [
    "yt-dlp_linux",
    "yt-dlp_linux_aarch64",
    "yt-dlp_musllinux",
    "yt-dlp_musllinux_aarch64",
    "yt-dlp"
  ]
}

const PLATFORM_DIRS = {
  darwin: "macos",
  win32: "windows",
  linux: "linux"
}

/**
 * executable names to look for inside an unpacked engine, best first
 * @param {string} platform - process.platform override
 * @returns {string[]} candidate file names
 */
function executableCandidates(platform = process.platform) {
  return EXECUTABLE_NAMES[platform] || EXECUTABLE_NAMES.linux
}

/**
 * find the yt-dlp executable inside an unpacked onedir engine
 * @param {string} directory - engine directory
 * @param {string} platform - process.platform override (the build script
 *   unpacks engines for platforms it is not running on)
 * @returns {string|null} absolute path, or null when the directory holds none
 */
function resolveExecutableIn(directory, platform = process.platform) {
  if (!directory) {
    return null
  }

  for (const name of executableCandidates(platform)) {
    const candidate = path.join(directory, name)
    if (fileExists(candidate)) {
      return candidate
    }
  }

  return null
}

/**
 * where an executable *would* live - for messages and for paths we are about
 * to create
 * @param {string} directory - engine directory
 * @returns {string} absolute path
 */
function nominalExecutableIn(directory) {
  return path.join(directory, executableCandidates()[0])
}

/**
 * the single self-extracting file older builds installed in userData/engine
 * @param {string} platform - process.platform override
 * @returns {string} file name
 */
function legacyBinaryName(platform = process.platform) {
  return platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
}

function fileExists(filePath) {
  try {
    return Boolean(filePath) && fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function directoryExists(dirPath) {
  try {
    return Boolean(dirPath) && fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

// electron is absent in unit tests and build scripts
function electronPath(name) {
  try {
    const { app } = require("electron")
    return app && typeof app.getPath === "function" ? app.getPath(name) : null
  } catch {
    return null
  }
}

module.exports = {
  ENGINE_DIR_NAME,
  POT_DIR_NAME,
  PLATFORM_DIRS,
  executableCandidates,
  resolveExecutableIn,
  nominalExecutableIn,
  legacyBinaryName,
  fileExists,
  directoryExists,
  electronPath
}
