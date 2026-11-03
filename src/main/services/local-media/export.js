const fs = require("node:fs/promises")
const path = require("node:path")
const { randomUUID } = require("node:crypto")
const { MediaError } = require("./errors")
const { planExport, exportArgs, validateOutput } = require("./export-plan")
const { ExportOutput, destination } = require("./export-output")
const { startExportProcess } = require("./export-process")
const { startProbe } = require("./probe")
const { concatManifest, concatArgs } = require("./join")
const { detectContainer } = require("./container")

const TERMINAL = new Set(["completed", "cancelled", "failed", "interrupted"])
const safeError = error => error instanceof MediaError ? error : new MediaError(
  error?.code === "EEXIST" ? "OUTPUT_EXISTS" : error?.code === "ENOSPC" ? "OUTPUT_SPACE" : "EXPORT_FAILED")

class LocalExport {
  constructor({ getSource, validateSource, isInspecting, selectDestination, resolveFfmpeg, resolveProbe,
    storagePath, revealOutput, getTrimPlan, validateTrimPlan, onUpdate = () => {}, runProcess = startExportProcess, runProbe = startProbe } = {}) {
    Object.assign(this, { getSource, validateSource, isInspecting, selectDestination, resolveFfmpeg, resolveProbe, revealOutput, getTrimPlan, validateTrimPlan, onUpdate, runProcess, runProbe })
    this.output = new ExportOutput(storagePath)
    this.revision = 0; this.plan = null; this.job = null; this.active = null; this.preparing = null; this.frozen = false
    this.ready = this.output.recover().then(interrupted => {
      if (interrupted) { this.job = { jobId: randomUUID(), state: "interrupted", progress: 0, outputName: null, error: "EXPORT_INTERRUPTED" }; this.emit() }
    }).catch(() => { this.recoveryError = "EXPORT_CLEANUP"; this.emit() })
  }
  get busy() { return Boolean(this.active || this.preparing) }
  snapshot() { return { revision: this.revision, preparing: Boolean(this.preparing), plan: this.plan?.summary || null, job: this.job ? { ...this.job } : null, recoveryError: this.recoveryError || null } }
  emit() { this.revision += 1; this.onUpdate(this.snapshot()) }
  update(values) { Object.assign(this.job, values); this.emit() }
  invalidatePlan() { this.plan = null; this.preparing = null; this.emit() }
  async getState() { await this.ready; return this.snapshot() }
  async prepare(request) {
    if (this.frozen) throw new MediaError("CLOSED")
    if (this.busy || this.isInspecting()) throw new MediaError("EXPORT_BUSY")
    const source = this.getSource()
    const profile = planExport(source?.dto, request, request?.operation === "trim" ? this.getTrimPlan?.(request.trimPlanId) : undefined)
    const reservation = {}; this.preparing = reservation; this.plan = null; this.emit()
    const check = () => {
      if (this.frozen || this.preparing !== reservation) throw new MediaError("EXPORT_CANCELLED")
      if (source !== this.getSource()) throw new MediaError("SOURCE_CHANGED")
    }
    try {
      await this.ready; check()
      if (this.recoveryError) {
        try { await this.output.recover(); this.recoveryError = null }
        catch { throw new MediaError("EXPORT_CLEANUP") }
      }
      await this.validateSource(source); check()
      const selected = await this.selectDestination({
        defaultName: `${path.parse(source.dto.filename).name.slice(0, 120)}-${profile.operation === "extractAudio" ? `audio-${profile.streamIndex}` : profile.operation === "remux" ? "remux" : profile.operation === "trim" ? (profile.cuts ? "edited" : "clip") : "tracks"}.${profile.extension}`,
        extension: profile.extension
      })
      check()
      if (!selected) return { cancelled: true, plan: null }
      const target = await destination(selected, profile.extension)
      await this.validateSource(source); check()
      const summary = { ...profile, planId: randomUUID(), outputName: path.basename(target.final), expiresAt: Date.now() + 10 * 60 * 1000 }
      this.plan = { source, target, profile, summary }
      return { cancelled: false, plan: summary }
    } finally { if (this.preparing === reservation) this.preparing = null; this.emit() }
  }
  start(planId) {
    if (this.frozen) throw new MediaError("CLOSED")
    if (this.busy || this.isInspecting()) throw new MediaError("EXPORT_BUSY")
    const plan = this.plan
    if (!plan || plan.summary.planId !== planId || Date.now() >= plan.summary.expiresAt || plan.source !== this.getSource()) throw new MediaError("PLAN_EXPIRED")
    if (plan.profile.operation === "trim") this.validateTrimPlan?.(plan.profile)
    this.plan = null
    const active = { cancelled: false, process: null, published: false, done: null }
    this.active = active
    this.job = { jobId: randomUUID(), sourceId: plan.profile.sourceId, operation: plan.profile.operation, streamIndex: plan.profile.streamIndex,
      outputName: plan.summary.outputName, state: "reserved", progress: 0, error: null, cleanupWarning: false }
    this.emit()
    active.done = new Promise(resolve => setImmediate(resolve)).then(() => this.execute(active, plan))
    return this.snapshot() // the unique job is reserved before acknowledgment
  }
  async execute(active, plan) {
    let input, output, intermediate, manifest, owned, terminal = "failed", errorCode = null
    const check = () => { if (active.cancelled || this.frozen) throw new MediaError("EXPORT_CANCELLED") }
    const supervise = async process => {
      active.process = process
      try { return await process.result }
      catch (error) {
        if (!process.ended) { this.update({ state: "stopping", error: "EXPORT_STUCK" }); await process.closed }
        throw error
      } finally { active.process = null }
    }
    try {
      await this.ready; check()
      await this.validateSource(plan.source); check()
      input = await fs.open(plan.source.identity.realPath, "r")
      const stat = await input.stat({ bigint: true })
      if ([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") !== plan.source.identity.stamp) throw new MediaError("SOURCE_CHANGED")
      check()
      const executable = await this.resolveFfmpeg()
      const probe = await this.resolveProbe()
      await fs.access(executable, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)
      check()
      const created = await this.output.create(plan.target); owned = created.record; output = created.handle
      check()
      this.update({ state: "running" })
      const progress = (seconds, offset = 0, scale = 1) => {
        if (this.active === active && this.job.state === "running") {
          const value = Math.min(98, Math.max(this.job.progress, Math.floor(offset + seconds / plan.profile.duration * scale)))
          if (value !== this.job.progress) this.update({ progress: value })
        }
      }
      const cuts = plan.profile.cuts
      if (cuts?.length > 1) {
        let completed = 0
        for (const [index, cut] of cuts.entries()) {
          check()
          await this.validateSource(plan.source); check()
          // Each child inherits a fresh open-file description at offset zero.
          // Reusing fd 0 shares the previous child's seek position on POSIX.
          if (index > 0) {
            await input.close(); input = await fs.open(plan.source.identity.realPath, "r")
            const stat = await input.stat({ bigint: true })
            if ([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") !== plan.source.identity.stamp) throw new MediaError("SOURCE_CHANGED")
          }
          intermediate = await this.output.artifact(owned, `part-${index}.partial`)
          check()
          await supervise(this.runProcess(executable, exportArgs(cut, path.join(owned.directory, `part-${index}.partial`)), { inputFd: input.fd, outputFd: intermediate.fd,
            onProgress: seconds => progress(seconds, completed / plan.profile.duration * 70, 70) }))
          check(); await intermediate.sync()
          const file = path.join(owned.directory, `part-${index}.partial`)
          const metadata = await supervise(this.runProbe(probe, file)); check()
          validateOutput(cut, metadata, Number((await intermediate.stat()).size))
          completed += cut.duration
          await intermediate.close(); intermediate = null
        }
        manifest = await this.output.artifact(owned, "concat.partial")
        await manifest.writeFile(concatManifest(owned.directory, cuts)); await manifest.sync()
        await manifest.close(); manifest = await fs.open(path.join(owned.directory, "concat.partial"), "r")
        const manifestStat = await manifest.stat({ bigint: true })
        if (`${manifestStat.dev}:${manifestStat.ino}` !== owned.artifacts["concat.partial"]) throw new MediaError("OUTPUT_INVALID")
        check()
        await supervise(this.runProcess(executable, concatArgs(plan.profile, path.join(owned.directory, "part-0.partial"), owned.partial), { inputFd: manifest.fd, outputFd: output.fd,
          onProgress: seconds => progress(seconds, 70, 28) }))
        await manifest.close(); manifest = null
      } else {
        await supervise(this.runProcess(executable, exportArgs(cuts?.[0] || plan.profile, owned.partial), { inputFd: input.fd, outputFd: output.fd,
          onProgress: seconds => progress(seconds, 0, 98) }))
      }
      check()
      await output.sync()
      this.update({ state: "validating", progress: 99 })
      const metadata = await supervise(this.runProbe(probe, owned.partial))
      check()
      if (plan.profile.operation === "remux") metadata.contentContainer = await detectContainer(metadata, owned.partial)
      check()
      await this.validateSource(plan.source)
      validateOutput(plan.profile, metadata, Number((await output.stat()).size))
      await output.close(); output = null
      await input.close(); input = null
      check()
      // Publication is the cancellation commit point. Once entered, cancel
      // cannot report cancellation while the atomic link may have succeeded.
      this.update({ state: "publishing" })
      await this.output.publish(owned)
      active.published = true
      this.completed = { jobId: this.job.jobId, path: owned.final, fileKey: owned.fileKey }
      terminal = "completed"
    } catch (error) {
      const safe = safeError(error)
      terminal = active.cancelled || safe.code === "EXPORT_CANCELLED" || safe.code === "CANCELLED" ? "cancelled" : "failed"
      errorCode = terminal === "cancelled" ? null : safe.code
    } finally {
      await intermediate?.close().catch(() => {})
      await manifest?.close().catch(() => {})
      await input?.close().catch(() => {})
      await output?.close().catch(() => {})
      let cleanupWarning = false
      if (owned) {
        try { await this.output.clean(owned) }
        catch { cleanupWarning = true; this.recoveryError = "EXPORT_CLEANUP" }
      } else {
        try { await this.output.recover() }
        catch { cleanupWarning = true; this.recoveryError = "EXPORT_CLEANUP" }
      }
      this.active = null
      this.update({ state: terminal, progress: terminal === "completed" ? 100 : this.job.progress, error: errorCode, cleanupWarning })
    }
  }
  cancel(jobId) {
    if (!this.job || this.job.jobId !== jobId) throw new MediaError("JOB_UNKNOWN")
    if (!this.active || this.active.cancelled || TERMINAL.has(this.job.state) || this.job.state === "publishing") return this.snapshot()
    this.active.cancelled = true
    this.active.process?.cancel()
    this.update({ state: "stopping" })
    return this.snapshot()
  }
  async drain() {
    this.invalidatePlan()
    if (!this.active) {
      await this.ready
      if (this.recoveryError) {
        try { await this.output.recover(); this.recoveryError = null; this.emit() }
        catch { /* no live writer: retain the ledger/warning for next startup */ }
      }
      return
    }
    const active = this.active
    this.cancel(this.job.jobId)
    let timer
    try {
      await Promise.race([active.done, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new MediaError("EXPORT_STUCK")), 5000) })])
      // The writer and validation probe have exited. A retained partial/ledger
      // blocks another export, not closing the app or installing its update.
    } finally { clearTimeout(timer) }
  }
  freeze() { this.frozen = true; this.invalidatePlan() }
  async reveal(jobId) {
    if (!this.completed || this.completed.jobId !== jobId) throw new MediaError("JOB_UNKNOWN")
    const stat = await fs.lstat(this.completed.path, { bigint: true })
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== this.completed.fileKey) throw new MediaError("OUTPUT_CHANGED")
    await this.revealOutput(this.completed.path)
    return { revealed: true }
  }
}

module.exports = { LocalExport }
