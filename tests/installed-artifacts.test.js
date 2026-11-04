jest.mock("node:child_process", () => ({ spawnSync: jest.fn() }))
const fs = require("node:fs"), path = require("node:path"), os = require("node:os")
const { spawnSync } = require("node:child_process")
const metadata = require("../package.json")
const { assertDisposableRunner, installerArtifacts, nsisArguments, payloadIdentity, withInstalledArtifact } = require("../scripts/smoke-installed-artifacts")
let root, savedEnv
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-installer-unit-"))
  savedEnv = [process.env.GITHUB_ACTIONS, process.env.CI]
  spawnSync.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" })
  jest.spyOn(process.stdout, "write").mockImplementation(() => true)
  jest.spyOn(process.stderr, "write").mockImplementation(() => true)
})
afterEach(() => {
  for (const [index, key] of ["GITHUB_ACTIONS", "CI"].entries()) savedEnv[index] === undefined ? delete process.env[key] : process.env[key] = savedEnv[index]
  jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true })
})
test("refuses installation outside disposable CI before invoking host tools", () => {
  delete process.env.GITHUB_ACTIONS; process.env.CI = "true"
  expect(assertDisposableRunner).toThrow(/GitHub/)
  process.env.GITHUB_ACTIONS = "true"; delete process.env.CI
  expect(assertDisposableRunner).toThrow(/CI-only/)
  expect(spawnSync).not.toHaveBeenCalled()
})
test("selects exactly the current Setup installer and refuses stale artifacts", () => {
  for (const name of [`Cliply.Setup.${metadata.version}.exe`, `Cliply.${metadata.version}.exe`, "Cliply.Setup.0.0.0.exe"]) fs.writeFileSync(path.join(root, name), "")
  expect(installerArtifacts(root, "win32")).toEqual([{ kind: "nsis", file: path.join(root, `Cliply.Setup.${metadata.version}.exe`) }])
  fs.rmSync(path.join(root, `Cliply.Setup.${metadata.version}.exe`))
  fs.writeFileSync(path.join(root, `Cliply.Setup.${metadata.version}1.exe`), "")
  expect(() => installerArtifacts(root, "win32")).toThrow(/expected one current nsis/)
  expect(() => installerArtifacts(root, "darwin")).toThrow(/expected one current dmg/)
})
test("NSIS install/uninstall retain a final unquoted absolute path containing spaces", () => {
  const directory = "C:\\runner temp\\owned\\Installed App"
  expect(nsisArguments(directory)).toEqual(["/S", "/currentuser", `/D=${directory}`])
  expect(nsisArguments(directory, true)).toEqual(["/S", "/currentuser", `_?=${directory}`])
  expect(() => nsisArguments("relative\\app")).toThrow(/absolute/)
  expect(() => nsisArguments('C:\\temp\\"app"')).toThrow(/delimiters/)
})
test("installer identity binds helpers, ASAR and source notices to their exact bytes", async () => {
  fs.mkdirSync(path.join(root, "binaries"))
  fs.mkdirSync(path.join(root, "third-party", "ffprobe"), { recursive: true })
  fs.writeFileSync(path.join(root, "app.asar"), "actual archive")
  fs.writeFileSync(path.join(root, "binaries", "ffprobe"), "signed helper")
  fs.writeFileSync(path.join(root, "third-party", "ffprobe", "SOURCE.json"), "source record")
  const before = await payloadIdentity(root)
  expect(Object.keys(before)).toEqual(["app.asar", "binaries/ffprobe", "third-party/ffprobe/SOURCE.json"])
  fs.writeFileSync(path.join(root, "binaries", "ffprobe"), "other helper")
  const after = await payloadIdentity(root)
  expect(after["binaries/ffprobe"].sha256).not.toBe(before["binaries/ffprobe"].sha256)
  expect(after["app.asar"]).toEqual(before["app.asar"])
})
test("DMG verification uses the mounted final artifact and detaches after failed validation", async () => {
  const file = path.join(root, "final.dmg")
  spawnSync.mockImplementation((executable, args) => {
    if (executable === "hdiutil" && args[0] === "attach") fs.mkdirSync(path.join(args[4], "Cliply.app"))
    return { status: 0, stdout: "", stderr: "" }
  })
  const verify = jest.fn(async resources => {
    expect(resources).toBe(path.join(root, "dmg", "Installed App", "Cliply.app", "Contents", "Resources"))
    throw new Error("helper differs")
  })
  await expect(withInstalledArtifact({ kind: "dmg", file }, root, verify)).rejects.toThrow("helper differs")
  expect(spawnSync.mock.calls[0][1]).toEqual(["attach", "-readonly", "-nobrowse", "-mountpoint", path.join(root, "dmg", "mounted"), file])
  expect(spawnSync.mock.calls.at(-1)[1]).toEqual(["detach", path.join(root, "dmg", "mounted")])
})
test("DEB validation purges an actual installation after verification fails", async () => {
  let installed = false
  const exists = fs.existsSync.bind(fs)
  jest.spyOn(fs, "existsSync").mockImplementation(file => String(file).startsWith("/opt/Cliply") || file === "/usr/bin/cliply-desktop" ? false : exists(file))
  spawnSync.mockImplementation((executable, args) => {
    if (executable === "dpkg-deb") return { status: 0, stdout: metadata.name }
    if (executable === "dpkg-query") return { status: installed ? 0 : 1, stdout: installed ? "installed" : "" }
    if (executable === "sudo" && args.includes("install")) installed = true
    if (executable === "sudo" && args.includes("purge")) installed = false
    return { status: 0, stdout: "", stderr: "" }
  })
  await expect(withInstalledArtifact({ kind: "deb", file: path.join(root, "final.deb") }, root, async resources => {
    expect(installed).toBe(true)
    expect(resources).toBe("/opt/Cliply/resources")
    throw new Error("startup failed")
  })).rejects.toThrow("startup failed")
  expect(installed).toBe(false)
  expect(spawnSync.mock.calls.some(([exe, args]) => exe === "sudo" && args.includes("purge"))).toBe(true)
})
test("DEB refuses a pre-existing package before apt installation", async () => {
  spawnSync.mockImplementation(executable => executable === "dpkg-deb" ? { status: 0, stdout: metadata.name } : { status: 0, stdout: "installed" })
  await expect(withInstalledArtifact({ kind: "deb", file: path.join(root, "final.deb") }, root, jest.fn())).rejects.toThrow(/refusing to replace/)
  expect(spawnSync.mock.calls.some(([exe]) => exe === "sudo")).toBe(false)
})
test("AppImage check explicitly extracts the final image without repacking or claiming installation", async () => {
  const verify = jest.fn(async () => {})
  const file = path.join(root, "final.AppImage")
  await withInstalledArtifact({ kind: "appimage", file }, root, verify)
  expect(spawnSync).toHaveBeenCalledWith(file, ["--appimage-extract"], expect.objectContaining({ cwd: path.join(root, "appimage") }))
  expect(verify).toHaveBeenCalledWith(path.join(root, "appimage", "squashfs-root", "resources"), "final-appimage-extracted-payload")
})


test("retains both validation and detach failures rather than hiding the original error", async () => {
  spawnSync.mockImplementation((executable, args) => {
    if (executable === "hdiutil" && args[0] === "attach") fs.mkdirSync(path.join(args[4], "Cliply.app"))
    return { status: args[0] === "detach" ? 1 : 0, stdout: "", stderr: "" }
  })
  let failure
  try { await withInstalledArtifact({ kind: "dmg", file: path.join(root, "final.dmg") }, root, async () => { throw new Error("payload mismatch") }) }
  catch (error) { failure = error }
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors[0].message).toBe("payload mismatch")
  expect(failure.errors[1].message).toMatch(/hdiutil exited 1/)
})
