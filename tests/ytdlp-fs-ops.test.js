jest.mock("node:timers/promises", () => ({ setTimeout: jest.fn(() => Promise.resolve()) }))
const fs = require("fs")
const os = require("os")
const path = require("path")
const { setTimeout: delay } = require("node:timers/promises")
const { swapDirectories } = require("../src/main/services/ytdlp/fs-ops")
const { OperationGate } = require("../src/main/services/ytdlp-engine")
const { YtdlpUpdater } = require("../src/main/services/ytdlp-updater")
let root, prepared, installed, platform, rename
const lock = code => Object.assign(new Error(code), { code })
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-swap-"))
  prepared = path.join(root, "prepared"); installed = path.join(root, "installed")
  for (const [dir, content] of [[prepared, "new"], [installed, "old"]]) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "payload"), content)
  }
  platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32" })
  rename = fs.promises.rename.bind(fs.promises)
  delay.mockReset().mockResolvedValue()
})
afterEach(() => {
  Object.defineProperty(process, "platform", platform)
  jest.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

test.each(["EPERM", "EBUSY"])("retries transient %s on retire and installation, preserving the old payload until publication", async code => {
  const attempts = new Map()
  jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    attempts.set(from, (attempts.get(from) || 0) + 1)
    if (from === prepared) {
      const retired = fs.readdirSync(root).find(name => name.startsWith("installed.retired-"))
      expect(fs.readFileSync(path.join(root, retired, "payload"), "utf8")).toBe("old")
    }
    if (attempts.get(from) === 1) throw lock(code)
    return rename(from, to)
  })
  await swapDirectories(prepared, installed)
  expect(fs.readFileSync(path.join(installed, "payload"), "utf8")).toBe("new")
  expect(fs.readdirSync(root)).toEqual(["installed"])
  expect(delay.mock.calls).toEqual([[100], [100]])
})

test.each([["darwin", "EPERM"], ["linux", "EBUSY"], ["win32", "EIO"], ["win32", "EACCES"]])("does not retry %s/%s", async (host, code) => {
  Object.defineProperty(process, "platform", { value: host })
  const error = lock(code)
  const spy = jest.spyOn(fs.promises, "rename").mockRejectedValue(error)
  await expect(swapDirectories(prepared, installed)).rejects.toBe(error)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(delay).not.toHaveBeenCalled()
  expect(fs.readFileSync(path.join(installed, "payload"), "utf8")).toBe("old")
})

test("exhausted installation retries restore the old engine, including a transient rollback lock", async () => {
  const error = lock("EPERM")
  let installs = 0, restores = 0
  jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    if (from === prepared) { installs++; throw error }
    if (from.includes(".retired-") && ++restores === 1) throw lock("EBUSY")
    return rename(from, to)
  })
  await expect(swapDirectories(prepared, installed)).rejects.toBe(error)
  expect(installs).toBe(6); expect(restores).toBe(2)
  expect(delay.mock.calls).toEqual([[100], [200], [300], [400], [500], [100]])
  expect(fs.readFileSync(path.join(installed, "payload"), "utf8")).toBe("old")
  expect(fs.readFileSync(path.join(prepared, "payload"), "utf8")).toBe("new")
})

test("exhausted rollback keeps the retired payload and recovery metadata", async () => {
  const error = lock("EPERM")
  let restores = 0
  jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    if (from === prepared) throw error
    if (from.includes(".retired-")) { restores++; throw lock("EBUSY") }
    return rename(from, to)
  })
  await expect(swapDirectories(prepared, installed)).rejects.toBe(error)
  expect(restores).toBe(6)
  expect(error.restoreError).toBe("EBUSY")
  expect(fs.readFileSync(path.join(error.retiredDir, "payload"), "utf8")).toBe("old")
  expect(fs.existsSync(installed)).toBe(false)
})

test.each([false, true])("seeding keeps download admission blocked through retries (exhausted=%s)", async exhausted => {
  fs.rmSync(installed, { recursive: true })
  fs.writeFileSync(path.join(prepared, "yt-dlp.exe"), "synthetic engine")
  const gate = new OperationGate()
  const engine = {
    gate, getEngineDir: () => root, getInstalledEngineDir: () => installed,
    getBundledEngineDir: () => prepared, invalidateVersion: jest.fn(),
    probeVersion: jest.fn(async () => "2026.09.01"), rememberVersion: jest.fn()
  }
  let resume, entered
  const waiting = new Promise(resolve => { entered = resolve })
  delay.mockImplementationOnce(() => new Promise(resolve => { resume = resolve; entered() }))
  let attempts = 0
  jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    if (from.includes(".seeding-") && (++attempts === 1 || exhausted)) throw lock("EPERM")
    return rename(from, to)
  })
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {})
  const updater = new YtdlpUpdater({ engine })
  const seeding = updater.seed()
  await waiting
  let admitted = false
  const reading = gate.acquireRead().then(release => { admitted = true; return release })
  await Promise.resolve()
  expect(admitted).toBe(false)
  expect(updater.updating).toBe(true)
  expect(await updater.seed()).toEqual({ seeded: false, reason: "busy" })
  expect(engine.probeVersion).toHaveBeenCalledTimes(1)
  resume()
  const result = await seeding
  expect(result.seeded).toBe(!exhausted)
  if (exhausted) { expect(result.reason).toBe("swap-failed"); expect(warning).toHaveBeenCalled() }
  expect(attempts).toBe(exhausted ? 6 : 2)
  const release = await reading
  expect(admitted).toBe(true); expect(updater.updating).toBe(false)
  release()
})
