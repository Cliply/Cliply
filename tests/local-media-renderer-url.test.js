// Exercise real window/IPC/preview modules with Windows path semantics on any
// test host. loadFile below uses Electron 45.2.1's actual legacy URL formatting.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm")
const url = require("node:url")
const { createRequire } = require("node:module")
function setup(root) {
  const main = path.win32.join(root, "resources/app.asar/src/main")
  const frame = { url: "" }, window = { isDestroyed: () => false, webContents: { mainFrame: frame } }
  window.loadURL = jest.fn(async value => { frame.url = new URL(value).href })
  window.loadFile = jest.fn(async file => window.loadURL(url.format({ protocol: "file", slashes: true, pathname: path.win32.resolve(file) })))
  const electron = { app: { quit: jest.fn() }, dialog: { showErrorBox: jest.fn() } }
  function load(relative, directory, overrides = {}) {
    const file = path.resolve(__dirname, "..", relative), localRequire = createRequire(file), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
      module, exports: module.exports, __dirname: directory, URL, Buffer, console,
      process: { platform: "win32", env: { NODE_ENV: "production" }, resourcesPath: path.win32.join(root, "resources") },
      require: name => overrides[name] || (name === "path" || name === "node:path" ? path.win32
        : name === "node:url" ? { ...url, pathToFileURL: value => url.pathToFileURL(value, { windows: true }) }
          : name === "electron" ? electron : localRequire(name))
    }, { filename: file })
    return module.exports
  }
  const preview = load("src/main/services/local-media/preview.js", path.win32.join(main, "services/local-media"))
  const host = load("src/main/window.js", main, { "./services/local-media/preview": preview })
  const ipc = load("src/main/ipc/local-media.js", path.win32.join(main, "ipc"), { "../services/local-media/preview": preview })
  const calls = new Map(), service = { open: jest.fn(async () => ({ cancelled: true })), close: jest.fn(async () => ({})) }
  ipc.registerLocalMedia({ ipcMain: { handle: (name, handler) => calls.set(name, handler) }, service, getWindow: () => window })
  return { frame, window, preview, host, service, electron, open: event => calls.get("media:open")(event || { sender: window.webContents, senderFrame: frame }) }
}

test.each([String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\Cliply`, String.raw`C:\Program Files\Cliply`, String.raw`D:\Cliply # 100%\Русский`])("loads exactly the authorized renderer URL for Windows path %s", async root => {
  const { host, window, frame, preview, open } = setup(root)
  host.loadApplication({ mainWindow: window })
  expect(frame.url).toBe(preview.trustedUrl(false))
  expect((await open()).success).toBe(true)
})

test.each([false, true])("fallback keeps canonical encoding and existing failure behavior (fails: %s)", async fails => {
  const { host, window, preview, electron } = setup(String.raw`C:\Users\RUNNER~1\Cliply 100%`)
  const error = new Error("synthetic load failure")
  window.loadURL.mockRejectedValueOnce(error)
  if (fails) window.loadURL.mockRejectedValueOnce(error)
  const log = jest.spyOn(console, "error").mockImplementation(() => {})
  try {
    host.loadApplication({ mainWindow: window })
    await new Promise(resolve => setImmediate(resolve))
    expect(window.loadURL.mock.calls).toEqual([[preview.trustedUrl(false)], [preview.trustedUrl(false)]])
    expect(electron.app.quit).toHaveBeenCalledTimes(fails ? 1 : 0)
    expect(electron.dialog.showErrorBox).toHaveBeenCalledTimes(fails ? 1 : 0)
  } finally { log.mockRestore() }
})

test("the Windows short-name mismatch is reproduced without broadening accepted URLs", async () => {
  const { host, window, frame, preview, open, service } = setup(String.raw`C:\Users\RUNNER~1\Temp\Cliply`)
  const expected = preview.trustedUrl(false)
  expect(expected).toContain("RUNNER%7E1")
  frame.url = expected.replace("%7E", "~")
  expect((await open()).error.code).toBe("FORBIDDEN")
  expect(service.open).not.toHaveBeenCalled()
  host.loadApplication({ mainWindow: window })
  expect(frame.url).toBe(expected)
  frame.url += "#/media"
  expect((await open()).success).toBe(true)
  for (const bad of [expected + "?query=1", expected + "?", expected.replace("index.html", "other.html"), expected.replace("C:", "D:"), expected.replace("file:///", "file://server/"), "https://example.invalid/", "http://localhost:5173/", expected.replace("%7E", "~")]) {
    frame.url = bad
    expect((await open()).error.code).toBe("FORBIDDEN")
  }
  frame.url = expected
  for (const event of [{ sender: {}, senderFrame: frame }, { sender: window.webContents, senderFrame: { url: expected } }, { sender: window.webContents, senderFrame: null }]) {
    expect((await open(event)).error.code).toBe("FORBIDDEN")
  }
  expect(service.open).toHaveBeenCalledTimes(1)
})
