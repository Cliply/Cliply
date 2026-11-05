const fs = require("node:fs"), os = require("node:os"), path = require("node:path")
const { createHash } = require("node:crypto")
const { spawnSync, execFileSync } = require("node:child_process")
const tar = require("tar")
const { validateRun, publishAsset, extract, verifyCandidate } = require("../scripts/publish-ffprobe")
const digest = value => createHash("sha256").update(value).digest("hex")
const hash = file => digest(fs.readFileSync(file))
let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-publication-test-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

test("Windows-style checkout preserves hash-bound recipes, notices and canonical production records as LF", () => {
  const repository = path.join(root, "repository"), checkout = path.join(root, "checkout")
  fs.mkdirSync(repository); fs.mkdirSync(checkout)
  const git = args => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git(["init"])
  git(["config", "--local", "core.autocrlf", "true"])
  git(["config", "--local", "core.eol", "crlf"])
  const emptyAttributes = path.join(root, "empty-attributes")
  fs.writeFileSync(emptyAttributes, "")
  git(["config", "--local", "core.attributesFile", emptyAttributes])
  const inputs = ["scripts/build-ffprobe-prototype.js", "scripts/package-ffprobe-source.js",
    "third-party/ffprobe/source-build.json", "third-party/ffprobe/runtime-notices.json",
    "third-party/ffprobe/NOTICE.source-build.txt", "third-party/ffprobe/COPYING.LGPLv2.1",
    "third-party/ffprobe/source-build.md", "LICENSE"]
  const expected = new Map()
  for (const relative of [".gitattributes", ...inputs]) {
    const contents = fs.readFileSync(path.join(__dirname, "..", relative))
    const file = path.join(repository, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents)
    if (relative !== ".gitattributes") expected.set(relative, contents)
  }
  for (const platform of ["darwin-arm64", "win32-x64", "linux-x64"]) {
    const relative = `third-party/ffprobe/distributions/${platform}/SOURCE.json`
    const contents = Buffer.from(JSON.stringify({ schema: 1, platform, files: { "NOTICE.txt": "a".repeat(64) } }, null, 2) + "\n")
    fs.mkdirSync(path.dirname(path.join(repository, relative)), { recursive: true })
    fs.writeFileSync(path.join(repository, relative), contents); expected.set(relative, contents)
  }
  // Prove autocrlf conversion actually occurs for text outside the protected paths.
  fs.writeFileSync(path.join(repository, "unprotected.txt"), "first\nsecond\n")
  git(["add", "."])
  git(["checkout-index", "--all", "--force", "--prefix=" + checkout + path.sep])
  expect(fs.readFileSync(path.join(checkout, "unprotected.txt"), "utf8")).toBe("first\r\nsecond\r\n")
  for (const [relative, original] of expected) {
    const actual = fs.readFileSync(path.join(checkout, relative))
    expect(actual.toString()).not.toContain("\r\n")
    expect(actual).toEqual(original)
    expect(digest(actual)).toBe(digest(original))
    if (relative.endsWith("/SOURCE.json")) expect(actual.toString()).toBe(JSON.stringify(JSON.parse(actual), null, 2) + "\n")
  }
})

const successfulRun = () => ({ head_sha: "a".repeat(40), head_repository: { full_name: "Cliply/Cliply" },
  path: ".github/workflows/ci.yml", event: "workflow_dispatch", status: "completed", conclusion: "success" })
test("promotion accepts only the exact completed successful repository run", () => {
  expect(() => validateRun(successfulRun(), "a".repeat(40))).not.toThrow()
})
test.each([
  ["head_sha", "b".repeat(40)], ["head_repository", { full_name: "Other/Cliply" }],
  ["head_repository", undefined], ["path", ".github/workflows/build-release.yml"],
  ["event", "pull_request"], ["status", "in_progress"], ["conclusion", "failure"], ["conclusion", "cancelled"]
])("promotion rejects unqualified run %s=%j", (field, value) => {
  expect(() => validateRun({ ...successfulRun(), [field]: value }, "a".repeat(40))).toThrow()
})

