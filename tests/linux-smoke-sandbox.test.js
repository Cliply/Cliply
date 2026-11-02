jest.mock("node:child_process", () => ({ spawnSync: jest.fn() }))
const fs = require("node:fs"), path = require("node:path"), os = require("node:os")
const { spawnSync } = require("node:child_process")
const { prepareLinuxSmokeSandbox } = require("../scripts/prepare-linux-smoke-sandbox")
let scratch, appDir, helper, platform, savedEnv, rootOwned, helperMode
const original = path.resolve(__dirname, "../node_modules/electron/dist/chrome-sandbox")
beforeEach(() => {
  const tmp = fs.realpathSync(os.tmpdir()); jest.spyOn(os, "tmpdir").mockReturnValue(tmp)
  scratch = fs.mkdtempSync(path.join(tmp, "cliply-local-package-")); appDir = path.join(scratch, "app"); fs.mkdirSync(appDir); helper = path.join(appDir, "chrome-sandbox"); fs.writeFileSync(helper, "known Electron helper")
  platform = Object.getOwnPropertyDescriptor(process, "platform"); Object.defineProperty(process, "platform", { value: "linux" })
  savedEnv = [process.env.GITHUB_ACTIONS, process.env.CI]; process.env.GITHUB_ACTIONS = "true"; process.env.CI = "true"
  const read = fs.readFileSync, lstat = fs.lstatSync, stat = fs.statSync
  jest.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => file === original ? Buffer.from("known Electron helper") : read(file, ...args))
  jest.spyOn(fs, "lstatSync").mockImplementation((file, ...args) => file === original ? { isFile: () => true } : lstat(file, ...args))
  jest.spyOn(fs, "statSync").mockImplementation((file, ...args) => file === helper && rootOwned ? { uid: 0, gid: 0, mode: helperMode } : stat(file, ...args))
  rootOwned = false; helperMode = 0o755
  spawnSync.mockReset().mockImplementation((command, args) => {
    if (args[1] === "chown") rootOwned = true
    if (args[1] === "chmod") helperMode = parseInt(args[2], 8)
    return { status: 0 }
  })
})
afterEach(() => {
  Object.defineProperty(process, "platform", platform)
  for (const [index, name] of ["GITHUB_ACTIONS", "CI"].entries()) savedEnv[index] === undefined ? delete process.env[name] : process.env[name] = savedEnv[index]
  jest.restoreAllMocks(); fs.rmSync(scratch, { recursive: true, force: true })
})
test("changes only the owned verified helper and removes SUID on cleanup", () => {
  const cleanup = prepareLinuxSmokeSandbox(scratch, appDir)
  expect(spawnSync.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["sudo", ["-n", "chown", "root:root", "--", helper]], ["sudo", ["-n", "chmod", "4755", "--", helper]]
  ])
  cleanup(); expect(helperMode).toBe(0o755)
})
test("refuses outside CI, redirected app paths and modified Electron helpers before privilege", () => {
  delete process.env.GITHUB_ACTIONS; expect(() => prepareLinuxSmokeSandbox(scratch, appDir)).toThrow(/GitHub/)
  process.env.GITHUB_ACTIONS = "true"; expect(() => prepareLinuxSmokeSandbox(scratch, path.dirname(appDir))).toThrow()
  fs.writeFileSync(helper, "different"); expect(() => prepareLinuxSmokeSandbox(scratch, appDir)).toThrow(/differs/)
  expect(spawnSync).not.toHaveBeenCalled()
})
test("refuses writable scratch or symlink helpers", () => {
  fs.chmodSync(scratch, 0o755); expect(() => prepareLinuxSmokeSandbox(scratch, appDir)).toThrow(/privately owned/)
  fs.chmodSync(scratch, 0o700); fs.renameSync(helper, helper + ".real"); fs.symlinkSync(helper + ".real", helper)
  expect(() => prepareLinuxSmokeSandbox(scratch, appDir)).toThrow(/regular file/); expect(spawnSync).not.toHaveBeenCalled()
})
test("clears SUID if setup verification fails", () => {
  spawnSync.mockImplementation((command, args) => { if (args[1] === "chmod" && args[2] === "0755") helperMode = 0o755; return { status: 0 } })
  expect(() => prepareLinuxSmokeSandbox(scratch, appDir)).toThrow()
  expect(spawnSync.mock.calls.at(-1)[1]).toEqual(["-n", "chmod", "0755", "--", helper])
})
