const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { trimProfile, validateTrimRequest, planLosslessCut } = require("../src/main/services/local-media/trim-plan")
const { planExport, exportArgs, validateOutput } = require("../src/main/services/local-media/export-plan")
const { LocalMediaService, identify } = require("../src/main/services/local-media")
const token = "a".repeat(64)
let source
const video = { index: 3, type: "video", codec: "h264", pixelFormat: "yuv420p", width: 160, height: 90, duration: 12, startTime: 0, disposition: { default: 1 }, title: null, tags: {} }
const audio = { index: 7, type: "audio", codec: "aac", profile: "LC", sampleRate: 48000, channels: 1, duration: 12, startTime: 0, disposition: { default: 1 }, title: "Voice", language: "eng", tags: {} }
beforeEach(() => { source = { sourceId: "source", filename: "test.mp4", contentContainer: "mp4", formatNames: ["mov", "mp4"], majorBrand: "isom", startTime: 0, duration: 12, chapterCount: 0, tags: {}, streams: structuredClone([video, audio]) } })
const request = (patch = {}) => ({ sourceId: source.sourceId, previewId: token, start: 4.2, end: 6, mode: "before", ...patch })
const packets = Array.from({ length: 288 }, (_, index) => ({ pts: index / 24, dts: index / 24, duration: 1 / 24, key: index % 96 === 0 }))
const timing = (patch = {}) => ({ ...planLosslessCut(source, request(patch)), trimPlanId: "timing", expiresAt: Date.now() + 60000 })
const output = plan => ({ ...source, duration: plan.duration, startTime: 0, streams: plan.expectedStreams.map((stream, index) => ({ ...structuredClone(stream), index, startTime: 0, duration: plan.duration })) })

test.each([{ start: -1 }, { start: 6 }, { end: 13 }, { end: 4.21 }, { start: NaN }, { end: Infinity }, { start: "1" }, { mode: "nearest" }, { sourceId: "old" }, { argv: [] }, { previewId: "path" }])("rejects invalid bounds/contract %p", patch => { expect(() => validateTrimRequest(source, request(patch))).toThrow() })
test.each([{ codec: "hevc" }, { pixelFormat: "yuv420p10le" }, { hasHdrMetadata: true }, { disposition: { default: 0 } }])("video profile refuses %p", patch => { Object.assign(source.streams[0], patch); expect(() => trimProfile(source)).toThrow() })
test("expired, mismatched and renderer-supplied timing cannot replace a main-owned plan", () => {
  const request = { operation: "trim", sourceId: "source", trimPlanId: "timing" }, plan = timing()
  for (const candidate of [null, { ...plan, trimPlanId: "other" }, { ...plan, expiresAt: 0 }]) expect(() => planExport(source, request, candidate)).toThrow()
  expect(() => planExport(source, { ...request, start: 0 }, plan)).toThrow()
})

