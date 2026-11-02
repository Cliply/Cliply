const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { detectContainer, ebmlDocType } = require("../src/main/services/local-media/container")
const { planRemux, planExport, remuxProfiles, exportArgs, validateOutput } = require("../src/main/services/local-media/export-plan")
const { normalizeProbe } = require("../src/main/services/local-media/probe")
let source
beforeEach(() => { source = { sourceId: "source", contentContainer: "mp4", filename: "wrong.mov", formatNames: ["mov", "mp4"], majorBrand: "isom", startTime: 0, duration: 4, chapterCount: 0, chapters: [], chaptersCopySafe: true, tags: { title: "Fixture" }, streams: [
  { index: 3, type: "video", codec: "h264", width: 320, height: 180, pixelFormat: "yuv420p", startTime: 0, duration: 4, title: null, disposition: { default: 1 } },
  { index: 7, type: "audio", codec: "aac", profile: "LC", sampleRate: 44100, channels: 1, startTime: 0, duration: 4, language: "rus", title: "Alternate", disposition: { default: 1 } }
] } })
const request = (extra = {}) => ({ operation: "remux", sourceId: source.sourceId, streamIndexes: [3, 7], targetContainer: "mkv", removeChapters: false, ...extra })
const output = plan => ({ contentContainer: plan.targetContainer, formatNames: ["matroska", "webm"], duration: 4.023, startTime: 0, tags: source.tags, chapterCount: plan.expectedChapters.length, chapters: structuredClone(plan.expectedChapters), chaptersCopySafe: true, streams: plan.expectedStreams.map((stream, index) => ({ ...structuredClone(stream), index })) })
const ebml = type => { const bytes = Buffer.from(type); return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 + 3 + bytes.length, 0x42, 0x82, 0x80 + bytes.length]), bytes]) }

