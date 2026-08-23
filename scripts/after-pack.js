// post-build script: makes the bundled native payload runnable in the package
// - macOS: thin the yt-dlp engine to the target arch, chmod + ad-hoc codesign
//   every mach-o in it, then audit the result strictly
// - linux: chmod the engine and the other bundled binaries
// - windows: presence check only; PE files need no post-processing
//
// work here is split into two classes, and the difference is deliberate:
//
//   required - anything the packaged app cannot run without. a failure throws,
//              electron-builder exits nonzero, and no artifact is produced.
//   optional - genuinely absent inputs (an ffprobe we do not always ship).
//              missing is fine; present-but-broken is not.
//
// this file used to swallow every error on the grounds that it only did
// best-effort chmod. it now performs required transforms, so a swallowed
// failure would ship an installable DMG whose engine cannot load under the
// hardened runtime - a fault that only shows up on the user's machine.

const fs = require("fs").promises
const os = require("os")
const path = require("path")
const { spawn } = require("child_process")

// the same resolver the app uses at runtime, so the check here and the lookup
// there can never disagree about what counts as a usable engine
const { resolveExecutableIn } = require("../src/main/services/ytdlp-engine")

const ENGINE_SEGMENTS = ["binaries", "ytdlp"]

// electron-builder's Arch enum -> the name lipo knows it by
const LIPO_ARCHS = { 0: "i386", 1: "x86_64", 2: "armv7", 3: "arm64" }

// the one arch that legitimately keeps every slice
const ARCH_UNIVERSAL = 4

/**
 * what has to be in the package for the app to work, per platform
 *
 * required: the app cannot do its job without it. ffmpeg merges the video and
 * audio streams and performs every trim and audio conversion; deno answers
 * youtube's javascript challenges. a package missing either installs happily
 * and then fails the moment the user asks for anything.
 *
 * optional: genuinely not always shipped. ffprobe is not in any platform's
 * extraResources today - it is listed so that a build which does start
 * bundling it gets chmod'd and signed rather than silently skipped.
 */
const REQUIRED_BINARIES = {
  darwin: [
    { label: "ffmpeg", segments: ["ffmpeg"] },
    { label: "deno", segments: ["deno", "deno"] }
  ],
  win32: [
    { label: "ffmpeg", segments: ["ffmpeg.exe"] },
    { label: "deno", segments: ["deno", "deno.exe"] }
  ],
  linux: [
    { label: "ffmpeg", segments: ["ffmpeg"] },
    { label: "deno", segments: ["deno", "deno"] }
  ]
}

const OPTIONAL_BINARIES = {
  darwin: [{ label: "ffprobe", segments: ["ffprobe"] }],
  win32: [{ label: "ffprobe", segments: ["ffprobe.exe"] }],
  linux: [{ label: "ffprobe", segments: ["ffprobe"] }]
}

// mach-o magic numbers, including the fat/universal wrappers
const MACH_O_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca
])

// every external command goes through here so tests can inject a fake
const realTools = {
  run: runCommand,
  output: runCommandOutput
}

async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context

  console.log(`running after-pack for platform: ${electronPlatformName}`)
  console.log(`app output directory: ${appOutDir}`)

  switch (electronPlatformName) {
    case "darwin":
      await prepareMacOS(appOutDir, packager, context.arch)
      break
    case "win32":
      await prepareWindows(appOutDir)
      break
    case "linux":
      await prepareLinux(appOutDir)
      break
    default:
      console.log(`no after-pack work for ${electronPlatformName}`)
  }

  console.log("after-pack completed")
}

