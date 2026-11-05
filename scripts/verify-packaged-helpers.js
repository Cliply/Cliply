// Execute the helpers from the package, not the developer's PATH or repo copy.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { parseArgs } = require("node:util")
const { resolveExecutableIn } = require("../src/main/services/ytdlp-engine")
const { verifyArchitecture, ffprobeRelease } = require("./fetch-helpers")
const { verifyInstalledNotices } = require("./ffprobe-notices")

async function verifyPackagedHelpers(resources, { requireFfprobe = false, requireFfprobeNotices = false } = {}) {
  const platform = `${process.platform}-${process.arch}`
  requireFfprobe ||= process.env.CLIPLY_REQUIRE_FFPROBE === "1" || Boolean(ffprobeRelease(platform))
  const binaries = path.resolve(resources, "binaries")
  const suffix = process.platform === "win32" ? ".exe" : ""
  const engine = resolveExecutableIn(path.join(binaries, "ytdlp"))
  assert.ok(engine, "packaged yt-dlp executable is present")
  const ffprobe = path.join(binaries, `ffprobe${suffix}`)
  if (requireFfprobe) assert.ok(fs.existsSync(ffprobe), "packaged FFprobe is required for local media capability")
  verifyInstalledNotices(resources, platform, { required: requireFfprobeNotices })
  for (const [binary, args] of [
    ...(fs.existsSync(ffprobe) ? [[ffprobe, ["-version"]]] : []),
    [path.join(binaries, `ffmpeg${suffix}`), ["-version"]],
    [path.join(binaries, "deno", `deno${suffix}`), ["--version"]],
    [engine, ["--version"]]
  ]) {
    await verifyArchitecture(binary, platform)
    if (process.platform !== "win32") assert.ok(fs.statSync(binary).mode & 0o111, `${binary} is executable`)
    const result = spawnSync(binary, args, { stdio: "inherit", timeout: 30000, windowsHide: true })
    assert.equal(result.status, 0, result.error?.message || `${binary} exited ${result.status}`)
    if (process.platform === "linux") {
      const dependencies = spawnSync("ldd", [binary], { encoding: "utf8", timeout: 30000 })
      if (dependencies.error) throw dependencies.error
      const listing = `${dependencies.stdout}${dependencies.stderr}`
      assert.doesNotMatch(listing, /\S+\s+=>\s+not found/, `${binary} has missing libraries`)
      assert.ok(dependencies.status === 0 || /not a dynamic executable|statically linked/.test(listing), listing)
    }
  }
  console.log(`packaged ${platform} helpers passed`)
}

if (require.main === module) {
  const { values } = parseArgs({ options: { resources: { type: "string" }, "require-ffprobe": { type: "boolean", default: false }, "require-ffprobe-notices": { type: "boolean", default: false } } })
  if (!values.resources) throw new Error("Pass --resources <packaged resources directory>")
  verifyPackagedHelpers(values.resources, { requireFfprobe: values["require-ffprobe"], requireFfprobeNotices: values["require-ffprobe-notices"] }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { verifyPackagedHelpers }
