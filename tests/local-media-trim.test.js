const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { trimProfile, validateTrimRequest, packetArgs, normalizePackets, timingWindows, planTrimTiming } = require("../src/main/services/local-media/trim-plan")
const { planExport, exportArgs, validateOutput } = require("../src/main/services/local-media/export-plan")
const { LocalMediaService, identify } = require("../src/main/services/local-media")
const { MediaError } = require("../src/main/services/local-media/errors")
const token = "a".repeat(64)
let source
const video = { index: 3, type: "video", codec: "h264", pixelFormat: "yuv420p", width: 160, height: 90, duration: 12, startTime: 0, disposition: { default: 1 }, title: null, tags: {} }
const audio = { index: 7, type: "audio", codec: "aac", profile: "LC", sampleRate: 48000, channels: 1, duration: 12, startTime: 0, disposition: { default: 1 }, title: "Voice", language: "eng", tags: {} }
beforeEach(() => { source = { sourceId: "source", filename: "test.mp4", contentContainer: "mp4", formatNames: ["mov", "mp4"], majorBrand: "isom", startTime: 0, duration: 12, chapterCount: 0, tags: {}, streams: structuredClone([video, audio]) } })
const request = (patch = {}) => ({ sourceId: source.sourceId, previewId: token, start: 4.2, end: 6, mode: "before", ...patch })
const packets = Array.from({ length: 288 }, (_, index) => ({ pts: index / 24, dts: index / 24, duration: 1 / 24, key: index % 96 === 0 }))
const timing = (patch = {}) => ({ ...planTrimTiming(source, request(patch), packets, packets), trimPlanId: "timing", expiresAt: Date.now() + 60000 })
const output = plan => ({ ...source, duration: plan.duration, startTime: 0, streams: plan.expectedStreams.map((stream, index) => ({ ...structuredClone(stream), index, startTime: 0, duration: plan.duration })) })