function assetFixture() {
  const bytes = Buffer.from("verified helper bytes"), name = "ffprobe-fixture", file = path.join(root, name)
  fs.writeFileSync(file, bytes)
  const expected = digest(bytes)
  const asset = { name, id: 123, size: bytes.length, digest: "sha256:" + expected, state: "uploaded",
    browser_download_url: "https://github.com/Cliply/Cliply/releases/download/binaries/" + name }
  const upload = jest.fn(), lookup = jest.fn(() => [asset])
  const download = jest.fn(async (_url, target) => fs.writeFileSync(target, bytes))
  return { bytes, name, file, expected, asset, hooks: { upload, lookup, download } }
}
test("existing immutable asset is verified by downloaded bytes without uploading or replacing it", async () => {
  const f = assetFixture()
  await expect(publishAsset(f.file, f.name, f.expected, root, [f.asset], f.hooks)).resolves.toEqual(f.asset)
  expect(f.hooks.upload).not.toHaveBeenCalled(); expect(f.hooks.lookup).not.toHaveBeenCalled()
  expect(f.hooks.download).toHaveBeenCalledWith(f.asset.browser_download_url, path.join(root, f.name + ".download"))
  expect(fs.existsSync(path.join(root, f.name + ".download"))).toBe(false)
})
test("new asset must appear after upload and is independently downloaded and hashed", async () => {
  const f = assetFixture()
  await expect(publishAsset(f.file, f.name, f.expected, root, [], f.hooks)).resolves.toEqual(f.asset)
  expect(f.hooks.upload).toHaveBeenCalledTimes(1); expect(f.hooks.lookup).toHaveBeenCalledTimes(1)
  expect(f.hooks.download).toHaveBeenCalledTimes(1)
})
test("the real upload command never clobbers and a competing upload failure is not suppressed", async () => {
  const f = assetFixture(), command = jest.fn(() => { throw new Error("asset already exists") })
  let isolatedPublisher
  // Mock the external CLI boundary, retaining real verification and filesystem.
  jest.doMock("node:child_process", () => ({ ...jest.requireActual("node:child_process"), execFileSync: command }))
  try {
    jest.isolateModules(() => { isolatedPublisher = require("../scripts/publish-ffprobe") })
  } finally { jest.dontMock("node:child_process") }
  await expect(isolatedPublisher.publishAsset(f.file, f.name, f.expected, root, [], {
    lookup: f.hooks.lookup, download: f.hooks.download
  })).rejects.toThrow("asset already exists")
  expect(command).toHaveBeenCalledWith("gh", ["release", "upload", "binaries", f.file, "--repo", "Cliply/Cliply"], expect.any(Object))
  expect(f.hooks.lookup).not.toHaveBeenCalled(); expect(f.hooks.download).not.toHaveBeenCalled()
})
test.each([
  ["digest", "sha256:" + "f".repeat(64)], ["size", 1], ["state", "new"],
  ["id", 0], ["browser_download_url", "https://example.com/untrusted"]
])("an existing asset with wrong %s fails without overwrite or download", async (field, value) => {
  const f = assetFixture()
  await expect(publishAsset(f.file, f.name, f.expected, root, [{ ...f.asset, [field]: value }], f.hooks)).rejects.toThrow()
  expect(f.hooks.upload).not.toHaveBeenCalled(); expect(f.hooks.download).not.toHaveBeenCalled()
})
test("same-size corrupt remote bytes fail even with a matching API digest", async () => {
  const f = assetFixture()
  f.hooks.download.mockImplementation(async (_url, target) => fs.writeFileSync(target, Buffer.alloc(f.bytes.length)))
  await expect(publishAsset(f.file, f.name, f.expected, root, [f.asset], f.hooks)).rejects.toThrow(/downloaded release bytes differ/)
  expect(f.hooks.upload).not.toHaveBeenCalled()
})
test("a missing API digest never skips independent byte verification", async () => {
  const f = assetFixture(); delete f.asset.digest
  await expect(publishAsset(f.file, f.name, f.expected, root, [f.asset], f.hooks)).resolves.toEqual(f.asset)
  expect(f.hooks.download).toHaveBeenCalledTimes(1)
})
test("duplicate or missing uploaded assets fail instead of selecting arbitrary bytes", async () => {
  const f = assetFixture()
  await expect(publishAsset(f.file, f.name, f.expected, root, [f.asset, f.asset], f.hooks)).rejects.toThrow(/duplicate/)
  expect(f.hooks.upload).not.toHaveBeenCalled()
  f.hooks.lookup.mockReturnValue([])
  await expect(publishAsset(f.file, f.name, f.expected, root, [], f.hooks)).rejects.toThrow(/uploaded asset is missing/)
  expect(f.hooks.download).not.toHaveBeenCalled()
})

