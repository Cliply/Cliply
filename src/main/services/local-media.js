const fs = require("node:fs/promises")
const path = require("node:path")
const { randomUUID } = require("node:crypto")
const { resolveFfprobe } = require("./local-media/paths")
const { startProbe } = require("./local-media/probe")
const { MediaPreview } = require("./local-media/preview")
const { MediaError } = require("./local-media/errors")
const { LocalExport } = require("./local-media/export")
const { audioProfile, trackRemovalProfile, remuxProfiles } = require("./local-media/export-plan")
const { trimProfile, validateTrimRequest, startPacketProbe, startFrameProbe, timingWindows, planTrimTiming } = require("./local-media/trim-plan")
const { retainedRanges, combineTiming } = require("./local-media/segments")
const { detectContainer } = require("./local-media/container")

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
  constructor({ selectFile, resolveProbe = resolveFfprobe, runProbe = startProbe, runPackets = startPacketProbe, runFrames = startFrameProbe, exportOptions = {} } = {}) {
    this.selectFile = selectFile
    this.resolveProbe = resolveProbe
    this.runProbe = runProbe
    this.runPackets = runPackets
    this.runFrames = runFrames
    this.trimPlan = null
    this.source = null
    this.sourceError = null
    this.pending = null
    this.frozen = false
    this.exports = new LocalExport({ ...exportOptions, getSource: () => this.source,
      getTrimPlan: id => this.getTrimPlan(id), validateTrimPlan: plan => this.getTrimPlan(plan.trimPlanId),
      validateSource: assertUnchanged, isInspecting: () => Boolean(this.pending), resolveProbe })
    this.preview = new MediaPreview({
      getSource: () => this.source, validate: assertUnchanged,
      invalidate: () => { this.source = null; this.sourceError = new MediaError("SOURCE_CHANGED") }
    })
  }

  // Only main supplies selectFile. There is no renderer path/argv input.
  open() {
    if (this.frozen) return Promise.reject(new MediaError("CLOSED"))
    if (this.exports.busy) return Promise.reject(new MediaError("EXPORT_BUSY"))
    if (this.pending) return Promise.reject(new MediaError("BUSY"))
    this.exports.invalidatePlan()
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
    metadata.contentContainer = await detectContainer(metadata, identity.realPath)
    checkCancelled()
    await assertUnchanged(source)
    checkCancelled()
    source.dto = {
      schemaVersion: 1, sourceId: randomUUID(), filename: path.basename(selectedPath).slice(0, 512),
      bytes: identity.bytes, ...metadata, capabilities: capabilities()
    }
    source.dto.extractionProfiles = source.dto.streams.flatMap(stream => {
      const profile = audioProfile(source.dto, stream)
      return profile && (stream.duration ?? source.dto.duration) > 0 ? [{ streamIndex: stream.index, extension: profile.extension }] : []
    })
    source.dto.capabilities.extractAudio = source.dto.extractionProfiles.length
      ? { status: "available", reason: null, message: null }
      : { status: "unavailable", reason: "AUDIO_UNSUPPORTED", message: "Select a verified AAC-LC, MP3 or 16-bit PCM audio track with a known duration." }
    source.dto.trackRemovalProfile = trackRemovalProfile(source.dto)
    source.dto.capabilities.removeTracks = source.dto.trackRemovalProfile && source.dto.streams.some(stream =>
      ["video", "audio"].includes(stream.type) && source.dto.trackRemovalProfile.supportedStreamIndexes.includes(stream.index))
      ? { status: "available", reason: null, message: null }
      : { status: "unavailable", reason: "TRACK_CONTAINER", message: "Track removal needs a verified MP4, MOV or MKV source and playable retained tracks." }
    source.dto.remuxProfiles = remuxProfiles(source.dto)
    source.dto.capabilities.remux = source.dto.remuxProfiles.length
      ? { status: "available", reason: null, message: null }
      : { status: "unavailable", reason: "REMUX_SOURCE", message: "Container changes need a verified MP4, MOV or Matroska source with compatible tracks." }
    try {
      const profile = trimProfile(source.dto)
      source.dto.trimProfile = { extension: profile.extension, hasVideo: profile.hasVideo }
      source.dto.capabilities.trim = { status: "unchecked", reason: "TRIM_PREVIEW", message: "Play this source before planning a fast cut." }
    } catch (error) {
      source.dto.trimProfile = null
      source.dto.capabilities.trim = { status: "unavailable", reason: error.code || "TRIM_PROFILE", message: error.message }
    }
    this.trimPlan = null
    this.preview.revoke()
    this.source = source
    this.sourceError = null
    return { cancelled: false, source: source.dto }
  }

  getTrimPlan(id) {
    const plan = this.trimPlan
    if (!plan || plan.trimPlanId !== id || plan.sourceId !== this.source?.dto.sourceId || Date.now() >= plan.expiresAt) throw new MediaError("PLAN_EXPIRED")
    if (!plan.cuts && !this.preview.hasPlayback(plan.previewId)) throw new MediaError("TRIM_PREVIEW")
    return plan
  }

  inspectTrim(request) {
    if (this.frozen) return Promise.reject(new MediaError("CLOSED"))
    if (this.pending || this.exports.busy) return Promise.reject(new MediaError("BUSY"))
    const source = this.source
    const multi = request && Object.hasOwn(request, "ranges")
    const ranges = multi ? retainedRanges(source?.dto, request) : [request]
    const requests = multi ? ranges.map(range => ({ ...range, sourceId: request.sourceId, mode: request.mode, previewId: "0".repeat(64) })) : ranges
    const profile = validateTrimRequest(source?.dto, requests[0])
    if (!multi && !this.preview.hasPlayback(request.previewId)) return Promise.reject(new MediaError("TRIM_PREVIEW"))
    this.trimPlan = null
    this.exports.invalidatePlan()
    const job = { kind: "trim", cancelled: false, process: null, done: null }
    this.pending = job
    job.done = (async () => {
      const check = () => {
        if (job.cancelled || this.frozen) throw new MediaError("CANCELLED")
        if (source !== this.source) throw new MediaError("SOURCE_CHANGED")
        if (!multi && !this.preview.hasPlayback(request.previewId)) throw new MediaError("TRIM_PREVIEW")
      }
      await assertUnchanged(source); check()
      const executable = await this.resolveProbe(); check()
      const cuts = []
      for (const cutRequest of requests) {
        const packets = []
        for (const { from, to } of timingWindows(source.dto, cutRequest, profile)) {
          check()
          job.process = this.runPackets(executable, source.identity.realPath, profile.streamIndex, from, to)
          packets.push(await job.process.result)
          check()
        }
        await assertUnchanged(source); check()
        const timing = planTrimTiming(source.dto, cutRequest, ...packets)
        if (profile.hasVideo) {
          job.process = this.runFrames(executable, source.identity.realPath, profile.streamIndex, timing.plannedStart)
          const frame = await job.process.result; check()
          if (Math.abs(frame.firstTime - timing.plannedStart) > 0.001) throw new MediaError("TRIM_TIMING")
          await assertUnchanged(source); check()
        }
        cuts.push(timing)
      }
      const timing = multi ? combineTiming(request, cuts) : cuts[0]
      this.trimPlan = { ...timing, trimPlanId: randomUUID(), expiresAt: Date.now() + 5 * 60 * 1000 }
      return this.trimPlan
    })().finally(() => {
      if (job.process && !job.process.ended) job.process.closed.then(() => { if (this.pending === job) this.pending = null })
      else if (this.pending === job) this.pending = null
    })
    return job.done
  }

  async cancelTrim() {
    const job = this.pending
    if (job?.kind !== "trim") return { cancelled: false }
    job.cancelled = true; job.process?.cancel()
    await job.done.catch(() => {})
    if (job.process && !job.process.ended) throw new MediaError("PROBE_STUCK")
    return { cancelled: true }
  }

  async getState() {
    const source = this.source
    if (!source && this.sourceError) throw this.sourceError
    if (!source) return { source: null, busy: Boolean(this.pending) }
    try { await assertUnchanged(source) }
    catch (error) {
      if (this.source === source) { this.source = null; this.preview.revoke() }
      throw error
    }
    // A close/replacement during the stat must never resurrect an old DTO.
    if (this.source !== source) return { source: null, busy: Boolean(this.pending) }
    return { source: source.dto, busy: Boolean(this.pending) }
  }

  async close() {
    await this.exports.drain()
    this.preview.revoke()
    this.source = null
    this.sourceError = null
    this.trimPlan = null
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
    this.exports.freeze()
    this.preview.revoke()
    this.frozen = true
  }

  shutdown() {
    this.freeze()
    return this.close()
  }
}

module.exports = { LocalMediaService, identify, assertUnchanged }
