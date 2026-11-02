const path = require("node:path")
const fs = require("node:fs")
const vm = require("node:vm")
const { pathToFileURL } = require("node:url")
const { registerLocalMedia } = require("../src/main/ipc/local-media")
const { MediaError } = require("../src/main/services/local-media/errors")

function setup() {
  const calls = new Map()
  const ipcMain = { handle: (name, fn) => calls.set(name, fn), removeHandler: (name) => calls.delete(name) }
  const frame = { url: pathToFileURL(path.resolve(__dirname, "../src/main/renderer/dist/index.html")).href + "#/" }
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } }
  const event = { sender: window.webContents, senderFrame: frame }
  const service = {
    preview: { create: jest.fn(async () => ({ url: "opaque" })), revoke: jest.fn() },
    open: jest.fn(async () => ({ cancelled: true, source: null })),
    getState: jest.fn(async () => ({ source: null, busy: false })), close: jest.fn(async () => ({ closed: true }))
  }
  const cleanup = registerLocalMedia({ ipcMain, service, getWindow: () => window })
  return { calls, event, window, service, cleanup }
}

test("main-frame open, state and close expose only the narrow contract; cleanup removes handlers", async () => {
  const { calls, event, cleanup } = setup()
  expect(await calls.get("media:open")(event)).toEqual({ success: true, data: { cancelled: true, source: null } })
  expect(await calls.get("media:get-state")(event)).toEqual({ success: true, data: { source: null, busy: false } })
  expect(await calls.get("media:close")(event)).toEqual({ success: true, data: { closed: true } })
  cleanup()
  expect(calls.size).toBe(0)
})

test("preview bridge validates opaque IDs and owning sender; arbitrary paths never reach the service", async () => {
  const { calls, event, service } = setup()
  const id = "11111111-1111-4111-8111-111111111111"
  expect((await calls.get("media:preview")(event, id)).success).toBe(true)
  expect(service.preview.create).toHaveBeenCalledWith(id)
  expect((await calls.get("media:release-preview")(event, "a".repeat(64))).success).toBe(true)
  expect(service.preview.revoke).toHaveBeenCalledWith("a".repeat(64))
  for (const payload of ["/private/file", {}, null, "cliply-media://source/token", "../a", "a".repeat(9999)]) {
    for (const channel of ["media:preview", "media:release-preview"]) {
      expect((await calls.get(channel)(event, payload)).error.code).toBe("REQUEST_INVALID")
    }
  }
  expect((await calls.get("media:preview")(event, id, "extra")).error.code).toBe("REQUEST_INVALID")
  event.senderFrame = { url: event.senderFrame.url }
  expect((await calls.get("media:preview")(event, id)).error.code).toBe("FORBIDDEN")
  expect((await calls.get("media:release-preview")(event, "a".repeat(64))).error.code).toBe("FORBIDDEN")
  expect(service.preview.create).toHaveBeenCalledTimes(1)
})

test.each(["foreign window", "iframe", "missing frame", "foreign URL"])("rejects %s before opening a dialog", async (kind) => {
  const { calls, event, service } = setup()
  if (kind === "foreign window") event.sender = {}
  if (kind === "iframe") event.senderFrame = { url: event.senderFrame.url }
  if (kind === "missing frame") event.senderFrame = null
  if (kind === "foreign URL") event.senderFrame.url = "https://example.invalid/"
  expect(await calls.get("media:open")(event)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } })
  expect(service.open).not.toHaveBeenCalled()
})

test.each(["/private/file.mp4", { path: "/private/file.mp4" }, { argv: ["-i", "https://example.invalid"] }, null])("rejects renderer arguments %p", async (payload) => {
  const { calls, event, service } = setup()
  expect(await calls.get("media:open")(event, payload)).toMatchObject({ success: false, error: { code: "REQUEST_INVALID" } })
  expect(service.open).not.toHaveBeenCalled()
})

test("navigation during a probe discards its reply and closes the registration", async () => {
  const { calls, event, service } = setup()
  service.open.mockImplementation(async () => {
    event.senderFrame.url = "https://example.invalid/"
    return { source: { filename: "private.mp4" } }
  })
  const reply = await calls.get("media:open")(event)
  expect(reply.error.code).toBe("FORBIDDEN")
  expect(service.close).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(reply)).not.toContain("private.mp4")
})

test("expected failures carry stable codes; unexpected errors cannot leak helper diagnostics/paths", async () => {
  const { calls, event, service } = setup()
  service.open.mockRejectedValueOnce(new MediaError("PROBE_MISSING")).mockRejectedValueOnce(new Error("/Users/private/cookies"))
  expect((await calls.get("media:open")(event)).error.code).toBe("PROBE_MISSING")
  expect(JSON.stringify(await calls.get("media:open")(event))).not.toContain("/Users/private")
})

test("real preload forwards no path/argv input through its media methods", async () => {
  let api
  const invoke = jest.fn(async () => ({ success: true, data: {} }))
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../src/preload/preload.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { if (name === "electronAPI") api = value } }, ipcRenderer: { invoke, on: jest.fn() } }),
    process: { platform: "darwin", versions: {} }, console, window: { addEventListener: jest.fn() }
  })
  await api.media.open({ path: "/unapproved" })
  await api.media.getState()
  await api.media.close()
  expect(invoke.mock.calls).toEqual([["media:open", undefined], ["media:get-state", undefined], ["media:close", undefined]])
  expect(Object.keys(api.media)).toEqual(["open", "getState", "preview", "releasePreview", "close"])
})