test("main keeps requested times independent from keyframe choice and original stream IDs", () => {
  const plan = timing()
  expect(plan).toMatchObject({ requestedStart: 4.2, requestedEnd: 6, plannedStart: 4, plannedEnd: 6, duration: 2, streamIndexes: [3, 7] })
  const ready = planExport(source, { operation: "trim", sourceId: "source", trimPlanId: "timing" }, plan)
  expect(ready).toBe(plan)
  const args = exportArgs(plan)
  expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"))
  expect(args.filter((_x, i) => args[i - 1] === "-map")).toEqual(["0:3", "0:7"])
  expect(args).toEqual(expect.arrayContaining(["-c", "copy", "-t", "2.000000", "-map_chapters", "-1"]))
  expect(args).not.toContain("-copyinkf"); expect(args).not.toContain("-avoid_negative_ts")
  expect(args).not.toContain("-itsoffset"); expect(args).not.toContain("-vf")
  expect(() => validateOutput(plan, output(plan), 100)).not.toThrow()
})
test("following keyframe, collapsed ranges, zero and EOF are explicit", () => {
  expect(timing({ start: 4.2, end: 10, mode: "after" }).plannedStart).toBe(8)
  expect(() => timing({ mode: "after" })).toThrow(expect.objectContaining({ code: "TRIM_RANGE" }))
  expect(exportArgs(timing({ start: 0, end: 2 }))).not.toContain("-ss")
  expect(exportArgs(timing({ start: 8, end: 12 }))).not.toContain("-t")
})
test.each([{ start: -1 }, { start: 6 }, { end: 13 }, { end: 4.21 }, { start: NaN }, { end: Infinity }, { start: "1" }, { mode: "nearest" }, { sourceId: "old" }, { argv: [] }, { previewId: "path" }])("rejects invalid bounds/contract %p", patch => { expect(() => validateTrimRequest(source, request(patch))).toThrow() })
test("unusable keys, delayed source and unhandled streams cannot become an approximate-looking plan", () => {
  expect(() => planTrimTiming(source, request(), packets.map(packet => ({ ...packet, key: false })), packets)).toThrow(expect.objectContaining({ code: "TRIM_KEYFRAME" }))
  source.startTime = 2; expect(() => trimProfile(source)).toThrow(expect.objectContaining({ code: "TRIM_TIMING" }))
  source.startTime = 0; source.chapterCount = 1; expect(() => trimProfile(source)).toThrow(expect.objectContaining({ code: "TRIM_STREAMS" }))
  source.chapterCount = 0; source.streams.push({ index: 9, type: "subtitle" }); expect(() => trimProfile(source)).toThrow(expect.objectContaining({ code: "TRIM_STREAMS" }))
})
test.each([{ codec: "hevc" }, { pixelFormat: "yuv420p10le" }, { hasHdrMetadata: true }, { disposition: { default: 0 } }])("video profile refuses %p", patch => { Object.assign(source.streams[0], patch); expect(() => trimProfile(source)).toThrow() })
test("PCM and AAC audio use separate measured seek rules; MP3/ADTS/MKV are refused", () => {
  source.streams = [{ ...audio, index: 0, codec: "pcm_s16le", disposition: {}, startTime: null }]; source.formatNames = ["wav"]; source.contentContainer = null; source.startTime = null
  let plan = timing({ start: 1.123, end: 3.456 })
  expect(plan.extension).toBe("wav"); let args = exportArgs(plan)
  expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i")); expect(args).not.toContain("-copyinkf")
  source.streams[0].codec = "mp3"; source.formatNames = ["mp3"]; source.startTime = 0.023
  expect(() => trimProfile(source)).toThrow(expect.objectContaining({ code: "TRIM_PROFILE" }))
  source.streams = [{ ...audio, index: 0 }]; source.formatNames = ["mov", "mp4"]; source.majorBrand = "M4A"; source.startTime = 0
  expect(trimProfile(source)).toMatchObject({ extension: "m4a", muxer: "ipod", hasVideo: false })
  plan = timing({ start: 1.123, end: 3.456 }); args = exportArgs(plan)
  expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i")); expect(args).toContain("-copyinkf")
  source.formatNames = ["aac"]; expect(() => trimProfile(source)).toThrow()
  source.formatNames = ["matroska"]; source.contentContainer = "mkv"; expect(() => trimProfile(source)).toThrow()
})
test("windowed packets bound time, bytes in runner, schema/count and ambiguous presentation timing", () => {
  const windows = timingWindows(source, request(), trimProfile(source))
  expect(windows.every(window => window.to - window.from <= 60)).toBe(true)
  expect(packetArgs("/selected", 7, 0, 10)).toEqual(expect.arrayContaining(["-select_streams", "7", "-read_intervals", "0.000000%10.000000", "-show_packets"]))
  expect(() => packetArgs("/selected", 7, 0, 61)).toThrow()
  expect(() => normalizePackets({ packets: Array(8193).fill({}) })).toThrow(expect.objectContaining({ code: "PROBE_LIMIT" }))
  for (const raw of [{}, { packets: [] }, { packets: [{ pts_time: "N/A" }] }, { packets: [{ pts_time: "0", dts_time: "0", duration_time: "1" }] }]) expect(() => normalizePackets(raw)).toThrow()
  expect(normalizePackets({ packets: [{ pts_time: "0", dts_time: "-0.083333", duration_time: "0.041667", flags: "K__" }] })).toMatchObject([{ key: true, pts: 0 }])
})
test("VFR/B-frame endpoint estimate uses actual PTS/DTS, not average FPS", () => {
  source.streams[0].averageFrameRate = "999/1"
  const tail = [{ pts: 5.95, dts: 5.8, duration: 0.05 }, { pts: 6.125, dts: 5.9, duration: 0.075 }, { pts: 6.05, dts: 6, duration: 0.05 }]
  expect(planTrimTiming(source, request(), packets, tail).plannedEnd).toBeCloseTo(6.2)
  expect(() => planTrimTiming(source, request(), packets, [{ pts: 9, dts: 5.9, duration: 0.05 }, tail[2]])).toThrow(expect.objectContaining({ code: "TRIM_TIMING" }))
})
test.each(["duration", "offset", "codec", "rotation", "chapters", "extra-stream", "tags"]) ("trim output validates %s before publication", kind => {
  const plan = timing(), data = output(plan)
  if (kind === "duration") data.duration += 1
  if (kind === "offset") data.streams[0].startTime = 0.2
  if (kind === "codec") data.streams[1].codec = "mp3"
  if (kind === "rotation") data.streams[0].rotation = 90
  if (kind === "chapters") data.chapterCount = 1
  if (kind === "extra-stream") data.streams.push({ ...data.streams[1], index: 2 })
  if (kind === "tags") { plan.fileTags = { title: "Expected" }; data.tags = {} }
  expect(() => validateOutput(plan, data, 100)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }))
})
test("expired, mismatched and renderer-supplied timing cannot replace a main-owned plan", () => {
  const request = { operation: "trim", sourceId: "source", trimPlanId: "timing" }, plan = timing()
  for (const candidate of [null, { ...plan, trimPlanId: "other" }, { ...plan, expiresAt: 0 }]) expect(() => planExport(source, request, candidate)).toThrow()
  expect(() => planExport(source, { ...request, start: 0 }, plan)).toThrow()
})