async function prepareMacOS(appOutDir, packager, arch, tools = realTools) {
  console.log("preparing macOS payload...")

  const appPath = path.join(
    appOutDir,
    `${packager.appInfo.productFilename}.app`
  )
  const resourcesPath = path.join(appPath, "Contents", "Resources")
  const binariesPath = path.join(resourcesPath, "binaries")

  const helpers = await collectBinaries(binariesPath, "darwin")

  for (const binary of helpers) {
    // an unsigned helper cannot be exec'd by a hardened-runtime parent, so a
    // failure on a binary that is present must stop the build
    await chmodExec(binary)
    await adhocSign(binary, tools)
  }

  const engineDir = await requireEngineDir(resourcesPath)
  const executable = await requireEngineExecutable(engineDir, "darwin")

  // the entry point is the one file that absolutely must be signed and thinned
  // like the rest of the engine, so prove it is in scope for those passes
  if (!(await isMachO(executable))) {
    throw new Error(`the yt-dlp entry point ${executable} is not a mach-o executable`)
  }

  // order matters: thinning rewrites the file, which drops any signature it
  // carried, so the slices go first and the signing pass runs over the result
  const target = await thinYtdlpEngine(engineDir, arch, tools)
  await signYtdlpEngine(engineDir, tools)
  await auditYtdlpEngine(engineDir, target, tools)

  // ffmpeg and deno are signed above like the engine is, but were never put
  // through the same strict re-check - a signature adhocSign() only warned
  // about, or a helper that is the wrong architecture for this build, could
  // otherwise ship. ffmpeg and deno are not universal like the engine
  // (cliply's mac build has only ever shipped them arm64-only), so this is a
  // proof they already meet the same bar the engine does, not a second thin
  await auditFiles(helpers, target, tools)
}

async function prepareWindows(appOutDir) {
  console.log("preparing windows payload...")

  const resourcesPath = path.join(appOutDir, "resources")

  // PE files need no executable bit and electron-builder owns any signing, but
  // the payload still has to be complete and actually runnable
  await collectBinaries(path.join(resourcesPath, "binaries"), "win32")

  const engineDir = await requireEngineDir(resourcesPath)
  await requireEngineExecutable(engineDir, "win32")
}

async function prepareLinux(appOutDir) {
  console.log("preparing linux payload...")

  const resourcesPath = path.join(appOutDir, "resources")

  for (const binary of await collectBinaries(
    path.join(resourcesPath, "binaries"),
    "linux"
  )) {
    await chmodExec(binary)
  }

  const engineDir = await requireEngineDir(resourcesPath)
  const executable = await requireEngineExecutable(engineDir, "linux")

  // the _internal/ payload is dlopen'd rather than exec'd, so only the entry
  // point needs the bit
  await chmodExec(executable)
}

/**
 * check the bundled helper binaries and hand back the ones that are there
 *
 * a missing *required* binary is a broken release, not a warning: the app
 * installs, launches, and then fails every merge, trim or conversion. this
 * caught a real DMG during ticket-4 development that shipped with neither
 * ffmpeg nor deno because the dev tree had never fetched them.
 *
 * @param {string} binariesPath - resources/binaries
 * @param {string} platform - node platform key
 * @returns {Promise<string[]>} absolute paths of the binaries present
 */
async function collectBinaries(binariesPath, platform) {
  const present = []
  const missing = []

  for (const entry of REQUIRED_BINARIES[platform] || []) {
    const binary = path.join(binariesPath, ...entry.segments)

    if (await fileExists(binary)) {
      present.push(binary)
    } else {
      missing.push(`${entry.label} (expected at ${path.join(...entry.segments)})`)
    }
  }

  if (missing.length) {
    throw new Error(
      `the ${platform} package is missing required binaries: ${missing.join(", ")}`
    )
  }

  for (const entry of OPTIONAL_BINARIES[platform] || []) {
    const binary = path.join(binariesPath, ...entry.segments)

    if (await fileExists(binary)) {
      present.push(binary)
    } else {
      console.log(`optional ${entry.label} is not bundled - skipping`)
    }
  }

  return present
}

/**
 * the packaged engine, or a hard failure
 *
 * every platform maps the onedir into resources/binaries/ytdlp. an absent one
 * means fetch:ytdlp did not run (or extraResources drifted), and shipping that
 * silently is exactly the "packaged builds have no engine" hazard this
 * migration set out to close.
 *
 * @param {string} resourcesPath - the package's resources directory
 * @returns {Promise<string>} the engine directory
 */
async function requireEngineDir(resourcesPath) {
  const engineDir = path.join(resourcesPath, ...ENGINE_SEGMENTS)

  if (!(await directoryExists(engineDir))) {
    throw new Error(
      `no yt-dlp engine at ${engineDir} - run "npm run fetch:ytdlp" before packaging`
    )
  }

  return engineDir
}

/**
 * the engine's entry point, resolved exactly the way the app will resolve it
 *
 * a directory that merely exists is not an engine. without this, an empty
 * ytdlp/ - or one holding only its _internal/ payload - passes packaging and
 * then fails at runtime with BINARY_MISSING on the user's machine.
 *
 * @param {string} engineDir - resources/binaries/ytdlp
 * @param {string} platform - node platform key the package targets
 * @returns {Promise<string>} the executable to run
 */
