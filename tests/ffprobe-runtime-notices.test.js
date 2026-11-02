jest.mock("../third-party/ffprobe/runtime-notices.json", () => {
  const sha = require("node:crypto").createHash("sha256").update("synthetic runtime notice\n").digest("hex")
  return { schema: 1, "linux-x64": { systemLibraries: ["libc.so.6", "libm.so.6"], toolchainPackages: "gcc-fixture\t1\n", toolchainHashes: { "gcc-13": "a".repeat(64) }, files: { "runtime.txt": sha }, installedFiles: { "RUNTIME.txt": "runtime.txt" } } }
})
const fs = require("node:fs"), os = require("node:os"), path = require("node:path")
const { verifyRuntimeNotices, readBuild } = require("../scripts/package-ffprobe-source")
let root, facts
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-runtime-test-"))
  fs.writeFileSync(path.join(root, "runtime.txt"), "synthetic runtime notice\n")
  facts = { platform: "linux-x64", systemLibraries: ["libm.so.6", "libc.so.6"], toolchain: { packages: "gcc-fixture\t1\n", files: { "gcc-13": { sha256: "a".repeat(64) } } } }
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
test("matches exact observed runtime notices, imports and native toolchain", () => {
  expect(verifyRuntimeNotices(facts, root).installedFiles).toEqual({ "RUNTIME.txt": "runtime.txt" })
})
test.each(["imports", "packages", "compiler", "notice"])("refuses changed %s rather than accepting arbitrary Linux input", kind => {
  if (kind === "imports") facts.systemLibraries.push("libgcc_s.so.1")
  if (kind === "packages") facts.toolchain.packages = "gcc-fixture\t2\n"
  if (kind === "compiler") facts.toolchain.files["gcc-13"].sha256 = "b".repeat(64)
  if (kind === "notice") fs.appendFileSync(path.join(root, "runtime.txt"), " altered")
  expect(() => verifyRuntimeNotices(facts, root)).toThrow(/changed/)
})
test("unreviewed platform still cannot create a runtime/source packet", () => {
  expect(() => verifyRuntimeNotices({ ...facts, platform: "win32-x64" }, root)).toThrow(/review/)
})
test("cross-host source assembly requires complete native validation, not a platform override", () => {
  const target = process.platform === "linux" ? "win32-x64" : "linux-x64"
  fs.writeFileSync(path.join(root, "prototype.json"), JSON.stringify({ platform: target }))
  expect(() => readBuild(root)).toThrow(/native validation host/)
  fs.writeFileSync(path.join(root, "commands.json"), "[]")
  expect(() => readBuild(root, { validationDirectory: root })).toThrow(/failed validation/)
})