async function setup(runPackets) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-trim-test-")), file = path.join(directory, "source.mp4")
  await fs.writeFile(file, "unchanged")
  const finished = value => ({ result: Promise.resolve(value), closed: Promise.resolve(), ended: true, cancel() {} })
  const service = new LocalMediaService({ resolveProbe: async () => process.execPath, runPackets: runPackets || (() => finished(packets)), runFrames: () => finished({ firstTime: 4 }), exportOptions: { storagePath: path.join(directory, "state") } })
  service.source = { dto: source, selectedPath: file, identity: await identify(file) }
  const grant = () => { service.preview.grant = { sourceId: source.sourceId, previewId: token, url: `cliply-media://source/${token}`, expiresAt: Date.now() + 60000 } }
  grant()
  return { service, directory, file, grant }
}
test("actual playback acknowledgment is grant-bound; availability alone never enables a trim plan", async () => {
  const { service, directory } = await setup()
  try {
    await expect(service.inspectTrim(request())).rejects.toMatchObject({ code: "TRIM_PREVIEW" })
    expect(() => service.preview.confirmPlayback({ previewId: "b".repeat(64), played: true })).toThrow()
    service.preview.confirmPlayback({ previewId: token, played: true })
    const plan = await service.inspectTrim(request())
    expect(service.getTrimPlan(plan.trimPlanId)).toBe(plan)
    service.preview.confirmPlayback({ previewId: token, played: false })
    expect(() => service.getTrimPlan(plan.trimPlanId)).toThrow(expect.objectContaining({ code: "TRIM_PREVIEW" }))
    service.preview.revoke(); expect(service.preview.hasPlayback(token)).toBe(false)
    expect(service.source.dto).toBe(source)
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
test("timing inspection owns the existing probe slot, cancels without closing source and blocks exports until drain", async () => {
  let reject, closed
  const result = new Promise((_resolve, no) => { reject = no }), done = new Promise(resolve => { closed = resolve })
  const child = { result, closed: done, ended: false, cancel: jest.fn(() => { child.ended = true; reject(new MediaError("CANCELLED")); closed() }) }
  const { service, directory } = await setup(() => child)
  try {
    service.preview.confirmPlayback({ previewId: token, played: true })
    const inspection = service.inspectTrim(request()); const failure = expect(inspection).rejects.toMatchObject({ code: "CANCELLED" })
    while (!service.pending.process) await new Promise(resolve => setImmediate(resolve))
    await expect(service.open()).rejects.toMatchObject({ code: "BUSY" })
    await expect(service.inspectTrim(request())).rejects.toMatchObject({ code: "BUSY" })
    await expect(service.exports.prepare({ operation: "extractAudio", sourceId: source.sourceId, streamIndex: 7 })).rejects.toMatchObject({ code: "EXPORT_BUSY" })
    expect(await service.cancelTrim()).toEqual({ cancelled: true }); await failure
    expect(service.pending).toBeNull(); expect(service.source.dto).toBe(source); expect(child.cancel).toHaveBeenCalledTimes(1)
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
test("source changes and undecodable starting pictures invalidate timing before destination selection", async () => {
  const { service, directory, file } = await setup()
  try {
    service.preview.confirmPlayback({ previewId: token, played: true })
    service.runFrames = () => ({ result: Promise.resolve({ firstTime: 4.5 }), closed: Promise.resolve(), ended: true })
    await expect(service.inspectTrim(request())).rejects.toMatchObject({ code: "TRIM_TIMING" })
    expect(service.trimPlan).toBeNull()
    await fs.appendFile(file, "changed")
    await expect(service.inspectTrim(request())).rejects.toMatchObject({ code: "SOURCE_CHANGED" })
    expect(service.trimPlan).toBeNull()
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})

test("a stuck packet helper retains admission until close; shutdown cannot pretend it exited", async () => {
  let reject, release
  const child = { result: new Promise((_r, no) => { reject = no }), closed: new Promise(r => { release = r }), ended: false,
    cancel: jest.fn(() => reject(new MediaError("PROBE_STUCK"))) }
  const { service, directory } = await setup(() => child)
  try {
    service.preview.confirmPlayback({ previewId: token, played: true })
    const inspection = service.inspectTrim(request()); const failure = expect(inspection).rejects.toMatchObject({ code: "PROBE_STUCK" })
    while (!service.pending.process) await new Promise(setImmediate)
    await expect(service.cancelTrim()).rejects.toMatchObject({ code: "PROBE_STUCK" }); await failure
    expect(service.pending).not.toBeNull()
    await expect(service.shutdown()).rejects.toMatchObject({ code: "PROBE_STUCK" })
    child.ended = true; release(); await new Promise(setImmediate)
    expect(service.pending).toBeNull(); await service.shutdown()
  } finally { child.ended = true; release(); await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
test("destination plans cannot start after preview revocation or a newer timing plan", async () => {
  const { service, directory, grant } = await setup()
  try {
    service.exports.selectDestination = async () => path.join(directory, "out.mp4")
    service.preview.confirmPlayback({ previewId: token, played: true })
    const timing = await service.inspectTrim(request())
    const { plan } = await service.exports.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })
    service.preview.revoke()
    expect(() => service.exports.start(plan.planId)).toThrow(expect.objectContaining({ code: "TRIM_PREVIEW" }))
    grant(); service.preview.confirmPlayback({ previewId: token, played: true })
    await service.inspectTrim(request())
    expect(() => service.exports.start(plan.planId)).toThrow(expect.objectContaining({ code: "PLAN_EXPIRED" }))
    expect(service.exports.active).toBeNull()
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
test.each([0.2, null])("invalid decoded output start %p never publishes despite a valid inventory", async firstTime => {
  const { service, directory } = await setup()
  try {
    const finished = value => ({ result: Promise.resolve(value), closed: Promise.resolve(), ended: true })
    service.exports.selectDestination = async () => path.join(directory, "out.mp4")
    service.exports.resolveFfmpeg = async () => process.execPath
    service.exports.runProcess = (_exe, _args, { outputFd }) => { require("node:fs").writeSync(outputFd, "synthetic output"); return finished() }
    service.exports.runFrames = () => firstTime === null ? { result: Promise.reject(new MediaError("TRIM_TIMING")), closed: Promise.resolve(), ended: true } : finished({ firstTime })
    service.preview.confirmPlayback({ previewId: token, played: true })
    const timing = await service.inspectTrim(request())
    service.exports.runProbe = () => finished(output(timing))
    const { plan } = await service.exports.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })
    service.exports.start(plan.planId); await service.exports.active.done
    expect(service.exports.job.state).toBe("failed")
    await expect(fs.stat(path.join(directory, "out.mp4"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await fs.readdir(directory)).some(name => name.startsWith(".cliply-export-"))).toBe(false)
    expect(service.source.dto).toBe(source)
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
test("forced dispositions and nonmonotonic decode timestamps fail closed", () => {
  source.streams[0].disposition.forced = 1
  expect(() => trimProfile(source)).toThrow(expect.objectContaining({ code: "TRIM_PROFILE" }))
  const packet = { pts_time: "0", dts_time: "0", duration_time: "0.04", flags: "K__" }
  expect(() => normalizePackets({ packets: [packet, packet] })).toThrow(expect.objectContaining({ code: "TRIM_TIMING" }))
})

test("100 ms ranges tolerate floating-point subtraction; MP4 brand variants remain MP4", () => {
  expect(() => timing({ start: 4, end: 4.1 })).not.toThrow()
  const plan = timing(), data = output(plan)
  plan.majorBrand = "mp42"; data.majorBrand = "isom"
  expect(() => validateOutput(plan, data, 100)).not.toThrow()
  data.majorBrand = "qt"; expect(() => validateOutput(plan, data, 100)).toThrow()
})

const { retainedRanges, combineTiming } = require("../src/main/services/local-media/segments")
const edit = (patch = {}) => ({ sourceId: "source", intent: "remove", mode: "after", ranges: [{ start: 4, end: 8 }], ...patch })
test("middle deletion retains both sides, ordered; keep exports only markings", () => {
  expect(retainedRanges(source, edit())).toEqual([{ start: 0, end: 4 }, { start: 8, end: 12 }])
  expect(retainedRanges(source, edit({ intent: "keep" }))).toEqual([{ start: 4, end: 8 }])
  expect(retainedRanges(source, edit({ ranges: [] }))).toEqual([{ start: 0, end: 12 }])
})
test.each([
  { ranges: [{ start: 0, end: 12 }] }, { intent: "keep", ranges: [] },
  { ranges: [{ start: 0.01, end: 8 }] }, { ranges: [{ start: 8, end: 10 }, { start: 4, end: 6 }] },
  { ranges: [{ start: 4, end: 8 }, { start: 7, end: 9 }] }, { ranges: [{ start: 4, end: Infinity }] },
  { ranges: [{ start: 4, end: 8, path: "/private" }] }, { sourceId: "old" }, { command: [] },
  { ranges: Array(33).fill({ start: 4, end: 8 }) }
])("rejects empty outputs, tiny remainders and malformed edit requests %p", patch => {
  expect(() => retainedRanges(source, edit(patch))).toThrow()
})
test("expanded cuts cannot duplicate overlapping source pictures", () => {
  expect(() => combineTiming(edit(), [{ plannedStart: 0, plannedEnd: 5 }, { plannedStart: 4, plannedEnd: 12 }])).toThrow(expect.objectContaining({ code: "TRIM_OVERLAP" }))
})
test("segment planning is independent of native preview but still owns probes/source identity", async () => {
  const { service, directory, file } = await setup()
  try {
    service.preview.revoke()
    service.runFrames = (_exe, _file, _stream, start) => ({ result: Promise.resolve({ firstTime: start }), ended: true })
    const plan = await service.inspectTrim(edit())
    expect(plan.cuts.map(cut => [cut.plannedStart, cut.requestedEnd])).toEqual([[0, 4], [8, 12]])
    expect(service.getTrimPlan(plan.trimPlanId)).toBe(plan)
    await fs.appendFile(file, "changed")
    await expect(service.inspectTrim(edit())).rejects.toMatchObject({ code: "SOURCE_CHANGED" })
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