async function requireEngineExecutable(engineDir, platform) {
  const executable = resolveExecutableIn(engineDir, platform)

  if (!executable) {
    throw new Error(
      `no runnable yt-dlp executable in ${engineDir} for ${platform} - ` +
        `the engine directory is present but has no entry point`
    )
  }

  return executable
}

/**
 * drop the slices this build will never run
 *
 * the official yt-dlp onedir ships every mach-o as universal x86_64+arm64 -
 * 107 files, ~122 MB, half of it dead weight for a build that targets one
 * arch. cliply's mac builds are arm64-only (the app hard-exits on Intel), so
 * the x86_64 half is pure installer bloat. measured 124 MB -> 66 MB unpacked.
 *
 * note this only thins the copy inside the installer: the updater downloads
 * the universal zip from github, so the first self-update restores the fat
 * engine in userData. the win is installer size, not steady-state disk.
 *
 * every arch decision here is a hard gate. a file we cannot inspect, a single
 * slice that is the *wrong* arch, or a fat file with no target slice all mean
 * the package would carry code this build cannot load - which is a broken
 * release, not something to warn about and continue past.
 *
 * @param {string} engineDir - resources/binaries/ytdlp
 * @param {number} arch - electron-builder Arch enum for this build
 * @param {Object} tools - command runner (injected by tests)
 * @returns {Promise<string|null>} the target arch, or null when left universal
 */
async function thinYtdlpEngine(engineDir, arch, tools = realTools) {
  const target = resolveTargetArch(arch)

  if (!target) {
    console.log("universal build - leaving every slice in the engine")
    return null
  }

  let thinned = 0
  let saved = 0

  for (const file of await listFiles(engineDir)) {
    if (!(await isMachO(file))) continue

    const label = path.relative(engineDir, file)
    const slices = await lipoArchs(file, tools)

    if (slices.length === 1) {
      // already thin - but only acceptable if it is thin to the *right* arch.
      // an x86_64-only dylib in an arm64 build cannot be loaded at runtime.
      if (slices[0] !== target) {
        throw new Error(
          `${label} is ${slices[0]}-only in a ${target} build - it cannot load`
        )
      }

      continue
    }

    if (!slices.includes(target)) {
      throw new Error(
        `${label} has no ${target} slice (found ${slices.join(", ")})`
      )
    }

    const before = (await fs.stat(file)).size
    const scratch = `${file}.${target}`

    try {
      await tools.run("lipo", ["-thin", target, file, "-output", scratch])
      await fs.rename(scratch, file)
    } catch (error) {
      await fs.rm(scratch, { force: true }).catch(() => {})
      throw new Error(`could not thin ${label} to ${target}: ${error.message}`)
    }

    // trust the output, not the intent: confirm what actually landed on disk
    const after = await lipoArchs(file, tools)

    if (after.length !== 1 || after[0] !== target) {
      throw new Error(
        `${label} is ${after.join(", ") || "unreadable"} after thinning, expected ${target}`
      )
    }

    thinned++
    saved += before - (await fs.stat(file)).size
  }

  console.log(
    `thinned ${thinned} file(s) in the yt-dlp engine to ${target}, ` +
      `saving ${(saved / 1048576).toFixed(1)} MB`
  )

  return target
}

/**
 * the arch this build must end up thin to, or null for a universal build
 *
 * only the universal enum may skip thinning. an unrecognised value used to
 * take the same path, which silently turned off both the thinning and the
 * arch half of the final audit - the exact invariant this file exists to
 * enforce - for any target electron-builder grows in future.
 *
 * @param {number} arch - electron-builder Arch enum
 * @returns {string|null} lipo arch name, or null when every slice stays
 */
function resolveTargetArch(arch) {
  if (arch === ARCH_UNIVERSAL) {
    return null
  }

  const target = LIPO_ARCHS[arch]

  if (!target) {
    throw new Error(
      `unrecognised target architecture ${arch} - refusing to skip thinning ` +
        `and the architecture audit for a target this script does not know`
    )
  }

  return target
}

/**
 * which architectures a mach-o carries
 *
 * an unreadable file is a failure, never an empty list: treating "lipo could
 * not tell us" as "nothing to do" is how a wrong-arch binary slips through.
 *
 * @param {string} filePath - the mach-o to inspect
 * @param {Object} tools - command runner (injected by tests)
 * @returns {Promise<string[]>} slice names
 */
