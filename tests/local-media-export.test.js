const fs = require("node:fs/promises")
const syncFs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { LocalExport } = require("../src/main/services/local-media/export")
const { LocalMediaService, identify, assertUnchanged } = require("../src/main/services/local-media")
const { planAudio, audioProfile, exportArgs, validateOutput } = require("../src/main/services/local-media/export-plan")
const { ExportOutput } = require("../src/main/services/local-media/export-output")
const { MediaError } = require("../src/main/services/local-media/errors")

let directory, source, controller, options, events, selected, metadata
const finished = value => ({ result: Promise.resolve(value), closed: Promise.resolve(), ended: true, cancel: jest.fn() })
const request = () => ({ sourceId: "11111111-1111-4111-8111-111111111111", operation: "extractAudio", streamIndex: 7 })
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-export-test-"))
  const file = path.join(directory, "source.wav"); await fs.writeFile(file, "original source")
  source = { selectedPath: file, identity: await identify(file), dto: {
    sourceId: "11111111-1111-4111-8111-111111111111", filename: "source.wav", formatNames: ["wav"], duration: 2,
    streams: [{ index: 3, type: "video", codec: "h264" }, { index: 7, type: "audio", codec: "pcm_s16le", sampleRate: 44100, channels: 1, language: "rus", title: "Alternate", duration: 2 }]
  } }
  metadata = { streams: [{ ...source.dto.streams[1], index: 0 }], formatNames: ["wav"], duration: 2, chapterCount: 0 }
  selected = path.join(directory, "audio.wav"); events = []
  options = { getSource: () => source, validateSource: assertUnchanged, isInspecting: () => false,
    storagePath: path.join(directory, "state"), selectDestination: jest.fn(async () => selected),
    resolveFfmpeg: async () => process.execPath, resolveProbe: async () => process.execPath,
    revealOutput: jest.fn(), onUpdate: state => events.push(state),
    runProcess: jest.fn((_exe, _args, { outputFd, onProgress }) => { syncFs.writeSync(outputFd, "audio bytes"); onProgress(1); return finished() }),
    runProbe: jest.fn(() => finished(metadata)) }
  controller = new LocalExport(options); await controller.ready
})
afterEach(async () => { jest.restoreAllMocks(); jest.useRealTimers(); await fs.rm(directory, { recursive: true, force: true }) })
async function prepare() { return (await controller.prepare(request())).plan }
async function run() { const plan = await prepare(); const ack = controller.start(plan.planId); await controller.active.done; return ack }

test("refuses an unbounded cleanup record before writing a ledger", async () => {
  await expect(controller.output.write({ token: "a".repeat(64), parent: "x".repeat(8192) })).rejects.toMatchObject({ code: "OUTPUT_PATH" })
  await expect(fs.stat(controller.output.ledger)).rejects.toMatchObject({ code: "ENOENT" })
})

