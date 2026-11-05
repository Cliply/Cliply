const { PassThrough } = require("node:stream")
const { EventEmitter } = require("node:events")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
jest.mock("node:child_process", () => ({ spawn: jest.fn() }))
const { spawn } = require("node:child_process")
const { CompatibilityPlayer } = require("../src/main/services/local-media/compatibility-player")
const { identify } = require("../src/main/services/local-media")
let directory, source, player, children
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-compat-test-"))
  const file = path.join(directory, "source.mov"); await fs.writeFile(file, "original")
  source = { identity: await identify(file), dto: { sourceId: "source", duration: 12, streams: [
    { index: 3, type: "video", disposition: {} }, { index: 7, type: "audio", channels: 2, disposition: { default: 1 } }
  ] } }
  children = []
  spawn.mockImplementation(() => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.send = jest.fn(() => { child.emit("close", 0); child.stdout.end() })
    children.push(child)
    queueMicrotask(() => child.stdout.write(Buffer.from("fragment")))
    return child
  })
  player = new CompatibilityPlayer({ getSource: () => source, validate: async () => {}, resolveFfmpeg: async () => "/bundled/ffmpeg", isFrozen: () => false })
})
afterEach(async () => { await player.drain(); await fs.rm(directory, { recursive: true, force: true }); jest.clearAllMocks() })

test("opaque source requests use upstream fragmented MP4 graph; reads are pull-based and cancellation drains", async () => {
  const session = await player.start({ sourceId: "source", seekTo: 3 })
  const args = JSON.parse(spawn.mock.calls[0][1][2])
  expect(args).toEqual(expect.arrayContaining(["-ss", "3", "libx264", "ultrafast", "zerolatency", "-crf", "10", "-g", "1", "+frag_keyframe+empty_moov+default_base_moof"]))
  expect(args[args.indexOf("-filter_complex") + 1]).toContain("[0:3]fps=30,scale=800:800")
  expect(args[args.indexOf("-filter_complex") + 1]).toContain("[0:7]anull[audio]")
  expect(args).not.toContain(source.identity.realPath)
  expect(Buffer.from(await player.read(session.sessionId)).toString()).toBe("fragment")
  const pending = player.read(session.sessionId)
  await new Promise(resolve => setImmediate(resolve))
  await expect(player.read(session.sessionId)).rejects.toMatchObject({ code: "BUSY" })
  await player.stop(session.sessionId)
  expect(await pending).toBeNull()
  expect(player.jobs.size).toBe(0)
  expect(children[0].send).toHaveBeenCalledWith({ cancel: true }, expect.any(Function))
})
test.each([{ sourceId: "other", seekTo: 0 }, { sourceId: "source", seekTo: -1 }, { sourceId: "source", seekTo: 12 }, { sourceId: "source", seekTo: NaN }, { sourceId: "source", seekTo: 1, path: "/private" }])("rejects unregistered sources and arbitrary arguments %p", async request => {
  await expect(player.start(request)).rejects.toBeTruthy()
  expect(spawn).not.toHaveBeenCalled()
})
test("source replacement during helper resolution cannot launch a stale process", async () => {
  player.resolveFfmpeg = async () => { source = null; return "/bundled/ffmpeg" }
  await expect(player.start({ sourceId: "source", seekTo: 0 })).rejects.toMatchObject({ code: "CANCELLED" })
  expect(spawn).not.toHaveBeenCalled()
})
test("a read after source replacement stops its helper instead of leaking a decoder", async () => {
  const session = await player.start({ sourceId: "source", seekTo: 0 })
  source = null
  await expect(player.read(session.sessionId)).rejects.toMatchObject({ code: "SOURCE_UNKNOWN" })
  expect(player.jobs.size).toBe(0)
})
test("decoder failure after the first chunk is an error, not successful EOF", async () => {
  const session = await player.start({ sourceId: "source", seekTo: 0 })
  await player.read(session.sessionId)
  children[0].emit("close", 1); children[0].stdout.end()
  await expect(player.read(session.sessionId)).rejects.toMatchObject({ code: "PREVIEW_UNAVAILABLE" })
  expect(player.jobs.size).toBe(0)
})
