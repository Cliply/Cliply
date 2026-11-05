const { spawn } = require("node:child_process")
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { randomUUID } = require("node:crypto")
const { MediaError } = require("./errors")
const { compatibilityArgs } = require("./losslesscut-preview")

// LosslessCut's pull-based FFmpeg stream, transported over the existing narrow
// IPC rather than @electron/remote. Reads exert backpressure on FFmpeg stdout.
class CompatibilityPlayer {
  constructor({ getSource, validate, resolveFfmpeg, isFrozen }) {
    Object.assign(this, { getSource, validate, resolveFfmpeg, isFrozen })
    this.jobs = new Map()
    this.revision = 0
  }
  async source(sourceId) {
    if (this.isFrozen()) throw new MediaError("CLOSED")
    const source = this.getSource()
    if (!source || source.dto.sourceId !== sourceId) throw new MediaError("SOURCE_UNKNOWN")
    await this.validate(source)
    if (this.isFrozen()) throw new MediaError("CLOSED")
    if (source !== this.getSource()) throw new MediaError("SOURCE_CHANGED")
    return source
  }
  async launch(source, args, input) {
    const executable = await this.resolveFfmpeg()
    if (this.isFrozen() || source !== this.getSource()) throw new MediaError("CANCELLED")
    const child = spawn(process.execPath, [path.join(__dirname, "export-worker.js"), executable, JSON.stringify(args)], {
      shell: false, windowsHide: true, stdio: [input?.fd ?? "ignore", "pipe", "pipe", "ipc"],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT")), ELECTRON_RUN_AS_NODE: "1" }
    })
    const job = { id: randomUUID(), source, child, input, ended: false, reading: false, stderr: "", code: null }
    job.closed = new Promise(resolve => {
      child.once("close", async code => {
        job.ended = true; job.code = code
        await input?.close().catch(() => {})
        resolve()
      })
    })
    child.on("error", () => { job.failed = true })
    child.stderr.on("data", chunk => { job.stderr = (job.stderr + chunk.toString()).slice(-16384) })
    this.jobs.set(job.id, job)
    return job
  }
  async next(job) {
    if (job.reading) throw new MediaError("BUSY")
    job.reading = true
    try {
      return await new Promise((resolve, reject) => {
        const stream = job.child.stdout
        let timer
        const cleanup = () => { clearTimeout(timer); stream.off("readable", read); stream.off("end", end); stream.off("error", fail); job.child.off("close", end) }
        const fail = () => { cleanup(); reject(new MediaError("PREVIEW_UNAVAILABLE")) }
        const end = async () => { cleanup(); await job.closed; if (job.code && !job.cancelled) reject(new MediaError("PREVIEW_UNAVAILABLE")); else resolve(null) }
        const read = () => { const chunk = stream.read(); if (chunk !== null) { cleanup(); resolve(new Uint8Array(chunk)) } else if (job.ended || stream.readableEnded) end() }
        stream.on("readable", read); stream.once("end", end); stream.once("error", fail); job.child.once("close", end)
        timer = setTimeout(fail, 10000)
        read()
      })
    } finally { job.reading = false }
  }
  async start(request, forceColorspace = false) {
    if (!request || Object.keys(request).sort().join(",") !== "seekTo,sourceId" || !Number.isFinite(request.seekTo)) throw new MediaError("REQUEST_INVALID")
    const revision = ++this.revision
    await this.drain(false)
    const source = await this.source(request.sourceId)
    if (request.seekTo < 0 || request.seekTo >= source.dto.duration) throw new MediaError("REQUEST_INVALID")
    const video = source.dto.streams.find(stream => stream.type === "video" && !stream.disposition.attached_pic)
    // Native default playback selects one audio stream; a track mixer is not exposed.
    const audio = source.dto.streams.filter(stream => stream.type === "audio")
    const selectedAudio = audio.find(stream => stream.disposition.default) || audio[0]
    const input = await fs.open(source.identity.realPath, "r")
    const stat = await input.stat({ bigint: true })
    if ([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") !== source.identity.stamp || revision !== this.revision) {
      await input.close(); throw new MediaError("SOURCE_CHANGED")
    }
    const args = compatibilityArgs({ path: "fd:", videoStreamIndex: video?.index,
      audioStreams: selectedAudio ? [{ index: selectedAudio.index, channels: selectedAudio.channels, channelLayout: selectedAudio.channelLayout }] : [],
      seekTo: request.seekTo, size: 800, fps: 30, rotate: undefined, forceColorspace, ffmpegHwaccel: "none" })
    args.splice(args.indexOf("-i"), 0, "-protocol_whitelist", "fd,file,pipe", "-fd", "0")
    let job
    try {
      job = await this.launch(source, args, input)
      if (revision !== this.revision || source !== this.getSource()) throw new MediaError("CANCELLED")
      job.first = await this.next(job)
      if (!job.first) throw new MediaError("PREVIEW_UNAVAILABLE")
      if (revision !== this.revision || source !== this.getSource()) throw new MediaError("CANCELLED")
      return { sessionId: job.id, video: Boolean(video), audio: Boolean(selectedAudio) }
    } catch (error) {
      const retryColorspace = !forceColorspace && revision === this.revision && /Unsupported input/.test(job?.stderr || "")
      if (job) await this.stop(job.id); else await input.close()
      if (retryColorspace) return this.start(request, true)
      throw error
    }
  }
  async read(id) {
    const job = this.jobs.get(id)
    if (!job || job.cancelled) throw new MediaError("PREVIEW_UNAVAILABLE")
    try {
      await this.source(job.source.dto.sourceId)
      if (job.first) { const chunk = job.first; job.first = null; return chunk }
      return await this.next(job)
    }
    catch (error) { await this.stop(id); throw error }
  }
  async stop(id) {
    const job = this.jobs.get(id)
    if (!job) return { stopped: true }
    job.cancelled = true
    if (!job.ended) { try { job.child.send({ cancel: true }, () => {}) } catch { /* wait for drain */ } }
    let timer
    try {
      await Promise.race([job.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new MediaError("EXPORT_STUCK")), 3000) })])
      if (job.directory) await fs.rm(job.directory, { recursive: true, force: true })
      this.jobs.delete(id)
    } finally { clearTimeout(timer) }
    return { stopped: true }
  }
  async drain(invalidate = true) {
    if (invalidate) this.revision += 1
    await Promise.all([...this.jobs.keys()].map(id => this.stop(id)))
  }
  async clock(sourceId) {
    const revision = this.revision
    const source = await this.source(sourceId)
    if (!Number.isFinite(source.dto.duration) || source.dto.duration <= 0 || this.jobs.size) throw new MediaError("BUSY")
    // LosslessCut html5ifyDummy: silent FLAC gives the native master a seekable
    // full-duration clock. Only the compatibility slave displays/hears media.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-preview-clock-"))
    const file = path.join(directory, "clock.flac")
    let job, timeout
    try {
      job = await this.launch(source, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-t", String(source.dto.duration), "-acodec", "flac", "-frame_size", "4608", "-y", file])
      job.directory = directory
      timeout = setTimeout(() => { void this.stop(job.id).catch(() => {}) }, 30000)
      await job.closed
      if (revision !== this.revision || source !== this.getSource() || job.cancelled) throw new MediaError("CANCELLED")
      const stat = await fs.stat(file)
      if (job.code !== 0 || !stat.size || stat.size > 16 * 1024 * 1024) throw new MediaError("PREVIEW_UNAVAILABLE")
      return new Uint8Array(await fs.readFile(file))
    } finally {
      clearTimeout(timeout)
      if (job) await this.stop(job.id)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
module.exports = { CompatibilityPlayer }
