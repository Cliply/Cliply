/**
 * small file helpers - the atomic directory swap the engine and the PO token
 * payload both land through, plus the copy, json markers and version
 * comparison built around it
 */

const fsp = require("fs").promises
const path = require("path")

const { resolveExecutableIn } = require("./paths")

/**
 * put a prepared directory in place of the live one
 *
 * both directories live under the same userData parent, so the renames are
 * same-filesystem and atomic; the old copy is only deleted once the new one is
 * in place, and a failure halfway puts it straight back. nothing ever observes
 * a half-written directory at the live path, which is the whole point - both
 * the engine and the PO token payload are found by looking for files inside
 * one, so a directory that is partly there reads as one that is fully there.
 *
 * @param {string} preparedDir - directory to move in
 * @param {string} installedDir - directory to replace
 * @returns {Promise<void>}
 */
async function swapDirectories(preparedDir, installedDir) {
  const retiredDir = `${installedDir}.retired-${Date.now()}`
  let retired = false

  try {
    // whatever is there goes, directory or not - an older build's onefile
    // could be sitting on this exact path
    if (await pathExists(installedDir)) {
      await fsp.rename(installedDir, retiredDir)
      retired = true
    }

    await fsp.rename(preparedDir, installedDir)
  } catch (error) {
    if (retired) {
      await removeQuietly(installedDir)

      try {
        await fsp.rename(retiredDir, installedDir)
      } catch (restoreError) {
        // the previous engine is still on disk, just not where the engine
        // looks for it. losing that fact here is how a user ends up with no
        // downloader at all, so it travels with the error
        error.retiredDir = retiredDir
        error.restoreError = restoreError.message
      }
    }

    throw error
  }

  await removeQuietly(retiredDir)
}

/**
 * copy a directory tree, preserving permission bits
 * fs.promises.cp would do this in one line, but it still prints an
 * experimental warning on the node electron 28 ships
 * @param {string} source - directory to copy
 * @param {string} destination - directory to create
 * @returns {Promise<void>}
 */
async function copyDirectory(source, destination) {
  await fsp.mkdir(destination, { recursive: true })

  const entries = await fsp.readdir(source, { withFileTypes: true })

  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)

    if (entry.isDirectory()) {
      await copyDirectory(from, to)
      continue
    }

    if (entry.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(from), to)
      continue
    }

    const stats = await fsp.stat(from)
    await fsp.copyFile(from, to)
    await fsp.chmod(to, stats.mode & 0o7777)
  }
}

// the executable bit is the one permission the engine cannot run without
async function makeExecutable(engineDir) {
  const executable = resolveExecutableIn(engineDir)

  if (!executable) {
    return
  }

  await fsp.chmod(executable, 0o755)
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"))
  } catch {
    // absent or unreadable is simply "nothing remembered"
    return null
  }
}

async function writeJson(filePath, value) {
  try {
    await fsp.writeFile(filePath, JSON.stringify(value))
  } catch {
    // a marker we could not write just means we probe again next launch
  }
}

async function pathExists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

function removeQuietly(target) {
  return fsp.rm(target, { recursive: true, force: true }).catch(() => {})
}

/**
 * compare two yt-dlp versions ("2026.08.19", "2026.08.19.232357")
 * @param {string} a - left version
 * @param {string} b - right version
 * @returns {number} 1 when a is newer, -1 when b is newer, 0 when equal
 */
function compareVersions(a, b) {
  const left = versionParts(a)
  const right = versionParts(b)
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index++) {
    const leftPart = left[index] || 0
    const rightPart = right[index] || 0

    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }

  return 0
}

function versionParts(version) {
  return String(version || "")
    .trim()
    .split(/[^\d]+/)
    .filter((part) => part !== "")
    .map((part) => parseInt(part, 10))
}

module.exports = {
  swapDirectories,
  copyDirectory,
  makeExecutable,
  readJson,
  writeJson,
  pathExists,
  removeQuietly,
  compareVersions
}