test("keyframe cut uses the requested start before input with upstream timestamp and faststart flags", () => {
  const plan = timing()
  expect(plan).toMatchObject({ method: "losslesscut", requestedStart: 4.2, plannedStart: 4.2, requestedEnd: 6 })
  expect(exportArgs(plan, "/owned/part.mp4")).toEqual([
    "-hide_banner", "-nostdin", "-ss", "4.200000", "-protocol_whitelist", "fd,file,pipe", "-format_whitelist", "mov,matroska,webm,wav,mp3,aac", "-enable_drefs", "0", "-use_absolute_path", "0", "-fd", "0", "-i", "fd:", "-t", "1.800000",
    "-avoid_negative_ts", "make_zero", "-map", "0:3", "-c:0", "copy", "-map", "0:7", "-c:1", "copy", "-metadata:s:1", "title=Voice",
    "-map_metadata", "0", "-map_chapters", "-1", "-movflags", "+faststart", "-ignore_unknown",
    "-progress", "pipe:2", "-nostats", "-f", "mp4", "-y", "/owned/part.mp4"
  ])
})
test("normal cuts seek after input, do not snap to next keyframe or shift timestamps", () => {
  const args = exportArgs(timing({ mode: "after" }))
  expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"))
  expect(args[args.indexOf("-ss") + 1]).toBe("4.200000")
  expect(args).not.toContain("-avoid_negative_ts")
  expect(args).not.toContain("-copyts")
  expect(args).not.toContain("-copyinkf")
})
test("zero and EOF omit unnecessary seek/duration options", () => {
  expect(exportArgs(timing({ start: 0, end: 2 }))).not.toContain("-ss")
  expect(exportArgs(timing({ start: 8, end: 12 }))).not.toContain("-t")
})
test("Matroska B-frame compensation is upstream's positive offset, not custom copyts rebasing", () => {
  source.contentContainer = "mkv"; source.formatNames = ["matroska"]; source.majorBrand = null
  source.streams[0].bFrames = 2
  const args = exportArgs(timing())
  expect(args[args.indexOf("-ss") + 1]).toBe((4.2 + 3 / 23 + 0.001).toFixed(6))
  expect(args[args.indexOf("-itsoffset") + 1]).toBe((3 / 23 + 0.001).toFixed(6))
  expect(args).not.toContain("-copyts")
  expect(exportArgs(timing({ mode: "after" }))).not.toContain("-itsoffset")
})
test("audio-only normal cuts preserve initial non-keyframe packets; keyframe mode stays input seek", () => {
  source.streams = [{ ...audio, index: 0 }]; source.contentContainer = null; source.majorBrand = "M4A"
  const normal = exportArgs(timing({ mode: "after" }))
  expect(normal).toContain("-copyinkf")
  expect(normal.indexOf("-ss")).toBeGreaterThan(normal.indexOf("-i"))
  const keyframe = exportArgs(timing())
  expect(keyframe).not.toContain("-copyinkf")
  expect(keyframe.indexOf("-ss")).toBeLessThan(keyframe.indexOf("-i"))
})
test.each(["codec", "rotation", "chapters", "extra-stream", "tags", "empty"]) ("output still validates %s before publication", kind => {
  const plan = timing(), data = output(plan)
  if (kind === "codec") data.streams[1].codec = "mp3"
  if (kind === "rotation") data.streams[0].rotation = 90
  if (kind === "chapters") data.chapterCount = 1
  if (kind === "extra-stream") data.streams.push({ ...data.streams[1], index: 2 })
  if (kind === "tags") { plan.fileTags = { title: "Expected" }; data.tags = {} }
  if (kind === "empty") data.duration = 0
  expect(() => validateOutput(plan, data, 100)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }))
})
test("keyframe leading packets and normal-cut picture gaps are not rejected as timing corruption", () => {
  const plan = timing(), data = output(plan)
  data.duration += 2; data.streams[0].startTime = 0.2
  expect(() => validateOutput(plan, data, 100)).not.toThrow()
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
test("all cuts are independent of playback and do not run the retired packet/frame planner", async () => {
  const { service, directory } = await setup()
  try {
    service.preview.revoke()
    service.runPackets = jest.fn(() => { throw new Error("retired") })
    service.runFrames = jest.fn(() => { throw new Error("retired") })
    const plan = await service.inspectTrim(request())
    expect(service.getTrimPlan(plan.trimPlanId)).toBe(plan)
    expect(plan.plannedStart).toBe(4.2)
    expect(service.runPackets).not.toHaveBeenCalled()
    expect(service.runFrames).not.toHaveBeenCalled()
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
test("cancel during source validation prevents plan publication and preserves the source", async () => {
  const { service, directory } = await setup()
  try {
    const pending = service.inspectTrim(request())
    const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELLED" })
    await service.cancelTrim(); await rejected
    expect(service.trimPlan).toBeNull()
    expect(service.source.dto).toBe(source)
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
test("source changes and newer edit plans invalidate export preparation", async () => {
  const { service, directory, file } = await setup()
  try {
    service.exports.selectDestination = async () => path.join(directory, "out.mp4")
    const timing = await service.inspectTrim(request())
    const { plan } = await service.exports.prepare({ operation: "trim", sourceId: source.sourceId, trimPlanId: timing.trimPlanId })
    await service.inspectTrim(request({ start: 3 }))
    expect(() => service.exports.start(plan.planId)).toThrow(expect.objectContaining({ code: "PLAN_EXPIRED" }))
    await fs.appendFile(file, "changed")
    await expect(service.inspectTrim(request())).rejects.toMatchObject({ code: "SOURCE_CHANGED" })
  } finally { await service.shutdown(); await fs.rm(directory, { recursive: true, force: true }) }
})
const { retainedRanges } = require("../src/main/services/local-media/segments")
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

test("adjacent sections remain distinct, matching upstream's per-segment exports", () => {
  expect(retainedRanges(source, edit({ intent: "keep", ranges: [{ start: 0, end: 4 }, { start: 4, end: 8 }] }))).toEqual([{ start: 0, end: 4 }, { start: 4, end: 8 }])
})
test("concat uses file entries only and a separate metadata input, without custom duration/copyts", () => {
  const { concatManifest, concatArgs } = require("../src/main/services/local-media/join")
  const manifest = concatManifest("/owned", [{ plannedStart: 0, plannedEnd: 4 }, { plannedStart: 8, plannedEnd: 12 }])
  expect(manifest).not.toContain("duration")
  expect(manifest).toContain("file 'file:/owned/part-0.partial'")
  const args = concatArgs(timing(), "/owned/part-0.partial", "/owned/output.partial")
  expect(args).not.toContain("-copyts")
  expect(args).toEqual(expect.arrayContaining(["-map_metadata", "1", "-movflags", "+faststart"]))
  expect(args.filter((_, i) => args[i - 1] === "-i")).toEqual(["fd:", "/owned/part-0.partial"])
})
