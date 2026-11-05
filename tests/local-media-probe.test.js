const { EventEmitter } = require("node:events")
const { PassThrough } = require("node:stream")
const { startProbe, normalizeProbe, probeArgs, MAX_STREAMS } = require("../src/main/services/local-media/probe")

const raw = () => ({ format: { duration: "2.5", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }, streams: [
  { index: 3, codec_type: "video", codec_name: "h264", time_base: "1/12800", avg_frame_rate: "25/1", side_data_list: [{ rotation: -90 }] },
  { index: 8, codec_type: "audio", codec_name: "aac", sample_rate: "48000", tags: { language: "rus", title: "alternate" } },
  { index: 12, codec_type: "attachment", codec_name: "ttf" }
], chapters: [{ id: 1 }] })

function fakeProcess() {
  const child = new EventEmitter()
  child.pid = 123
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = jest.fn()
  return child
}

describe("minimal inspection DTO", () => {
  test("keeps actual indexes, unknown stream classes, family names, rotation and chapter presence", () => {
    const result = normalizeProbe(raw())
    expect(result.streams.map((s) => s.index)).toEqual([3, 8, 12])
    expect(result.streams[0]).toMatchObject({ rotation: -90, averageFrameRate: "25/1" })
    expect(result.streams[1]).toMatchObject({ language: "rus", sampleRate: 48000 })
    expect(result.streams[2].type).toBe("attachment")
    expect(result.formatNames).toHaveLength(6)
    expect(result.chapterCount).toBe(1)
  })

  test.each([undefined, null, "N/A", "Infinity", "NaN", "", " ", -1, true])("unusable duration %p stays unknown", (duration) => {
    const input = raw()
    input.format.duration = duration
    input.streams[0].duration = duration
    input.streams[0].avg_frame_rate = "0/0"
    const result = normalizeProbe(input)
    expect(result.duration).toBeNull()
    expect(result.streams[0].duration).toBeNull()
    expect(result.streams[0].averageFrameRate).toBeNull()
  })

  test("bounds metadata and excludes raw filenames/tags/side data", () => {
    const input = raw()
    input.format.filename = "/private/source.mp4"
    input.streams[0].tags = { title: "x".repeat(9000), comment: "/secret" }
    expect(normalizeProbe(input).streams[0].title).toHaveLength(256)
    expect(JSON.stringify(normalizeProbe(input))).not.toMatch(/private|secret/)
  })

  test.each([
    {}, { format: {}, streams: [] }, { format: {}, streams: [{ index: -1 }] },
    { format: {}, streams: [{ index: 1 }, { index: 1 }] },
    { format: {}, streams: [{ index: "1" }] },
    { format: {}, streams: [{ index: 1 }], chapters: {} }
  ])("refuses malformed inventory %p", (input) => {
    expect(() => normalizeProbe(input)).toThrow(expect.objectContaining({ code: "PROBE_JSON" }))
  })

  test("refuses excessive streams or chapters without silently truncating", () => {
    expect(() => normalizeProbe({ format: {}, streams: Array.from({ length: MAX_STREAMS + 1 }, (_, index) => ({ index })) }))
      .toThrow(expect.objectContaining({ code: "PROBE_LIMIT" }))
    expect(() => normalizeProbe({ ...raw(), chapters: Array(513).fill({}) }))
      .toThrow(expect.objectContaining({ code: "PROBE_LIMIT" }))
  })
})

describe("bounded child lifecycle", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test.each(["FFREPORT", "ffreport"])("uses safe argv/protocols and strips inherited %s", async (reportKey) => {
    const child = fakeProcess()
    const spawnProcess = jest.fn(() => child)
    const previous = process.env[reportKey]
    let job
    try {
      process.env[reportKey] = "file=unexpected.log"
      job = startProbe("/helpers/ffprobe", "/media/a 'quoted'.mp4", { spawnProcess })
    } finally {
      if (previous === undefined) delete process.env[reportKey]
      else process.env[reportKey] = previous
    }
    expect(spawnProcess).toHaveBeenCalledWith("/helpers/ffprobe", probeArgs("/media/a 'quoted'.mp4"), expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }))
    expect(Object.keys(spawnProcess.mock.calls[0][2].env).some((key) => key.toUpperCase() === "FFREPORT")).toBe(false)
    expect(probeArgs("x")).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-enable_drefs", "0"]))
    child.stdout.write(JSON.stringify(raw()))
    child.emit("close", 0)
    await expect(job.result).resolves.toMatchObject({ duration: 2.5 })
    await job.closed
    expect(jest.getTimerCount()).toBe(0)
  })

  test.each(["cancel", "timeout", "stdout", "stderr"])("%s stops, escalates, and only settles after close", async (mode) => {
    const child = fakeProcess()
    const job = startProbe("/probe", "/fixture", { spawnProcess: () => child, timeoutMs: 100, maxOutput: 16, maxStderr: 16 })
    const outcome = job.result.catch((error) => error.code)
    let drained = false
    job.closed.then(() => { drained = true })
    if (mode === "cancel") { job.cancel(); job.cancel() }
    if (mode === "timeout") jest.advanceTimersByTime(100)
    if (mode === "stdout") child.stdout.write("x".repeat(17))
    if (mode === "stderr") child.stderr.write("x".repeat(17))
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    jest.advanceTimersByTime(500)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(drained).toBe(false)
    child.emit("close", null, "SIGKILL")
    expect(await outcome).toBe(mode === "cancel" ? "CANCELLED" : mode === "timeout" ? "PROBE_TIMEOUT" : "PROBE_LIMIT")
    await job.closed
    expect(drained).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })

  test("a stuck child reports failure without claiming it drained", async () => {
    const child = fakeProcess()
    const job = startProbe("/probe", "/fixture", { spawnProcess: () => child, timeoutMs: 1 })
    const result = job.result.catch((error) => error.code)
    jest.advanceTimersByTime(3000)
    expect(await result).toBe("PROBE_STUCK")
    expect(job.ended).toBe(false)
    child.emit("close", null)
    await job.closed
    expect(job.ended).toBe(true)
  })

  test.each([[0, "not json", "PROBE_JSON"], [1, "", "PROBE_FAILED"]])("exit %s, malformed output", async (code, output, expected) => {
    const child = fakeProcess()
    const job = startProbe("/probe", "/fixture", { spawnProcess: () => child })
    const result = job.result.catch((error) => error.code)
    child.stdout.write(output)
    child.emit("close", code)
    expect(await result).toBe(expected)
    expect(jest.getTimerCount()).toBe(0)
  })

  test("an executable disappearing between resolve and spawn is a missing-helper error", async () => {
    const child = fakeProcess()
    child.pid = undefined
    const job = startProbe("/probe", "/fixture", { spawnProcess: () => child })
    const result = job.result.catch((error) => error.code)
    child.emit("error", Object.assign(new Error("private path"), { code: "ENOENT" }))
    expect(await result).toBe("PROBE_MISSING")
    await job.closed
    expect(jest.getTimerCount()).toBe(0)
  })
})
