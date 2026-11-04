jest.mock("node:child_process", () => ({ spawnSync: jest.fn() }))
jest.mock("../scripts/verify-packaged-helpers", () => ({ verifyPackagedHelpers: jest.fn(async () => {}) }))
const fs = require("node:fs"), path = require("node:path"), os = require("node:os")
const { spawnSync } = require("node:child_process")
const { run } = require("../scripts/smoke-packaged-local-media")
let root, resources, scratch, platform, remove
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-smoke-cleanup-test-"))
  resources = path.join(root, "app", "resources"); fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(resources, "app.asar"), "synthetic archive")
  for (const exe of ["Cliply.exe", "cliply-desktop"]) fs.writeFileSync(path.join(root, "app", exe), "synthetic launcher")
  scratch = path.join(root, "owned-copy")
  jest.spyOn(fs, "mkdtempSync").mockImplementation(() => { fs.mkdirSync(scratch); return scratch })
  platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32" })
  remove = fs.rmSync.bind(fs)
  spawnSync.mockReset().mockReturnValue({ status: 0, stdout: "Normal service startup passed:" })
  jest.spyOn(process.stdout, "write").mockImplementation(() => true)
  jest.spyOn(process.stderr, "write").mockImplementation(() => true)
  jest.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  Object.defineProperty(process, "platform", platform)
  jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true })
})
test.each(["win32", "linux"])("bounds cleanup retries for owned copy on %s after child return", async host => {
  Object.defineProperty(process, "platform", { value: host })
  const github = process.env.GITHUB_ACTIONS
  delete process.env.GITHUB_ACTIONS
  const rm = jest.spyOn(fs, "rmSync").mockImplementation((file, options) => {
    expect(spawnSync).toHaveBeenCalledTimes(1)
    return remove(file, options)
  })
  try {
    await run(resources, { normalStartup: true })
    expect(rm).toHaveBeenCalledWith(scratch, { recursive: true, force: true, maxRetries: host === "win32" ? 5 : 0, retryDelay: 100 })
    expect(fs.existsSync(scratch)).toBe(false)
    expect(fs.existsSync(path.join(resources, "app.asar"))).toBe(true)
  } finally { if (github !== undefined) process.env.GITHUB_ACTIONS = github }
})
test("reports persistent cleanup failure without masking the startup failure", async () => {
  spawnSync.mockReturnValue({ status: 1, stdout: "", error: new Error("startup seeding failed") })
  const cleanup = Object.assign(new Error("locked image"), { code: "EBUSY" })
  jest.spyOn(fs, "rmSync").mockImplementation(() => { throw cleanup })
  const report = jest.spyOn(console, "error").mockImplementation(() => {})
  await expect(run(resources, { normalStartup: true })).rejects.toThrow("startup seeding failed")
  expect(report).toHaveBeenCalledWith("Packaged smoke cleanup failed:", cleanup)
})
test("persistent cleanup failure fails an otherwise successful smoke", async () => {
  const cleanup = Object.assign(new Error("locked image"), { code: "EBUSY" })
  jest.spyOn(fs, "rmSync").mockImplementation(() => { throw cleanup })
  await expect(run(resources, { normalStartup: true })).rejects.toMatchObject({ message: "Packaged smoke cleanup failed", errors: [cleanup] })
})
test.each(["stdout", "stderr"])("a shutdown diagnostic in %s fails even with a success marker and exit zero", async stream => {
  const result = { status: 0, stdout: "Normal service startup passed:", stderr: "" }
  result[stream] += "\nError during shutdown: TypeError: cleanup is not a function"
  spawnSync.mockReturnValue(result)
  await expect(run(resources, { normalStartup: true })).rejects.toThrow("packaged app reported a shutdown failure")
  expect(fs.existsSync(scratch)).toBe(false)
})

test("installed-payload checks launch with an owned empty PATH and no inherited Path alias", async () => {
  const inherited = process.env.Path
  process.env.Path = "C:\\developer helpers"
  try {
    await run(resources, { normalStartup: true, isolatedPath: true })
    const environment = spawnSync.mock.calls[0][2].env
    expect(Object.keys(environment).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"])
    expect(environment.PATH).toBe(path.join(scratch, "empty-path"))
    expect(environment.CLIPLY_DEV_FFPROBE).toBeUndefined()
  } finally { inherited === undefined ? delete process.env.Path : process.env.Path = inherited }
})
