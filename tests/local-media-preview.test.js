const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { EventEmitter } = require("node:events")
const { MediaPreview, byteRange, trustedUrl, PROOF_HEADER } = require("../src/main/services/local-media/preview")
const { identify, assertUnchanged } = require("../src/main/services/local-media")

let dir, source, preview, window, time
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-preview-test-"))
  const file = path.join(dir, "source.wav")
  await fs.writeFile(file, "0123456789")
  source = { selectedPath: file, identity: await identify(file), dto: { sourceId: "source-id", formatNames: ["wav"], streams: [{ type: "audio", disposition: {} }] } }
  const contents = new EventEmitter()
  Object.assign(contents, {
    id: 17, mainFrame: { url: trustedUrl(false) + "#/media" },
    session: { protocol: { handle: jest.fn(), unhandle: jest.fn() } },
    getLastWebPreferences: () => ({ webSecurity: true, sandbox: true, contextIsolation: true, nodeIntegration: false, allowRunningInsecureContent: false })
  })
  window = { isDestroyed: () => false, webContents: contents }
  time = 100
  preview = new MediaPreview({ getSource: () => source, validate: assertUnchanged, invalidate: () => { source = null }, now: () => time })
  preview.attach(window)
})
afterEach(async () => { preview.revoke(); await fs.rm(dir, { recursive: true, force: true }) })
const request = (url, headers = {}, method = "GET") => new Request(url, { method, headers: { [PROOF_HEADER]: preview.proof, ...headers } })
const details = (url, changes = {}) => ({ url, frame: window.webContents.mainFrame, webContentsId: 17, resourceType: "media", method: "GET", requestHeaders: {}, ...changes })

test.each([
  [null, 10, { start: 0, end: 9, partial: false }],
  ["bytes=2-4", 10, { start: 2, end: 4, partial: true }],
  ["bytes=7-", 10, { start: 7, end: 9, partial: true }],
  ["bytes=-3", 10, { start: 7, end: 9, partial: true }],
  ["bytes=1-999", 10, { start: 1, end: 9, partial: true }],
  ...["bytes=10-", "bytes=9-1", "bytes=-0", "bytes=0-1,3-4", "bytes=", "foo", "bytes=9007199254740992-"].map(v => [v, 10, null])
])("ranges %p", (range, size, expected) => expect(byteRange(range, size)).toEqual(expected))

test("GET/HEAD/ranges return only the registered file with consistent headers", async () => {
  const { url } = await preview.create("source-id")
  const full = await preview.handle(request(url))
  expect(full.status).toBe(200)
  expect(await full.text()).toBe("0123456789")
  expect(full.headers.get("cache-control")).toBe("no-store")
  const range = await preview.handle(request(url, { Range: "bytes=2-4" }))
  expect(range.status).toBe(206)
  expect(range.headers.get("content-range")).toBe("bytes 2-4/10")
  expect(await range.text()).toBe("234")
  const head = await preview.handle(request(url, {}, "HEAD"))
  expect(head.headers.get("content-length")).toBe("10")
  expect(await head.text()).toBe("")
  const bad = await preview.handle(request(url, { Range: "bytes=100-" }))
  expect(bad.status).toBe(416)
  expect(bad.headers.get("content-range")).toBe("bytes */10")
})

test("gate accepts only owning trusted top frame, safe methods and media/fetch", async () => {
  const { url } = await preview.create("source-id")
  expect(preview.authorize(details(url)).requestHeaders[PROOF_HEADER]).toBe(preview.proof)
  for (const changes of [
    { frame: null }, { frame: { url: trustedUrl(false) } }, { webContentsId: 99 },
    { resourceType: "mainFrame" }, { resourceType: "subFrame" }, { resourceType: "script" }, { method: "POST" }
  ]) expect(preview.authorize(details(url, changes))).toEqual({ cancel: true })
  window.webContents.mainFrame.url = "https://www.youtube.com/embed/video"
  expect(preview.authorize(details(url))).toEqual({ cancel: true })
})

