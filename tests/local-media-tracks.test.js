const fs = require("node:fs/promises")
const syncFs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { planTracks, planExport, trackRemovalProfile, exportArgs, validateOutput } = require("../src/main/services/local-media/export-plan")
const { normalizeProbe } = require("../src/main/services/local-media/probe")
const { LocalExport } = require("../src/main/services/local-media/export")
const { identify, assertUnchanged } = require("../src/main/services/local-media")

const video = { index: 3, type: "video", codec: "h264", pixelFormat: "yuv420p", width: 320, height: 180, duration: 4, title: null, language: "und", rotation: 90, disposition: { default: 1 }, tags: {} }
const audio = { index: 7, type: "audio", codec: "aac", profile: "LC", sampleRate: 44100, channels: 1, duration: 4, title: "Russian", language: "rus", disposition: { default: 1 }, tags: { handler_name: "Russian" } }
const subtitle = { index: 11, type: "subtitle", codec: "mov_text", title: "Captions", language: "eng", disposition: { default: 1, forced: 1 }, tags: {} }
let source
beforeEach(() => { source = { sourceId: "11111111-1111-4111-8111-111111111111", filename: "fixture.mp4", majorBrand: "isom", formatNames: ["mov", "mp4"], duration: 4, tags: { title: "Synthetic", artist: "Cliply", comment: "Fixture" }, chapterCount: 0, streams: structuredClone([video, audio, subtitle]) } })
const request = (indexes = [3, 7, 11], extra = {}) => ({ operation: "removeTracks", sourceId: source.sourceId, streamIndexes: indexes, removeChapters: false, ...extra })
const output = plan => ({ formatNames: ["mov", "mp4"], majorBrand: "isom", duration: 4, chapterCount: 0, tags: { ...source.tags }, streams: plan.expectedStreams.map((stream, index) => ({ ...structuredClone(stream), index })) })

test("actual indexes are canonicalized, metadata/dispositions use output indexes, and no trim/conversion enters argv", () => {
  const plan = planExport(source, request([11, 3]))
  expect(plan).toMatchObject({ operation: "removeTracks", streamIndexes: [3, 11], removedStreamIndexes: [7], extension: "mp4" })
  const args = exportArgs(plan)
  expect(args.filter((_value, i) => args[i - 1] === "-map")).toEqual(["0:3", "0:11"])
  expect(args).toEqual(expect.arrayContaining(["-c", "copy", "-map_metadata:s:1", "0:s:11", "-disposition:1", "default+forced", "title=Captions", "-map_chapters", "-1"]))
  for (const forbidden of ["-ss", "-t", "-y", "libx264", "-af", "-vf"]) expect(args).not.toContain(forbidden)
  expect(() => validateOutput(plan, output(plan), 100)).not.toThrow()
})
test.each([{}, { streamIndexes: [3, 3] }, { streamIndexes: [-1] }, { streamIndexes: [999] }, { streamIndexes: ["3"] }, { removeChapters: "yes" }, { extension: "mkv" }, { argv: [] }, { operation: "remux" }])("strict request rejects %p", patch => {
  const invalid = Object.keys(patch).length ? { ...request(), ...patch } : {}
  expect(() => planTracks(source, invalid)).toThrow()
})
test.each([[[]], [[11]]])("requires playable output for %p", indexes => { expect(() => planTracks(source, request(indexes))).toThrow(expect.objectContaining({ code: "TRACK_EMPTY" })) })
test.each([
  { type: "attachment", codec: "ttf" }, { type: "data", codec: "bin_data" },
  { ...video, codec: "mjpeg", disposition: { attached_pic: 1 } }, { ...audio, codec: "opus" },
  { ...video, codec: "hevc" }, { ...video, pixelFormat: "yuv420p10le" },
  { ...video, colorTransfer: "smpte2084" }, { ...video, hasHdrMetadata: true },
  { ...audio, disposition: { default: 1, hearing_impaired: 1 } }, { ...audio, titleCopySafe: false }
])("unsupported stream remains in inventory and requires deliberate removal: %p", extra => {
  source.streams.push({ ...extra, index: 15 })
  expect(trackRemovalProfile(source).supportedStreamIndexes).not.toContain(15)
  expect(() => planTracks(source, request([3, 7, 11, 15]))).toThrow(expect.objectContaining({ code: "TRACK_UNSUPPORTED" }))
  expect(planTracks(source, request()).removedStreamIndexes).toEqual([15])
})
test("chapter omission needs explicit consent, and subtitles alone do not count as playable", () => {
  source.chapterCount = 2
  expect(() => planTracks(source, request())).toThrow(expect.objectContaining({ code: "TRACK_CHAPTERS" }))
  expect(planTracks(source, request([3], { removeChapters: true })).removeChapters).toBe(true)
})
test("same-container identification checks extension and brand, never the first FFprobe family label alone", () => {
  source.filename = "renamed.mov"
  expect(trackRemovalProfile(source)).toBeNull()
  expect(() => planTracks(source, request())).toThrow(expect.objectContaining({ code: "TRACK_CONTAINER" }))
  source.majorBrand = "qt"
  expect(planTracks(source, request()).extension).toBe("mov")
})
test("MOV family refuses implicit default promotion; MKV preserves zero/forced flags with passthrough", () => {
  source.streams[1].disposition = { default: 0 }
  expect(() => planTracks(source, request([3, 7]))).toThrow(expect.objectContaining({ code: "TRACK_DEFAULT" }))
  source.filename = "fixture.mkv"; source.formatNames = ["matroska", "webm"]; source.streams[0].rotation = 0
  const plan = planTracks(source, request([7]))
  expect(exportArgs(plan)).toEqual(expect.arrayContaining(["-disposition:0", "0", "-default_mode", "passthrough"]))
  source.streams[0].rotation = 90
  expect(() => planTracks(source, request([3]))).toThrow(expect.objectContaining({ code: "TRACK_UNSUPPORTED" }))
})
test("audio-only verified MP4 profile is allowed, but retaining two videos is refused", () => {
  expect(planTracks(source, request([7])).expectedStreams).toHaveLength(1)
  source.streams.push({ ...video, index: 15 })
  expect(() => planTracks(source, request([3, 15]))).toThrow(expect.objectContaining({ code: "TRACK_VIDEO_LIMIT" }))
})
test.each(["language", "title", "rotation", "disposition", "unexpected-disposition", "codec", "tags", "duration", "chapters", "extra-stream"]) ("output validation refuses changed %s", change => {
  const plan = planTracks(source, request()); const result = output(plan)
  if (change === "language") result.streams[1].language = "eng"
  if (change === "title") result.streams[1].title = "Other"
  if (change === "rotation") result.streams[0].rotation = 0
  if (change === "disposition") result.streams[2].disposition.forced = 0
  if (change === "unexpected-disposition") result.streams[0].disposition.attached_pic = 1
  if (change === "codec") result.streams[1].codec = "mp3"
  if (change === "tags") result.tags.artist = "Other"
  if (change === "duration") result.duration = 1
  if (change === "chapters") result.chapterCount = 1
  if (change === "extra-stream") result.streams.push({ ...audio, index: 3 })
  expect(() => validateOutput(plan, result, 100)).toThrow(expect.objectContaining({ code: "OUTPUT_INVALID" }))
})
test("probe keeps a bounded ordinary-tag inventory, detects unsafe title rewriting and preserves display rotation", () => {
  const result = normalizeProbe({ format: { duration: "4", format_name: "mov,mp4", tags: { major_brand: "qt  ", title: "Fixture", ARTIST: "Cliply", SECRET: "not-in-dto" } }, streams: [{ index: 0, codec_type: "video", tags: { name: "x".repeat(300) }, side_data_list: [{ rotation: 90 }, { side_data_type: "Mastering display metadata" }] }] })
  expect(result).toMatchObject({ majorBrand: "qt", tags: { title: "Fixture", artist: "Cliply" }, streams: [{ titleCopySafe: false, rotation: 90, hasHdrMetadata: true }] })
  expect(result.streams[0].title).toHaveLength(256)
  expect(result.tags.SECRET).toBeUndefined()
})

