const fs = require("node:fs/promises")
const path = require("node:path")
const { randomBytes } = require("node:crypto")
const { MediaError } = require("./errors")

const key = stat => `${stat.dev}:${stat.ino}`
const local = value => typeof value === "string" && path.isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value) && !value.includes("\0")
async function absent(file) {
  try { await fs.lstat(file) } catch (error) { if (error.code === "ENOENT") return; throw error }
  throw new MediaError("OUTPUT_EXISTS")
}
async function destination(selected, extension) {
  if (!local(selected) || path.extname(selected).toLowerCase() !== `.${extension}`) throw new MediaError("OUTPUT_PATH")
  const selectedParent = path.dirname(selected)
  const parent = await fs.realpath(selectedParent)
  if (!local(parent)) throw new MediaError("OUTPUT_PATH")
  const stat = await fs.stat(parent, { bigint: true })
  if (!stat.isDirectory()) throw new MediaError("OUTPUT_PATH")
  const result = { selectedParent, parent, parentKey: key(stat), final: path.join(parent, path.basename(selected)) }
  await checkDestination(result)
  return result
}
async function checkDestination(record) {
  if (await fs.realpath(record.selectedParent) !== record.parent || key(await fs.stat(record.parent, { bigint: true })) !== record.parentKey) throw new MediaError("OUTPUT_PATH")
  await absent(record.final)
}