test("no gate proof means no bytes; forged proof overwritten; malformed/traversal URLs denied", async () => {
  const { url } = await preview.create("source-id")
  expect((await preview.handle(new Request(url))).status).toBe(403)
  const authorized = preview.authorize(details(url, { requestHeaders: { "X-Cliply-Preview": "forged" } }))
  expect(authorized.requestHeaders).toEqual({ [PROOF_HEADER]: preview.proof })
  for (const bad of [url + "/../secret", url + "?path=/etc/passwd", url + "#extra", url.replace("source", "foreign"), "file:///etc/passwd", "cliply-media://source/%2e%2e%2fetc/passwd"]) {
    expect(preview.authorize(details(bad))).toEqual({ cancel: true })
  }
})

test("revocation, expiry, replacement and old-token cleanup cannot keep stale access", async () => {
  const old = await preview.create("source-id")
  const current = await preview.create("source-id")
  preview.revoke(old.previewId)
  expect(preview.valid(current.url)).toBe(true)
  expect((await preview.handle(request(old.url))).status).toBe(410)
  time = current.expiresAt
  expect(preview.authorize(details(current.url))).toEqual({ cancel: true })
  expect((await preview.handle(request(current.url))).status).toBe(410)
  preview.revoke()
  expect(preview.grant).toBeNull()
})

test.each(["modified", "replaced", "deleted"])("%s original invalidates source before serving bytes", async (change) => {
  const { url } = await preview.create("source-id")
  const file = source.selectedPath
  if (change === "modified") await fs.appendFile(file, "changed")
  if (change === "replaced") { await fs.rename(file, file + ".old"); await fs.writeFile(file, "replacement") }
  if (change === "deleted") await fs.unlink(file)
  expect((await preview.handle(request(url))).status).toBe(410)
  expect(source).toBeNull()
  expect(preview.grant).toBeNull()
})

test("TOCTOU replacement after path validation is caught by descriptor identity", async () => {
  const { url } = await preview.create("source-id")
  const file = source.selectedPath
  preview.validate = async () => { await fs.rename(file, file + ".old"); await fs.writeFile(file, "replacement") }
  expect((await preview.handle(request(url))).status).toBe(410)
})

test("insecure host cannot attach or issue access; missing source cannot be requested", async () => {
  await expect(preview.create("wrong-source")).rejects.toMatchObject({ code: "SOURCE_UNKNOWN" })
  window.webContents.getLastWebPreferences = () => ({ webSecurity: false })
  expect(() => preview.attach(window)).toThrow()
  await expect(preview.create("source-id")).rejects.toMatchObject({ code: "PREVIEW_HOST" })
})

test("navigation, crash and destruction revoke; hash navigation retains the owner", async () => {
  for (const event of ["did-start-navigation", "render-process-gone", "destroyed"]) {
    await preview.create("source-id")
    window.webContents.emit("did-start-navigation", {}, "", true, true)
    expect(preview.grant).not.toBeNull()
    window.webContents.emit(event, {}, "", false, true)
    expect(preview.grant).toBeNull()
  }
  expect(window.webContents.session.protocol.unhandle).toHaveBeenCalledWith("cliply-media")
})

test("a pending acquisition cannot resurrect access after close or supersede a newer request", async () => {
  let resolve
  preview.validate = () => new Promise(r => { resolve = r })
  const pending = preview.create("source-id")
  preview.revoke()
  resolve()
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" })
  expect(preview.grant).toBeNull()
})

test("late failed reads of an old source cannot revoke its replacement", async () => {
  const { url } = await preview.create("source-id")
  let reject
  preview.validate = () => new Promise((_resolve, r) => { reject = r })
  const pending = preview.handle(request(url))
  source = { ...source, dto: { ...source.dto, sourceId: "replacement" } }
  preview.validate = assertUnchanged
  const current = await preview.create("replacement")
  reject(new Error("old source disappeared"))
  expect((await pending).status).toBe(410)
  expect(preview.valid(current.url)).toBe(true)
})

test("revocation destroys every active stream and the concurrency bound refuses excess reads", async () => {
  await fs.writeFile(source.selectedPath, Buffer.alloc(1024 * 1024))
  source.identity = await identify(source.selectedPath)
  const { url } = await preview.create("source-id")
  const responses = []
  for (let i = 0; i < 4; i++) responses.push(await preview.handle(request(url)))
  expect((await preview.handle(request(url))).status).toBe(429)
  const streams = [...preview.streams]
  preview.revoke()
  expect(streams.every(stream => stream.destroyed)).toBe(true)
  await Promise.all(responses.map(response => response.body.cancel().catch(() => {})))
})