async function lipoArchs(filePath, tools = realTools) {
  let out

  try {
    out = await tools.output("lipo", ["-archs", filePath])
  } catch (error) {
    throw new Error(`could not read the architectures of ${filePath}: ${error.message}`)
  }

  const slices = out.trim().split(/\s+/).filter(Boolean)

  if (slices.length === 0) {
    throw new Error(`lipo reported no architectures for ${filePath}`)
  }

  return slices
}

/**
 * the yt-dlp onedir engine is a directory, not a single blob: the executable
 * sits next to an _internal/ tree of its own .so/.dylib files, and macOS
 * refuses to load an unsigned dylib into a process our hardened-runtime app
 * spawned. so every mach-o inside gets ad-hoc signed, deepest first - a dylib
 * signed after its container invalidates the container's signature.
 *
 * @param {string} engineDir - resources/binaries/ytdlp
 * @param {Object} tools - command runner (injected by tests)
 */
async function signYtdlpEngine(engineDir, tools = realTools) {
  const machO = []

  for (const file of await listFiles(engineDir)) {
    if (await isMachO(file)) {
      machO.push(file)
    }
  }

  if (machO.length === 0) {
    throw new Error(`no mach-o files found in ${engineDir} - the engine looks empty`)
  }

  // deepest path first, so a nested dylib is never signed after its parent
  machO.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)

  for (const file of machO) {
    await chmodExec(file)
    await adhocSign(file, tools)
  }

  console.log(`ad-hoc signed ${machO.length} mach-o file(s) in the yt-dlp engine`)
}

/**
 * one file's share of the audit: exact arch match (when a target is given)
 * plus a signature that actually verifies. failures are pushed as labelled
 * strings rather than thrown, so a caller can report every problem in the
 * package at once instead of stopping at the first
 *
 * @param {string} file - the mach-o to check
 * @param {string} label - how to name it in a problem line
 * @param {string|null} target - expected arch, or null to skip that check
 * @param {Object} tools - command runner (injected by tests)
 * @param {string[]} problems - collected failure lines, appended in place
 */
async function checkMachOFile(file, label, target, tools, problems) {
  if (target) {
    try {
      const slices = await lipoArchs(file, tools)

      if (slices.length !== 1 || slices[0] !== target) {
        problems.push(`${label}: is ${slices.join(", ")}, expected exactly ${target}`)
      }
    } catch (error) {
      problems.push(`${label}: ${error.message}`)
    }
  }

  try {
    await verifySignature(file, tools)
  } catch (error) {
    problems.push(`${label}: ${error.message}`)
  }
}

/**
 * final gate: prove the engine on disk is what we meant to ship
 *
 * the per-file steps above each check their own work, but this pass exists to
 * catch anything they never touched - a straggler added by a future upstream
 * layout change, a file whose signature a later step invalidated. it runs on
 * the actual packaged bytes, immediately before electron-builder seals them.
 *
 * @param {string} engineDir - resources/binaries/ytdlp
 * @param {string|null} target - expected arch, or null for a universal build
 * @param {Object} tools - command runner (injected by tests)
 */
async function auditYtdlpEngine(engineDir, target, tools = realTools) {
  const problems = []
  let audited = 0

  for (const file of await listFiles(engineDir)) {
    if (!(await isMachO(file))) continue

    audited++
    await checkMachOFile(file, path.relative(engineDir, file), target, tools, problems)
  }

  if (problems.length) {
    throw new Error(
      `yt-dlp engine audit failed for ${problems.length} of ${audited} file(s):\n  ` +
        problems.join("\n  ")
    )
  }

  console.log(`audited ${audited} mach-o file(s) in the yt-dlp engine - all signed and ${target || "universal"}`)
}

/**
 * the same strict check as auditYtdlpEngine, for an explicit list of files
 * rather than a directory - the helper binaries (ffmpeg, deno) live beside
 * the engine, not inside it, and adhocSign() alone only warns rather than
 * proving the result actually verifies
 *
 * @param {string[]} files - the mach-o files to check
 * @param {string|null} target - expected arch, or null to skip that check
 * @param {Object} tools - command runner (injected by tests)
 */
