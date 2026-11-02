const fs = require("node:fs/promises")
const path = require("node:path")
const { randomUUID } = require("node:crypto")
const { resolveFfprobe } = require("./local-media/paths")
const { startProbe } = require("./local-media/probe")
const { MediaError } = require("./local-media/errors")

async function identify(sourcePath) {
  try {
    if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) ||
        /^(?:\\\\|\/\/)/.test(sourcePath) || sourcePath.includes("\0")) throw new Error()
    const realPath = await fs.realpath(sourcePath)
    if (/^(?:\\\\|\/\/)/.test(realPath)) throw new Error()
    const stat = await fs.stat(realPath, { bigint: true })
    if (!stat.isFile()) throw new Error()
    return {
      realPath,
      // A bounded change detector, not a hash or a claim of tamper resistance.
      stamp: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"),
      bytes: stat.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(stat.size) : null
    }
  } catch {
    throw new MediaError("SOURCE_INVALID")
  }
}

async function assertUnchanged(source) {
  try {
    const now = await identify(source.selectedPath)
    if (now.realPath !== source.identity.realPath || now.stamp !== source.identity.stamp) throw new Error()
  } catch {
    throw new MediaError("SOURCE_CHANGED")
  }
}

function capabilities() {
  const deferred = { status: "unavailable", reason: "NOT_IMPLEMENTED", message: "This operation is not available yet." }
  return {
    probe: { status: "available", reason: null, message: null },
    nativePreview: { status: "unchecked", reason: "PREVIEW_NOT_TESTED", message: "Native preview has not been tested for this source." },
    trim: { ...deferred }, extractAudio: { ...deferred }, removeTracks: { ...deferred }, remux: { ...deferred }
  }
}

class LocalMediaService {
  constructor({ selectFile, resolveProbe = resolveFfprobe, runProbe = startProbe } = {}) {
    this.selectFile = selectFile
    this.resolveProbe = resolveProbe
    this.runProbe = runProbe
    this.source = null
    this.pending = null
    this.frozen = false
  }

  // Only main supplies selectFile. There is no renderer path/argv input.
  open() {
    if (this.frozen) return Promise.reject(new MediaError("CLOSED"))
    if (this.pending) return Promise.reject(new MediaError("BUSY"))
    const job = { cancelled: false, process: null, done: null }
    this.pending = job
    job.done = this.openSelected(job).finally(() => {
      if (job.process && !job.process.ended) {
        // A failed kill must not free the one-probe slot.
        job.process.closed.then(() => { if (this.pending === job) this.pending = null })
      } else if (this.pending === job) this.pending = null
    })
    return job.done
  }

  async openSelected(job) {
    const checkCancelled = () => { if (job.cancelled || this.frozen) throw new MediaError("CANCELLED") }
    const executable = await this.resolveProbe()
    checkCancelled()
    const selectedPath = await this.selectFile()
    checkCancelled()
    if (!selectedPath) return { cancelled: true, source: null }
    const identity = await identify(selectedPath)
    checkCancelled()
    const source = { selectedPath, identity }
    await assertUnchanged(source)
    checkCancelled()
    job.process = this.runProbe(executable, identity.realPath)
    const metadata = await job.process.result
    checkCancelled()
    await assertUnchanged(source)
    checkCancelled()
    source.dto = {
      schemaVersion: 1, sourceId: randomUUID(), filename: path.basename(selectedPath).slice(0, 512),
      bytes: identity.bytes, ...metadata, capabilities: capabilities()
    }
    this.source = source
    return { cancelled: false, source: source.dto }
  }

  async getState() {
    const source = this.source
    if (!source) return { source: null, busy: Boolean(this.pending) }
    try { await assertUnchanged(source) }
    catch (error) {
      if (this.source === source) this.source = null
      throw error
    }
    // A close/replacement during the stat must never resurrect an old DTO.
    if (this.source !== source) return { source: null, busy: Boolean(this.pending) }
    return { source: source.dto, busy: Boolean(this.pending) }
  }

  async close() {
    this.source = null
    const job = this.pending
    if (job) {
      job.cancelled = true
      if (!job.process) return { closed: true }
      job.process.cancel()
      await job.done.catch(() => {})
      if (job.process && !job.process.ended) throw new MediaError("PROBE_STUCK")
    }
    return { closed: true }
  }

  freeze() {
    this.frozen = true
  }

  shutdown() {
    this.freeze()
    return this.close()
  }
}

module.exports = { LocalMediaService, identify, assertUnchanged }