// One bounded crash ledger; never a project store or directory scan.
class ExportOutput {
  constructor(storagePath) { this.storagePath = storagePath; this.ledger = storagePath && path.join(storagePath, "partial.json") }
  async write(record) {
    if (!this.ledger) throw new MediaError("OUTPUT_PATH")
    const data = JSON.stringify(record)
    if (Buffer.byteLength(data) > 8192) throw new MediaError("OUTPUT_PATH")
    await fs.mkdir(this.storagePath, { recursive: true, mode: 0o700 })
    if ((await fs.lstat(this.storagePath)).isSymbolicLink()) throw new MediaError("OUTPUT_PATH")
    const next = path.join(this.storagePath, `.${record.token}.tmp`)
    const handle = await fs.open(next, "wx", 0o600)
    try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    try { await fs.rename(next, this.ledger) } catch (error) { await fs.unlink(next).catch(() => {}); throw error }
  }
  async recover() {
    if (!this.ledger) return false
    let stat
    try { stat = await fs.lstat(this.ledger) } catch (error) { if (error.code === "ENOENT") return false; throw error }
    if (!stat.isFile() || stat.size > 8192) throw new MediaError("EXPORT_CLEANUP")
    const record = JSON.parse(await fs.readFile(this.ledger, "utf8"))
    if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.token) || !local(record.parent) ||
        record.directory !== path.join(record.parent, `.cliply-export-${record.token}`) ||
        record.partial !== path.join(record.directory, "audio.partial")) throw new MediaError("EXPORT_CLEANUP")
    await this.clean(record)
    return true
  }
  async create(target) {
    await checkDestination(target)
    const token = randomBytes(32).toString("hex")
    const directory = path.join(target.parent, `.cliply-export-${token}`)
    const record = { version: 1, token, ...target, directory, partial: path.join(directory, "audio.partial"), directoryKey: null, fileKey: null }
    await this.write(record) // intent first; no helper can write before ownership is durable
    let handle
    try {
      await fs.mkdir(directory, { mode: 0o700 })
      record.directoryKey = key(await fs.lstat(directory, { bigint: true }))
      await fs.writeFile(path.join(directory, ".owner"), token, { flag: "wx", mode: 0o600 })
      handle = await fs.open(record.partial, "wx", 0o600)
      record.fileKey = key(await handle.stat({ bigint: true }))
      await this.write(record)
      return { record, handle }
    } catch (error) {
      await handle?.close()
      await this.clean(record).catch(() => {})
      throw error
    }
  }
  async artifact(record, name) {
    if (!/^(?:part-\d{1,2}|concat)\.partial$/.test(name) || Object.keys(record.artifacts || {}).length >= 33) throw new MediaError("OUTPUT_PATH")
    await this.verify(record)
    record.artifacts ||= {}
    if (Object.hasOwn(record.artifacts, name)) throw new MediaError("OUTPUT_PATH")
    record.artifacts[name] = null
    await this.write(record)
    const handle = await fs.open(path.join(record.directory, name), "wx", 0o600)
    try {
      record.artifacts[name] = key(await handle.stat({ bigint: true }))
      await this.write(record)
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  async verify(record) {
    if (await fs.realpath(record.parent) !== record.parent || key(await fs.stat(record.parent, { bigint: true })) !== record.parentKey) throw new MediaError("EXPORT_CLEANUP")
    const dir = await fs.lstat(record.directory, { bigint: true })
    if (!dir.isDirectory() || dir.isSymbolicLink() || key(dir) !== record.directoryKey) throw new MediaError("EXPORT_CLEANUP")
    const owner = path.join(record.directory, ".owner")
    const marker = await fs.lstat(owner)
    if (!marker.isFile() || marker.size !== 64 || await fs.readFile(owner, "utf8") !== record.token) throw new MediaError("EXPORT_CLEANUP")
  }
  async clean(record) {
    // A moved/replaced parent is uncertainty, not proof the partial vanished.
    if (await fs.realpath(record.parent) !== record.parent || key(await fs.stat(record.parent, { bigint: true })) !== record.parentKey) throw new MediaError("EXPORT_CLEANUP")
    let directory
    try { directory = await fs.lstat(record.directory, { bigint: true }) } catch (error) {
      if (error.code !== "ENOENT") throw error
      await fs.unlink(this.ledger).catch(error => { if (error.code !== "ENOENT") throw error })
      return
    }
    if (!directory.isDirectory() || directory.isSymbolicLink() || key(directory) !== record.directoryKey) throw new MediaError("EXPORT_CLEANUP")
    // A crash can happen after unlinking .owner but before rmdir. The durable
    // directory identity plus emptiness is enough to finish that last step;
    // a replacement directory or any remaining content still needs its marker.
    if ((await fs.readdir(record.directory)).length === 0) {
      await fs.rmdir(record.directory)
      await fs.unlink(this.ledger)
      return
    }
    await this.verify(record)
    const artifacts = record.artifacts || {}
    if (typeof artifacts !== "object" || Array.isArray(artifacts) || Object.keys(artifacts).length > 33 ||
        Object.keys(artifacts).some(name => !/^(?:part-\d{1,2}|concat)\.partial$/.test(name))) throw new MediaError("EXPORT_CLEANUP")
    if ((await fs.readdir(record.directory)).some(name => ![".owner", "audio.partial", ...Object.keys(artifacts)].includes(name))) throw new MediaError("EXPORT_CLEANUP")
    for (const [name, identity] of Object.entries(artifacts)) {
      const file = path.join(record.directory, name)
      try {
        const stat = await fs.lstat(file, { bigint: true })
        if (!stat.isFile() || stat.isSymbolicLink() || key(stat) !== identity) throw new MediaError("EXPORT_CLEANUP")
        await fs.unlink(file)
      } catch (error) { if (error.code !== "ENOENT") throw error }
    }
    try {
      const stat = await fs.lstat(record.partial, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || key(stat) !== record.fileKey) throw new MediaError("EXPORT_CLEANUP")
      await fs.unlink(record.partial)
    } catch (error) { if (error.code !== "ENOENT") throw error }
    await fs.unlink(path.join(record.directory, ".owner"))
    await fs.rmdir(record.directory)
    await fs.unlink(this.ledger)
  }
  async publish(record) {
    await this.verify(record)
    await checkDestination(record)
    const stat = await fs.lstat(record.partial, { bigint: true })
    if (!stat.isFile() || key(stat) !== record.fileKey) throw new MediaError("OUTPUT_INVALID")
    // Hard-link creation is atomic and fails if any destination already exists.
    // Never fall back to rename/copy-overwrite on unsupported filesystems.
    await fs.link(record.partial, record.final)
  }
}

module.exports = { ExportOutput, destination, checkDestination, key }