async function auditFiles(files, target, tools = realTools) {
  const problems = []

  for (const file of files) {
    await checkMachOFile(file, path.basename(file), target, tools, problems)
  }

  if (problems.length) {
    throw new Error(
      `helper binary audit failed for ${problems.length} of ${files.length} file(s):\n  ` +
        problems.join("\n  ")
    )
  }

  if (files.length) {
    console.log(`audited ${files.length} helper binary(ies) - all signed and ${target || "universal"}`)
  }
}

// a signature codesign will actually accept, checked the same two ways we sign
async function verifySignature(filePath, tools = realTools) {
  try {
    await tools.run("codesign", ["--verify", "--strict", filePath])
    return
  } catch (directError) {
    try {
      await withNeutralCopy(filePath, async (scratch) => {
        await tools.run("codesign", ["--verify", "--strict", scratch])
      })
      return
    } catch (scratchError) {
      throw new Error(`signature does not verify (${scratchError.message})`)
    }
  }
}

async function chmodExec(filePath) {
  try {
    await fs.chmod(filePath, 0o755)
  } catch (error) {
    throw new Error(`chmod failed for ${filePath}: ${error.message}`)
  }
}

async function adhocSign(filePath, tools = realTools) {
  try {
    await tools.run("codesign", ["--force", "--sign", "-", filePath])
    return
  } catch (error) {
    console.warn(
      `direct sign failed for ${path.basename(filePath)} (${error.message}) - retrying out of place`
    )
  }

  await signOutOfPlace(filePath, tools)
}

/**
 * sign a mach-o that codesign refuses to look at where it lies
 *
 * packaging copies the engine with symlinks dereferenced, so
 * `Python.framework/Python` ends up a real file sitting in the position of a
 * bundle's main binary. codesign then tries to resolve the whole framework and
 * bails with "bundle format is ambiguous" - even though the file itself is an
 * ordinary mach-o. signing a copy under a neutral path sidesteps the bundle
 * detection entirely, and the signed bytes move back unchanged.
 *
 * a failure here is fatal: it is the second and last attempt, and an unsigned
 * mach-o inside a hardened-runtime app is a release that cannot run.
 *
 * @param {string} filePath - the mach-o to sign
 * @param {Object} tools - command runner (injected by tests)
 */
async function signOutOfPlace(filePath, tools = realTools) {
  try {
    await withNeutralCopy(filePath, async (scratch) => {
      const mode = (await fs.stat(filePath)).mode

      await tools.run("codesign", ["--force", "--sign", "-", scratch])
      await fs.copyFile(scratch, filePath)
      await fs.chmod(filePath, mode)
    })

    console.log(`ad-hoc signed ${path.basename(filePath)} (out of place)`)
  } catch (error) {
    throw new Error(`could not sign ${filePath}: ${error.message}`)
  }
}

/**
 * run something against a copy of the file held outside any bundle layout
 * @param {string} filePath - file to copy
 * @param {Function} work - receives the scratch path
 */
async function withNeutralCopy(filePath, work) {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-sign-"))
  const scratch = path.join(scratchDir, path.basename(filePath))

  try {
    await fs.copyFile(filePath, scratch)
    return await work(scratch)
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const full = path.join(directory, entry.name)

    // symlinks are left alone: signing one signs its target twice
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }

  return files
}

async function isMachO(filePath) {
  let handle

  try {
    handle = await fs.open(filePath, "r")
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0)

    return bytesRead === 4 && MACH_O_MAGIC.has(buffer.readUInt32BE(0))
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
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

// same, but hands back stdout instead of letting it through to the build log
function runCommandOutput(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (chunk) => (stdout += chunk))
    proc.stderr.on("data", (chunk) => (stderr += chunk))

    proc.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`))
    )
    proc.on("error", reject)
  })
}

async function fileExists(filePath) {
  try {
    const stats = await fs.stat(filePath)
    return stats.isFile()
  } catch {
    return false
  }
}

async function directoryExists(dirPath) {
  try {
    const stats = await fs.stat(dirPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

module.exports = afterPack

// exported for tests - the packaging hook itself is the default export
Object.assign(module.exports, {
  prepareMacOS,
  prepareWindows,
  prepareLinux,
  collectBinaries,
  requireEngineDir,
  requireEngineExecutable,
  resolveTargetArch,
  thinYtdlpEngine,
  signYtdlpEngine,
  auditYtdlpEngine,
  auditFiles,
  lipoArchs,
  adhocSign,
  signOutOfPlace,
  isMachO,
  listFiles,
  LIPO_ARCHS
})
