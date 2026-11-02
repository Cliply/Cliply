jest.mock("../third-party/ffprobe/runtime-notices.json", () => {
  const sha = require("node:crypto").createHash("sha256").update("synthetic runtime notice\n").digest("hex")
  const linux = { systemLibraries: ["libc.so.6", "libm.so.6"], toolchainPackages: "gcc-fixture\t1\n", toolchainHashes: { "gcc-13": "a".repeat(64) }, files: { "runtime.txt": sha }, installedFiles: { "RUNTIME.txt": "runtime.txt" } }
  return { schema: 1, "linux-x64": linux, "win32-x64": { ...linux, systemLibraries: ["kernel32.dll"], threadRuntimeArchive: { sha256: "c".repeat(64), ownership: "fixture owner 1\n" } } }
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
  expect(() => verifyRuntimeNotices({ ...facts, platform: "win32-arm64" }, root)).toThrow(/review/)
})
test.each(["valid", "hash", "owner", "platform", "missing"])("Windows binds the static runtime inventory (%s)", kind => {
  facts.platform = "win32-x64"; facts.systemLibraries = ["kernel32.dll"]
  const inventory = { platform: facts.platform, threadRuntimeArchive: { sha256: "c".repeat(64), ownership: "fixture owner 1\n" } }
  if (kind === "hash") inventory.threadRuntimeArchive.sha256 = "d".repeat(64)
  if (kind === "owner") inventory.threadRuntimeArchive.ownership = "another owner 2\n"
  if (kind === "platform") inventory.platform = "linux-x64"
  if (kind !== "missing") fs.writeFileSync(path.join(root, "inventory.json"), JSON.stringify(inventory))
  if (kind === "valid") expect(verifyRuntimeNotices(facts, root).threadRuntimeArchive).toEqual(inventory.threadRuntimeArchive)
  else expect(() => verifyRuntimeNotices(facts, root)).toThrow()
})
test("reviewed Windows notices do not admit a failed native candidate", () => {
  fs.writeFileSync(path.join(root, "prototype.json"), JSON.stringify({ platform: "win32-x64" }))
  fs.writeFileSync(path.join(root, "commands.json"), JSON.stringify([{ name: "packaged-ui", status: 1 }]))
  expect(() => readBuild(root, { validationDirectory: root })).toThrow(/failed validation/)
})
test("cross-host source assembly requires complete native validation, not a platform override", () => {
  const target = process.platform === "linux" ? "win32-x64" : "linux-x64"
  fs.writeFileSync(path.join(root, "prototype.json"), JSON.stringify({ platform: target }))
  expect(() => readBuild(root)).toThrow(/native validation host/)
  fs.writeFileSync(path.join(root, "commands.json"), "[]")
  expect(() => readBuild(root, { validationDirectory: root })).toThrow(/failed validation/)
})
