const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { generateReleaseNotes } = require("../scripts/generate-release-notes")

let root, github, counter, generated, releasePages
const generatedBody = "## What's changed\n\n- Add playlists\n\n**Full Changelog**: https://github.com/Cliply/Cliply/compare/v1.0.0...v1.1.0"

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function commit(subject) {
  fs.writeFileSync(path.join(root, "change.txt"), String(++counter))
  git("add", "change.txt")
  git("commit", "-m", subject)
  return git("rev-parse", "HEAD")
}

function generate(options = {}) {
  return generateReleaseNotes({
    tag: "v1.1.0",
    execute: (command, args) => command === "gh" ? github(args) : git(...args),
    ...options
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-release-notes-"))
  counter = 0
  git("init", "--initial-branch=main")
  git("config", "user.name", "Release notes test")
  git("config", "user.email", "release-notes@example.test")
  git("config", "commit.gpgsign", "false")
  git("config", "core.hooksPath", path.join(root, "no-hooks"))
  generated = { body: generatedBody }
  releasePages = [[{ tag_name: "v1.0.0", draft: false, prerelease: false }]]
  github = jest.fn((args) => JSON.stringify(
    args.includes("repos/Cliply/Cliply/releases/generate-notes") ? generated : releasePages
  ))
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

test("rebuilding a tagged release keeps the previous version and includes direct commits", () => {
  commit("old shipped change")
  git("tag", "v1.0.0")
  const change = commit("fix: direct download recovery")
  git("tag", "v1.1.0")
  git("tag", "binaries")
  git("tag", "v2.0.0-rc.1")
  const refs = git("show-ref")

  const notes = generate()

  expect(notes.indexOf("## Installation")).toBe(0)
  expect(notes.indexOf("## What's changed")).toBeGreaterThan(notes.indexOf("sudo xattr"))
  expect(notes.indexOf("<details>")).toBeGreaterThan(notes.indexOf("## What's changed"))
  expect(notes).toContain("Commit details (1)")
  expect(notes).toContain(`fix: direct download recovery ([${change.slice(0, 7)}]`)
  expect(notes).not.toContain("old shipped change")
  expect(github).toHaveBeenCalledWith(expect.arrayContaining([
    "repos/Cliply/Cliply/releases/generate-notes", "tag_name=v1.1.0",
    "previous_tag_name=v1.0.0", `target_commitish=${change}`
  ]))
  expect(git("show-ref")).toBe(refs)
})

test("a preview works without creating its version tag", () => {
  commit("previous release")
  git("tag", "v1.0.0")
  commit("feat: add Linux packages")

  expect(generate()).toContain("feat: add Linux packages")
  expect(git("tag", "--list")).toBe("v1.0.0")
})

test("historical previews exclude later and unrelated release tags", () => {
  commit("first release")
  git("tag", "v1.0.0")
  const released = commit("fix: shipped in 1.1")
  git("tag", "v1.1.0")
  commit("future change")
  git("tag", "v9.0.0")

  const notes = generate({ target: "v1.1.0" })

  expect(notes).toContain("fix: shipped in 1.1")
  expect(notes).not.toContain("future change")
  expect(github).toHaveBeenCalledWith(expect.arrayContaining([
    "previous_tag_name=v1.0.0", `target_commitish=${released}`
  ]))
})

test("an existing tag is authoritative even when the checkout has later changes", () => {
  commit("baseline")
  git("tag", "v1.0.0")
  const released = commit("released change")
  git("tag", "v1.1.0")
  commit("unreleased change")

  const notes = generate()

  expect(notes).toContain("released change")
  expect(notes).not.toContain("unreleased change")
  expect(github).toHaveBeenCalledWith(expect.arrayContaining([`target_commitish=${released}`]))
})

test("an explicit target cannot disagree with an existing GitHub tag", () => {
  commit("baseline")
  git("tag", "v1.1.0")
  commit("later change")

  expect(() => generate({ target: "HEAD" })).toThrow("target must match the existing tag")
  expect(github).not.toHaveBeenCalled()
})

test("the first app release includes history even if a helper tag exists", () => {
  commit("initial app")
  git("tag", "binaries")
  commit("feat: first download")
  releasePages = [[{ tag_name: "binaries", draft: false, prerelease: false }]]

  const notes = generate()

  expect(notes).toContain("Commit details (2)")
  expect(notes).toContain("initial app")
  expect(github.mock.calls.some(([args]) => args.includes("repos/Cliply/Cliply/releases/generate-notes"))).toBe(false)
})

test("failed, draft and prerelease versions cannot hide changes since the published release", () => {
  commit("published baseline")
  git("tag", "v1.0.0")
  commit("fix: never published")
  git("tag", "v1.1.0")
  commit("feat: draft only")
  git("tag", "v1.2.0")
  commit("feat: preview only")
  git("tag", "v1.3.0")
  releasePages = [[
    { tag_name: "v1.3.0", draft: false, prerelease: true },
    { tag_name: "v1.2.0", draft: true, prerelease: false }
  ], releasePages[0]]

  const notes = generate({ tag: "v1.4.0" })

  expect(notes).toContain("Commit details (3)")
  expect(notes).toContain("fix: never published")
  expect(github).toHaveBeenCalledWith(expect.arrayContaining(["previous_tag_name=v1.0.0"]))
})

test("empty ranges stay readable and GitHub's summary needs no fabricated changes", () => {
  commit("already shipped")
  git("tag", "v1.0.0")
  generated = { body: "" }

  const notes = generate()

  expect(notes).toContain("See commit details below.")
  expect(notes).toContain("Commit details (0)")
  expect(notes).toContain("No new commits in this range.")
})

test("commit messages cannot break the details layout and em dashes are removed", () => {
  commit("baseline")
  git("tag", "v1.0.0")
  commit("fix: [link] & `code` </details> \u2014 keep this text")
  generated = { body: "## What's changed\n\nBetter downloads \u2014 fewer errors" }

  const notes = generate()

  expect(notes).toContain("\\[link\\] &amp; \\`code\\` &lt;/details&gt; - keep this text")
  expect(notes).toContain("Better downloads - fewer errors")
  expect(notes).not.toContain("\u2014")
  expect(notes.match(/<\/details>/g)).toHaveLength(1)
})

test("GitHub generation errors fail before a release body can be produced", () => {
  commit("first change")
  git("tag", "v1.0.0")
  github.mockImplementationOnce(() => { throw new Error("GitHub unavailable") })
  expect(() => generate()).toThrow("GitHub unavailable")
  generated = { message: "unexpected response" }
  expect(() => generate()).toThrow("GitHub returned no release notes")
})

test("invalid version tags and repository names are rejected before any command", () => {
  const execute = jest.fn()
  expect(() => generateReleaseNotes({ tag: "binaries", execute })).toThrow("app version tag")
  expect(() => generateReleaseNotes({ tag: "v1.1.0", repo: "bad/repo/path", execute })).toThrow("owner/name")
  expect(execute).not.toHaveBeenCalled()
})
