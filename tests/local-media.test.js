const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { LocalMediaService, identify } = require("../src/main/services/local-media")
const { resolveFfprobe, TARGETS } = require("../src/main/services/local-media/paths")
const { normalizeProbe } = require("../src/main/services/local-media/probe")
const { MediaError } = require("../src/main/services/local-media/errors")

let root, sourcePath
const metadata = () => normalizeProbe({ format: { duration: "1" }, streams: [{ index: 4, codec_type: "audio", codec_name: "aac" }] })
const completed = () => ({ ended: true, result: Promise.resolve(metadata()), closed: Promise.resolve(), cancel: jest.fn() })
function service(options = {}) {
  return new LocalMediaService({ selectFile: async () => sourcePath, resolveProbe: async () => "/helpers/ffprobe", runProbe: completed, ...options })
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-local-test-"))
  sourcePath = path.join(root, "original.mp4")
  await fs.writeFile(sourcePath, "synthetic media")
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

test("opening registers a path-free opaque source, distinct capabilities and actual stream IDs", async () => {
  const media = service()
  const result = await media.open()
  expect(result.source.sourceId).toMatch(/^[a-f\d-]{36}$/)
  expect(result.source.streams[0].index).toBe(4)
  expect(result.source.capabilities.probe.status).toBe("available")
  expect(result.source.capabilities.nativePreview.status).toBe("unchecked")
  expect(result.source.capabilities.extractAudio.status).toBe("unavailable")
  expect(JSON.stringify(result)).not.toContain(root)
  expect(await fs.readFile(sourcePath, "utf8")).toBe("synthetic media")
  await media.close()
  expect((await media.getState()).source).toBeNull()
})

test("a cancelled dialog preserves the previously open source and spawns nothing", async () => {
  const selectFile = jest.fn().mockResolvedValueOnce(sourcePath).mockResolvedValueOnce(null)
  const runProbe = jest.fn(completed)
  const media = service({ selectFile, runProbe })
  const original = (await media.open()).source
  expect(await media.open()).toEqual({ cancelled: true, source: null })
  expect((await media.getState()).source).toEqual(original)
  expect(runProbe).toHaveBeenCalledTimes(1)
})

test("closing while a dialog is pending invalidates its eventual selection", async () => {
  let select
  const runProbe = jest.fn(completed)
  const media = service({ selectFile: () => new Promise((r) => { select = r }), runProbe })
  const opening = media.open().catch((error) => error.code)
  await new Promise(setImmediate)
  await expect(media.open()).rejects.toMatchObject({ code: "BUSY" })
  await media.close()
  select(sourcePath)
  expect(await opening).toBe("CANCELLED")
  expect(runProbe).not.toHaveBeenCalled()
})

test("source replacement after probing invalidates the registration even at equal size", async () => {
  const media = service()
  await media.open()
  const replacement = path.join(root, "replacement")
  await fs.writeFile(replacement, "synthetic media")
  await fs.rename(replacement, sourcePath)
  await expect(media.getState()).rejects.toMatchObject({ code: "SOURCE_CHANGED" })
  expect((await media.getState()).source).toBeNull()
})

test("a symlink retargeted while probing cannot register the substituted file", async () => {
  const link = path.join(root, "link.mp4")
  const other = path.join(root, "other.mp4")
  await fs.writeFile(other, "synthetic media")
  await fs.symlink(sourcePath, link)
  const media = service({ selectFile: async () => link, runProbe: () => ({ ...completed(), result: (async () => {
    await fs.unlink(link)
    await fs.symlink(other, link)
    return metadata()
  })() }) })
  await expect(media.open()).rejects.toMatchObject({ code: "SOURCE_CHANGED" })
  expect((await media.getState()).source).toBeNull()
})

test("cancellation waits for a spawned child and prevents a late success registration", async () => {
  let finish
  const result = new Promise((r) => { finish = r })
  const process = { result, ended: false, cancel: jest.fn(), closed: result }
  const media = service({ runProbe: () => process })
  const opening = media.open().catch((error) => error.code)
  while (!media.pending.process) await new Promise(setImmediate)
  let closed = false
  const closing = media.close().then(() => { closed = true })
  await new Promise(setImmediate)
  expect(closed).toBe(false)
  expect(process.cancel).toHaveBeenCalledTimes(1)
  process.ended = true
  finish(metadata())
  await closing
  expect(await opening).toBe("CANCELLED")
  expect((await media.getState()).source).toBeNull()
})

test("failed process drain holds admission until real close", async () => {
  let finish
  const closed = new Promise((r) => { finish = r })
  const process = { result: Promise.reject(new MediaError("PROBE_STUCK")), ended: false, cancel: jest.fn(), closed }
  // Install the rejected result only after the asynchronous source stat.
  process.result.catch(() => {})
  const media = service({ runProbe: () => process })
  await expect(media.open()).rejects.toMatchObject({ code: "PROBE_STUCK" })
  await expect(media.open()).rejects.toMatchObject({ code: "BUSY" })
  await expect(media.close()).rejects.toMatchObject({ code: "PROBE_STUCK" })
  process.ended = true
  finish()
  await closed
  expect(media.pending).toBeNull()
})

test("shutdown freezes admission without touching download services", async () => {
  const media = service()
  await media.shutdown()
  await expect(media.open()).rejects.toMatchObject({ code: "CLOSED" })
})

test.each(["https://example.invalid/media", "//host/share/media", "\\\\host\\share\\media", "relative.mp4", "/dev/null"])("refuses unapproved input %s", async (input) => {
  await expect(identify(input)).rejects.toMatchObject({ code: "SOURCE_INVALID" })
})

test("directories cannot be probed", async () => {
  await expect(identify(root)).rejects.toMatchObject({ code: "SOURCE_INVALID" })
})

test("missing helpers fail before the dialog without a PATH fallback", async () => {
  const selectFile = jest.fn()
  const media = service({ selectFile, resolveProbe: () => resolveFfprobe({ isPackaged: true, resourcesPath: root }) })
  await expect(media.open()).rejects.toMatchObject({ code: "PROBE_MISSING" })
  expect(selectFile).not.toHaveBeenCalled()
})

test.each(Object.keys(TARGETS))("%s resolves the production resource, never the development override", async (target) => {
  const [platform, arch] = target.split("-")
  const binary = path.join(root, "binaries", TARGETS[target].executable)
  await fs.mkdir(path.dirname(binary))
  await fs.writeFile(binary, "fixture", { mode: 0o755 })
  expect(await resolveFfprobe({ isPackaged: true, resourcesPath: root, platform, arch, developmentPath: sourcePath })).toBe(binary)
})

test("development injection must be an absolute executable regular file", async () => {
  await fs.chmod(sourcePath, 0o755)
  expect(await resolveFfprobe({ isPackaged: false, developmentPath: sourcePath })).toBe(sourcePath)
  await expect(resolveFfprobe({ isPackaged: false, developmentPath: "ffprobe" })).rejects.toMatchObject({ code: "PROBE_MISSING" })
  await expect(resolveFfprobe({ isPackaged: false, developmentPath: root })).rejects.toMatchObject({ code: "PROBE_MISSING" })
})

test.each(Object.keys(TARGETS))("%s development path uses the mapped project platform directory", async (target) => {
  const [platform, arch] = target.split("-")
  const { directory, executable } = TARGETS[target]
  const binary = path.join(root, "binaries", directory, executable)
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await fs.writeFile(binary, "fixture", { mode: 0o755 })
  expect(await resolveFfprobe({ isPackaged: false, projectRoot: root, platform, arch })).toBe(binary)
})