function archiveAt(file, entries) {
  const blocks = entries.flatMap(({ name, contents = "", type = "File", linkpath }) => {
    const body = Buffer.from(contents), header = new tar.Header({ path: name, size: body.length, mode: 0o644, type, linkpath })
    header.encode()
    return [header.block, body, Buffer.alloc((512 - body.length % 512) % 512)]
  })
  fs.writeFileSync(file, Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
test("safe packet extraction preserves nested file bytes", async () => {
  const archive = path.join(root, "source.tar"), output = path.join(root, "output")
  archiveAt(archive, [{ name: "nested/source.c", contents: "source" }])
  await extract(archive, output)
  expect(fs.readFileSync(path.join(output, "nested/source.c"), "utf8")).toBe("source")
})
test.each([
  [{ name: "../escape", contents: "bad" }], [{ name: "/absolute", contents: "bad" }],
  [{ name: "C:/absolute", contents: "bad" }], [{ name: "nested\\escape", contents: "bad" }],
  [{ name: "link", type: "SymbolicLink", linkpath: "../escape" }],
  [{ name: "link", type: "Link", linkpath: "../escape" }],
  [{ name: "duplicate", contents: "a" }, { name: "duplicate", contents: "b" }]
].map(entries => [entries]))("unsafe archive %j rejects before writing and through the promise cleanup path", entries => {
  const archive = path.join(root, "unsafe.tar"), output = path.join(root, "output")
  archiveAt(archive, entries)
  // A callback throw must not escape tar's promise and bypass promote's finally.
  // Use a child so that such a regression cannot crash the entire test worker.
  const code = `require(${JSON.stringify(path.join(__dirname, "../scripts/publish-ffprobe.js"))}).extract(${JSON.stringify(archive)}, ${JSON.stringify(output)}).then(() => { process.exitCode = 2 }, error => { process.stdout.write("REJECTED:" + error.message); process.exitCode = 7 })`
  const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 5000 })
  expect(result.error).toBeUndefined(); expect(result.status).toBe(7)
  expect(result.stdout).toMatch(/^REJECTED:/)
  expect(fs.existsSync(output)).toBe(false)
  expect(fs.existsSync(path.join(root, "escape"))).toBe(false)
})

function candidateFixture() {
  const directory = path.join(root, "candidate"), scratch = path.join(root, "scratch")
  fs.mkdirSync(directory); fs.mkdirSync(scratch)
  const archive = path.join(directory, "packet.tar")
  const manifest = { files: {} }
  archiveAt(archive, [{ name: "manifest.json", contents: JSON.stringify(manifest) }])
  fs.writeFileSync(path.join(directory, "source-packet.json"), JSON.stringify({ assetName: "packet.tar", sha256: hash(archive), bytes: fs.statSync(archive).size, manifest }))
  fs.writeFileSync(path.join(directory, "ffprobe"), "candidate bytes")
  const review = { schema: 1, platform: "darwin-arm64", evaluationOnly: true, publicationReady: false,
    nativeValidationPassed: true, runtimeNoticesReviewed: true, installedNoticesValidated: true, sourcePacketReadyForReview: true }
  const save = () => {
    review.files = Object.fromEntries(fs.readdirSync(directory).filter(name => name !== "REVIEW.json").map(name => [name, hash(path.join(directory, name))]))
    fs.writeFileSync(path.join(directory, "REVIEW.json"), JSON.stringify(review))
  }
  save()
  return { directory, scratch, review, save, archive }
}
test.each(["changed", "extra", "missing"])("retained candidate %s files fail before extraction", async kind => {
  const f = candidateFixture()
  if (kind === "changed") fs.writeFileSync(path.join(f.directory, "ffprobe"), "different bytes")
  if (kind === "extra") fs.writeFileSync(path.join(f.directory, "unexpected"), "extra")
  if (kind === "missing") fs.unlinkSync(path.join(f.directory, "ffprobe"))
  await expect(verifyCandidate(f.directory, "darwin-arm64", f.scratch)).rejects.toThrow(/retained candidate inventory changed/)
  expect(fs.readdirSync(f.scratch)).toEqual([])
})
test.each(["nativeValidationPassed", "runtimeNoticesReviewed", "installedNoticesValidated", "sourcePacketReadyForReview"])("incomplete candidate %s is rejected", async flag => {
  const f = candidateFixture(); f.review[flag] = false; f.save()
  await expect(verifyCandidate(f.directory, "darwin-arm64", f.scratch)).rejects.toThrow(/incomplete candidate/)
})
test("source packet checksum is checked independently of the retained inventory", async () => {
  const f = candidateFixture()
  fs.appendFileSync(f.archive, "changed packet"); f.save()
  await expect(verifyCandidate(f.directory, "darwin-arm64", f.scratch)).rejects.toThrow()
  expect(fs.readdirSync(f.scratch)).toEqual([])
})
test("source packet inventory rejects unlisted extracted files even with a refreshed archive digest", async () => {
  const f = candidateFixture(), manifest = { files: {} }
  archiveAt(f.archive, [{ name: "manifest.json", contents: JSON.stringify(manifest) }, { name: "unexpected", contents: "extra" }])
  fs.writeFileSync(path.join(f.directory, "source-packet.json"), JSON.stringify({ assetName: "packet.tar", sha256: hash(f.archive), bytes: fs.statSync(f.archive).size, manifest }))
  f.save()
  await expect(verifyCandidate(f.directory, "darwin-arm64", f.scratch)).rejects.toThrow(/source packet inventory changed/)
})