test("MOV family uses content major brand, never extension or first label", async () => {
  expect(await detectContainer(source, "unused")).toBe("mp4")
  expect(await detectContainer({ ...source, majorBrand: "qt" }, "unused")).toBe("mov")
  expect(await detectContainer({ ...source, majorBrand: "unknown" }, "unused")).toBeNull()
  expect(await detectContainer({ ...source, majorBrand: null }, "unused")).toBeNull()
  expect(await detectContainer({ formatNames: ["aac"] }, "unused")).toBeNull()
})
test("bounded EBML DocType distinguishes Matroska from WebM and rejects malformed headers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-container-test-"))
  try {
    const file = path.join(dir, "misleading.mp4")
    for (const [type, expected] of [["matroska", "mkv"], ["webm", null], ["other", null]]) {
      await fs.writeFile(file, ebml(type)); expect(await detectContainer({ formatNames: ["matroska", "webm"] }, file)).toBe(expected)
    }
    for (const invalid of [Buffer.alloc(0), Buffer.alloc(40), ebml("matroska").subarray(0, 7), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xff]), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00])]) expect(ebmlDocType(invalid)).toBeNull()
    const highBit = ebml("matroska"); highBit[8] |= 0x80; expect(ebmlDocType(highBit)).not.toBe("matroska")
    const duplicate = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x96]), ebml("matroska").subarray(5), ebml("matroska").subarray(5)])
    expect(ebmlDocType(duplicate)).toBeNull()
    await fs.symlink(file, path.join(dir, "link")); await expect(detectContainer({ formatNames: ["matroska"] }, path.join(dir, "link"))).rejects.toBeTruthy()
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
test("targets are explicit, retain real stream indexes, and source content controls demuxer guards", () => {
  expect(remuxProfiles(source).map(p => p.targetContainer)).toEqual(["mov", "mkv"])
  const plan = planExport(source, request({ streamIndexes: [7, 3] }))
  expect(plan).toMatchObject({ operation: "remux", streamIndexes: [3, 7], targetContainer: "mkv", muxer: "matroska", movInput: true })
  const args = exportArgs(plan)
  expect(args).toEqual(expect.arrayContaining(["-enable_drefs", "0", "-use_absolute_path", "0", "-c", "copy", "-map", "0:3", "-map", "0:7", "-default_mode", "passthrough", "-map_chapters", "-1"]))
  source.contentContainer = "mkv"
  expect(exportArgs(planRemux(source, request({ targetContainer: "mp4" })))).not.toContain("-enable_drefs")
  expect(() => validateOutput(plan, output(plan), 100)).not.toThrow()
})
test.each([{ targetContainer: "avi" }, { targetContainer: "mp4" }, { targetContainer: "__proto__" }, { targetContainer: "MP4" }, { streamIndexes: [3, 3] }, { streamIndexes: [1] }, { streamIndexes: ["3"] }, { removeChapters: 1 }, { argv: [] }, { muxer: "mp4" }, { sourceId: "old" }])("invalid request/target refused: %p", patch => { expect(() => planRemux(source, request(patch))).toThrow() })
test("unknown source identity, unsupported codecs/subtitles and nonzero MKV rotation never trigger removal or encoding", () => {
  source.contentContainer = null; expect(remuxProfiles(source)).toEqual([]); expect(() => planRemux(source, request())).toThrow()
  source.contentContainer = "mp4"
  source.streams.push({ index: 11, type: "subtitle", codec: "mov_text", disposition: { default: 1 } })
  expect(() => planRemux(source, request({ streamIndexes: [3, 7, 11] }))).toThrow(expect.objectContaining({ code: "TRACK_UNSUPPORTED" }))
  expect(planRemux(source, request()).removedStreamIndexes).toEqual([11])
  source.streams[0].rotation = 90
  expect(() => planRemux(source, request())).toThrow(expect.objectContaining({ code: "TRACK_UNSUPPORTED" }))
  expect(planRemux(source, request({ targetContainer: "mov" })).expectedStreams[0].rotation).toBe(90)
  source.streams[1].disposition.forced = 1
  expect(() => planRemux(source, request({ targetContainer: "mov" }))).toThrow(expect.objectContaining({ code: "TRACK_UNSUPPORTED" }))
  source.streams[1].disposition.forced = 0
  source.streams[1].codec = "opus"
  expect(() => planRemux(source, request({ targetContainer: "mov" }))).toThrow(expect.objectContaining({ code: "TRACK_UNSUPPORTED" }))
})
test("MOV default promotion and delayed/unknown timelines are refused", () => {
  source.streams[1].disposition = { default: 0 }
  expect(() => planRemux(source, request({ targetContainer: "mov" }))).toThrow(expect.objectContaining({ code: "TRACK_DEFAULT" }))
  source.streams[1].startTime = 2
  expect(() => planRemux(source, request())).toThrow(expect.objectContaining({ code: "REMUX_TIMING" }))
  source.streams[1].startTime = null
  expect(() => planRemux(source, request())).toThrow(expect.objectContaining({ code: "REMUX_TIMING" }))
})
test("chapters are bounded and preserve into MKV only; unsupported chapters need explicit removal", () => {
  source.chapterCount = 1; source.chapters = [{ start: 0, end: 2, title: "First" }]
  const plan = planRemux(source, request())
  expect(exportArgs(plan)).toEqual(expect.arrayContaining(["-map_chapters", "0"]))
  expect(() => validateOutput(plan, output(plan), 100)).not.toThrow()
  expect(() => planRemux(source, request({ targetContainer: "mov" }))).toThrow(expect.objectContaining({ code: "REMUX_CHAPTERS" }))
  expect(planRemux(source, request({ targetContainer: "mov", removeChapters: true })).expectedChapters).toEqual([])
  source.chaptersCopySafe = false
  expect(() => planRemux(source, request())).toThrow(expect.objectContaining({ code: "REMUX_CHAPTERS" }))
})
test.each(["container", "extra", "title", "codec", "rotation", "start", "duration", "chapter-title", "chapter-time", "chapter-missing", "file-tag", "disposition"]) ("remux output validates %s before publishing", change => {
  source.chapterCount = 1; source.chapters = [{ start: 0, end: 2, title: "First" }]
  const plan = planRemux(source, request()), result = output(plan)
  if (change === "container") result.contentContainer = "webm"
  if (change === "extra") result.streams.push({ ...result.streams[0], index: 2 })
  if (change === "title") result.streams[1].title = "Changed"
  if (change === "codec") result.streams[1].codec = "mp3"
  if (change === "rotation") result.streams[0].rotation = 90
  if (change === "start") result.streams[1].startTime = 0.5
  if (change === "duration") result.duration = 2
  if (change === "chapter-title") result.chapters[0].title = "Changed"
  if (change === "chapter-time") result.chapters[0].start = 0.3
  if (change === "chapter-missing") result.chapters = []
  if (change === "file-tag") result.tags = {}
  if (change === "disposition") result.streams[0].disposition.default = 0
  expect(() => validateOutput(plan, result, 100)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }))
})
test.each([
  [{ start_time: "0", end_time: "2", tags: { title: "First" } }, true],
  [{ start_time: "0", end_time: "2", tags: { TITLE: "First" } }, true],
  [{ start_time: "0", end_time: "2", tags: { title: "First", language: "eng" } }, false],
  [{ start_time: "2", end_time: "1" }, false], [{ start_time: "0", end_time: "10" }, false],
  [{ start_time: "0", end_time: "2", tags: { title: "x".repeat(257) } }, false],
  [{ start_time: "0", end_time: "2", tags: { title: "a\nb" } }, false], [null, false]
])("chapter normalization validates exact bounded timing/title %p", (chapter, safe) => {
  const metadata = normalizeProbe({ format: { duration: "4" }, streams: [{ index: 0 }], chapters: [chapter] })
  expect(metadata.chaptersCopySafe).toBe(safe)
})