test.each(["close", "shutdown"])("%s holds the source until the export helper has actually closed", async method => {
  let reject, release
  const process = { ended: false, result: new Promise((_resolve, r) => { reject = r }),
    closed: new Promise(r => { release = r }), cancel: jest.fn(() => reject(new MediaError("EXPORT_CANCELLED"))) }
  const service = new LocalMediaService({ resolveProbe: options.resolveProbe,
    exportOptions: { ...options, runProcess: () => process } })
  service.source = source
  const plan = (await service.exports.prepare(request())).plan
  service.exports.start(plan.planId)
  while (service.exports.job.state !== "running") await new Promise(setImmediate)
  let settled = false
  const closing = service[method]().then(value => { settled = true; return value })
  await new Promise(setImmediate)
  expect(process.cancel).toHaveBeenCalledTimes(1)
  expect(settled).toBe(false)
  expect(service.source).toBe(source)
  await expect(service.open()).rejects.toMatchObject({ code: method === "shutdown" ? "CLOSED" : "EXPORT_BUSY" })
  process.ended = true; release()
  expect(await closing).toEqual({ closed: true })
  expect(service.source).toBeNull()
  expect(service.exports.job.state).toBe("cancelled")
  await expect(fs.stat(selected)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(fs.stat(service.exports.output.ledger)).rejects.toMatchObject({ code: "ENOENT" })
})

test("maps an actual non-contiguous ID, preserves selected identity and exposes no paths/argv", async () => {
  const plan = await prepare()
  expect(plan).toMatchObject({ streamIndex: 7, codec: "pcm_s16le", extension: "wav", language: "rus", title: "Alternate", outputName: "audio.wav" })
  expect(JSON.stringify(plan)).not.toContain(directory)
  expect(exportArgs(plan)).toEqual(expect.arrayContaining(["-map", "0:7", "-c", "copy", "-f", "wav"]))
  expect(exportArgs(plan)).not.toContain("-y")
})
test.each([{}, { ...request(), argv: [] }, { ...request(), operation: "trim" }, { ...request(), streamIndex: 0 }, { ...request(), streamIndex: -1 }, { ...request(), sourceId: "wrong" }])("rejects invalid plan %p", request => {
  expect(() => planAudio(source.dto, request)).toThrow()
})
test.each([["aac", "LC", ["mov"], "aac"], ["mp3", null, ["mp3"], "mp3"], ["pcm_s16le", null, ["wav"], "wav"], ["aac", "HE-AAC", ["mov"], null], ["pcm_s24le", null, ["wav"], null], ["opus", null, ["matroska"], null]])("bounded profile %s %s", (codec, profile, formatNames, extension) => {
  expect(audioProfile({ formatNames }, { type: "audio", codec, profile, sampleRate: 44100, channels: 2 })?.extension || null).toBe(extension)
})
test("reserves before acknowledgment, rejects double start, emits one terminal outcome and keeps the original", async () => {
  const plan = await prepare(); const ack = controller.start(plan.planId)
  expect(ack.job.state).toBe("reserved")
  expect(() => controller.start(plan.planId)).toThrow()
  await controller.active.done
  expect(controller.snapshot().job.state).toBe("completed")
  expect(await fs.readFile(selected, "utf8")).toBe("audio bytes")
  expect(await fs.readFile(source.selectedPath, "utf8")).toBe("original source")
  expect(events.filter(e => ["completed", "cancelled", "failed"].includes(e.job?.state))).toHaveLength(1)
  expect(events.map(e => e.revision)).toEqual([...new Set(events.map(e => e.revision))].sort((a, b) => a - b))
  expect(await fs.readdir(directory)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.cliply-export/)]))
  expect(controller.getSource()).toBe(source)
  await controller.reveal(ack.job.jobId)
  expect(options.revealOutput).toHaveBeenCalledWith(await fs.realpath(selected))
})
test("dialog cancellation is normal; opening a second plan is refused while destination selection is pending", async () => {
  let resolve
  controller.selectDestination = () => new Promise(r => { resolve = r })
  const pending = controller.prepare(request()); while (!resolve) await new Promise(setImmediate)
  await expect(controller.prepare(request())).rejects.toMatchObject({ code: "EXPORT_BUSY" })
  resolve(null); expect(await pending).toEqual({ cancelled: true, plan: null })
  expect(options.runProcess).not.toHaveBeenCalled()
})
test("closing during destination selection discards the late reply without creating a job", async () => {
  let resolve
  controller.selectDestination = () => new Promise(r => { resolve = r })
  const pending = controller.prepare(request()); while (!resolve) await new Promise(setImmediate)
  await controller.drain(); resolve(selected)
  await expect(pending).rejects.toMatchObject({ code: "EXPORT_CANCELLED" })
  expect(controller.plan).toBeNull()
})
test.each(["existing", "source", "symlink", "hardlink"])("never overwrites %s destination", async kind => {
  if (kind === "existing") await fs.writeFile(selected, "other")
  if (kind === "source") selected = source.selectedPath
  if (kind === "symlink") await fs.symlink(source.selectedPath, selected)
  if (kind === "hardlink") { await fs.link(source.selectedPath, selected); source.identity = await identify(source.selectedPath) }
  await expect(prepare()).rejects.toMatchObject({ code: "OUTPUT_EXISTS" })
  expect(await fs.readFile(source.selectedPath, "utf8")).toBe("original source")
})
test("destination race after validation preserves the third-party file", async () => {
  const link = fs.link.bind(fs)
  jest.spyOn(fs, "link").mockImplementationOnce(async (from, to) => { await fs.writeFile(to, "racing user file"); return link(from, to) })
  await run()
  expect(controller.job).toMatchObject({ state: "failed", error: "OUTPUT_EXISTS" })
  expect(await fs.readFile(selected, "utf8")).toBe("racing user file")
})
test.each(["ENOSPC", "EACCES", "ENOTSUP"])("publication failure %s never falls back to overwrite", async code => {
  jest.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("private diagnostic"), { code }))
  await run()
  expect(controller.job.state).toBe("failed")
  expect(JSON.stringify(controller.snapshot())).not.toContain("private diagnostic")
  await expect(fs.stat(selected)).rejects.toHaveProperty("code", "ENOENT")
})
test("repeated exports require a new filename and preserve completed outputs", async () => {
  await run(); const first = selected
  await expect(prepare()).rejects.toMatchObject({ code: "OUTPUT_EXISTS" })
  selected = path.join(directory, "again.wav"); await run()
  expect(await fs.readFile(first, "utf8")).toBe(await fs.readFile(selected, "utf8"))
})
test.each(["before", "during"])("changed source %s work cannot publish", async when => {
  const plan = await prepare()
  if (when === "before") await fs.appendFile(source.selectedPath, "changed")
  else controller.runProbe = () => { syncFs.appendFileSync(source.selectedPath, "changed"); return finished(metadata) }
  controller.start(plan.planId); await controller.active.done
  expect(controller.job).toMatchObject({ state: "failed", error: "SOURCE_CHANGED" })
  await expect(fs.stat(selected)).rejects.toHaveProperty("code", "ENOENT")
})
test("cancel before spawn and duplicate cancel produce no output or helper", async () => {
  const plan = await prepare(); const ack = controller.start(plan.planId)
  controller.cancel(ack.job.jobId); controller.cancel(ack.job.jobId)
  await controller.active.done
  expect(options.runProcess).not.toHaveBeenCalled()
  expect(controller.job.state).toBe("cancelled")
  await expect(fs.stat(selected)).rejects.toHaveProperty("code", "ENOENT")
})
test("cancel during validation cleans the partial; once publishing starts completion wins", async () => {
  controller.runProbe = () => { controller.cancel(controller.job.jobId); return finished(metadata) }
  await run(); expect(controller.job.state).toBe("cancelled")
  controller.runProbe = options.runProbe
  const link = fs.link.bind(fs)
  jest.spyOn(fs, "link").mockImplementationOnce(async (from, to) => { expect(controller.cancel(controller.job.jobId).job.state).toBe("publishing"); return link(from, to) })
  await run(); expect(controller.job.state).toBe("completed")
})
test("failed output validation discards even an exit-zero output", async () => {
  metadata.streams.push({ ...metadata.streams[0], index: 1 })
  await run(); expect(controller.job).toMatchObject({ state: "failed", error: "OUTPUT_INVALID" })
  await expect(fs.stat(selected)).rejects.toHaveProperty("code", "ENOENT")
})
test.each([0, 0.1, 3, NaN])("invalid output duration %s is rejected", duration => {
  expect(() => validateOutput(planAudio(source.dto, request()), { ...metadata, streams: [{ ...metadata.streams[0], duration }] }, 100)).toThrow()
})
test("minimal recovery cleans only the recorded partial and keeps a published hardlink", async () => {
  const plan = await prepare(); const target = controller.plan.target
  const owned = await controller.output.create(target)
  await owned.handle.writeFile("complete audio"); await owned.handle.close()
  await controller.output.publish(owned.record)
  const recovered = new LocalExport(options); await recovered.ready
  expect(recovered.job.state).toBe("interrupted")
  expect(await fs.readFile(selected, "utf8")).toBe("complete audio")
  await expect(fs.stat(owned.record.directory)).rejects.toHaveProperty("code", "ENOENT")
  expect(plan.outputName).toBe("audio.wav")
})
test("recovery can finish after cleanup removed the marker but crashed before removing its empty directory", async () => {
  await prepare()
  const owned = await controller.output.create(controller.plan.target)
  await owned.handle.close()
  await fs.unlink(owned.record.partial)
  await fs.unlink(path.join(owned.record.directory, ".owner"))
  await expect(new ExportOutput(options.storagePath).recover()).resolves.toBe(true)
  await expect(fs.stat(owned.record.directory)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(fs.stat(controller.output.ledger)).rejects.toMatchObject({ code: "ENOENT" })
})
test("an empty directory with a different identity is not treated as interrupted cleanup", async () => {
  await prepare()
  const owned = await controller.output.create(controller.plan.target)
  await owned.handle.close()
  await fs.rename(owned.record.directory, owned.record.directory + ".original")
  await fs.mkdir(owned.record.directory)
  await expect(new ExportOutput(options.storagePath).recover()).rejects.toMatchObject({ code: "EXPORT_CLEANUP" })
  expect((await fs.stat(owned.record.directory)).isDirectory()).toBe(true)
})
test("cleanup failure retains its ledger and blocks exports, but does not trap shutdown after the writer exited", async () => {
  const service = new LocalMediaService({ resolveProbe: options.resolveProbe, exportOptions: options })
  service.source = source
  jest.spyOn(service.exports.output, "clean").mockRejectedValue(new MediaError("EXPORT_CLEANUP"))
  const { plan } = await service.exports.prepare(request())
  service.exports.start(plan.planId)
  await service.exports.active.done
  expect(service.exports.job).toMatchObject({ state: "completed", cleanupWarning: true })
  expect(service.exports.active).toBeNull()
  await expect(service.exports.prepare(request())).rejects.toMatchObject({ code: "EXPORT_CLEANUP" })
  await expect(service.shutdown()).resolves.toEqual({ closed: true })
  expect(service.exports.snapshot().recoveryError).toBe("EXPORT_CLEANUP")
  expect((await fs.stat(service.exports.output.ledger)).isFile()).toBe(true)
  expect(await fs.readFile(selected, "utf8")).toBe("audio bytes")
})
test("recovery refuses a replaced partial or unrelated files inside a staging directory", async () => {
  await prepare(); const owned = await controller.output.create(controller.plan.target); await owned.handle.close()
  await fs.writeFile(path.join(owned.record.directory, "user-file"), "preserve")
  await expect(new ExportOutput(options.storagePath).recover()).rejects.toMatchObject({ code: "EXPORT_CLEANUP" })
  expect(await fs.readFile(path.join(owned.record.directory, "user-file"), "utf8")).toBe("preserve")
  await fs.unlink(path.join(owned.record.directory, "user-file")); await fs.rename(owned.record.partial, owned.record.partial + ".old")
  await fs.writeFile(owned.record.partial, "replacement"); await fs.unlink(owned.record.partial + ".old")
  await expect(new ExportOutput(options.storagePath).recover()).rejects.toMatchObject({ code: "EXPORT_CLEANUP" })
  expect(await fs.readFile(owned.record.partial, "utf8")).toBe("replacement")
})
test("a stuck process holds the slot and partial until actual exit; drain refuses to install/quit", async () => {
  let release, reject, ended = false
  const closed = new Promise(r => { release = () => { ended = true; r() } })
  controller.runProcess = () => ({ result: new Promise((_r, j) => { reject = j }), closed, get ended() { return ended }, cancel: () => reject(new MediaError("EXPORT_STUCK")) })
  const plan = await prepare(); controller.start(plan.planId)
  while (!controller.active.process) await new Promise(setImmediate)
  jest.useFakeTimers()
  const drain = controller.drain(); const check = expect(drain).rejects.toMatchObject({ code: "EXPORT_STUCK" })
  await jest.advanceTimersByTimeAsync(5001); await check
  expect(controller.active).not.toBeNull()
  expect(controller.job.state).toBe("stopping")
  await expect(controller.prepare(request())).rejects.toMatchObject({ code: "EXPORT_BUSY" })
  const done = controller.active.done; release(); await done
  expect(controller.job.state).toBe("cancelled")
  expect(controller.active).toBeNull()
})

test("multi-cut crash recovery removes recorded intermediates and preserves unrelated files", async () => {
  const { destination } = require("../src/main/services/local-media/export-output")
  const created = await controller.output.create(await destination(selected, "wav"))
  await created.handle.close()
  const part = await controller.output.artifact(created.record, "part-0.partial")
  await part.writeFile("part"); await part.close()
  const list = await controller.output.artifact(created.record, "concat.partial")
  await list.writeFile("manifest"); await list.close()
  await fs.writeFile(path.join(directory, "unrelated"), "keep")
  await expect(new ExportOutput(options.storagePath).recover()).resolves.toBe(true)
  expect(await fs.readFile(path.join(directory, "unrelated"), "utf8")).toBe("keep")
  await expect(fs.stat(created.record.directory)).rejects.toMatchObject({ code: "ENOENT" })
})
test("intermediate ownership refuses traversal and replaced files", async () => {
  const { destination } = require("../src/main/services/local-media/export-output")
  const created = await controller.output.create(await destination(selected, "wav"))
  await created.handle.close()
  await expect(controller.output.artifact(created.record, "../victim")).rejects.toMatchObject({ code: "OUTPUT_PATH" })
  const part = await controller.output.artifact(created.record, "part-0.partial"); await part.close()
  const file = path.join(created.record.directory, "part-0.partial")
  await fs.rename(file, path.join(directory, "original-part")); await fs.writeFile(file, "replacement")
  await expect(new ExportOutput(options.storagePath).recover()).rejects.toMatchObject({ code: "EXPORT_CLEANUP" })
  expect(await fs.readFile(file, "utf8")).toBe("replacement")
})
