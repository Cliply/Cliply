// Check real builder manifests against exactly the files a release will attach.
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const yaml = require("js-yaml")

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(file) : entry.isFile() ? [file] : []
  })
}

async function verifyReleaseArtifacts(directory) {
  const files = listFiles(directory)
  const byName = new Map()
  for (const file of files) {
    const name = path.basename(file)
    if (byName.has(name)) throw new Error(`Duplicate release attachment: ${name}`)
    byName.set(name, file)
  }
  for (const name of ["latest.yml", "latest-mac.yml", "latest-linux.yml"]) {
    const manifestFile = byName.get(name)
    if (!manifestFile) throw new Error(`Missing release manifest: ${name}`)
    const manifest = yaml.load(fs.readFileSync(manifestFile, "utf8"))
    if (!manifest?.version || !Array.isArray(manifest.files) || !manifest.files.length) {
      throw new Error(`${name} is not real update metadata`)
    }
    if (manifest.version !== require("../package.json").version) throw new Error(`${name} has a different app version`)
    for (const entry of manifest.files) {
      if (typeof entry.url !== "string" || !entry.sha512) throw new Error(`${name} has an incomplete artifact entry`)
      const filename = decodeURIComponent(entry.url)
      if (filename !== path.basename(filename)) throw new Error(`${name} references a nonlocal attachment: ${filename}`)
      const file = byName.get(filename)
      if (!file) throw new Error(`${name} references a missing attachment: ${filename}`)
      if (entry.size != null && entry.size !== fs.statSync(file).size) throw new Error(`${filename} size differs from manifest`)
      const hash = crypto.createHash("sha512")
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
      const digest = hash.digest("base64")
      if (digest !== entry.sha512) throw new Error(`${filename} SHA512 differs from manifest`)
    }
    if (manifest.path && !byName.has(decodeURIComponent(manifest.path))) throw new Error(`${name} path is missing`)
  }
  for (const extension of [".dmg", ".zip", ".exe", ".AppImage", ".deb"]) {
    if (!files.some((file) => file.endsWith(extension))) throw new Error(`Missing release installer: ${extension}`)
  }
  console.log("release manifests match the attached installers")
}

if (require.main === module) {
  const run = async () => {
    if (!process.argv[2]) throw new Error("Pass the aggregated release artifacts directory")
    await verifyReleaseArtifacts(path.resolve(process.argv[2]))
  }
  run().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { verifyReleaseArtifacts }