test("track copies reuse reservation, cancellation and collision protection without changing source data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-tracks-test-"))
  try {
    const sourcePath = path.join(directory, "source.mp4"); await fs.writeFile(sourcePath, "untouched")
    const owned = { selectedPath: sourcePath, identity: await identify(sourcePath), dto: source }
    const final = path.join(directory, "copy.mp4")
    const finished = data => ({ result: Promise.resolve(data), closed: Promise.resolve(), ended: true, cancel() {} })
    const service = new LocalExport({ getSource: () => owned, validateSource: assertUnchanged, isInspecting: () => false,
      storagePath: path.join(directory, "state"), selectDestination: async () => final, resolveFfmpeg: async () => process.execPath, resolveProbe: async () => process.execPath,
      runProcess: (_exe, _args, { outputFd }) => { syncFs.writeSync(outputFd, "copy"); return finished() },
      runProbe: () => finished(output(planTracks(source, request([3])))) })
    let plan = (await service.prepare(request([3]))).plan
    const ack = service.start(plan.planId)
    expect(ack.job).toMatchObject({ operation: "removeTracks", state: "reserved" })
    service.cancel(ack.job.jobId); await service.active.done
    expect(service.job.state).toBe("cancelled"); await expect(fs.stat(final)).rejects.toMatchObject({ code: "ENOENT" })
    plan = (await service.prepare(request([3]))).plan
    const publish = service.output.publish.bind(service.output)
    service.output.publish = async record => { await fs.writeFile(final, "someone else's file"); return publish(record) }
    service.start(plan.planId); await service.active.done
    expect(service.job).toMatchObject({ state: "failed", error: "OUTPUT_EXISTS" })
    expect(await fs.readFile(final, "utf8")).toBe("someone else's file")
    expect(await fs.readFile(sourcePath, "utf8")).toBe("untouched")
    expect(service.getSource()).toBe(owned)
    await service.drain()
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
