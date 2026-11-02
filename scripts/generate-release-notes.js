// Preview or generate Markdown only. This script never creates a tag or release.
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { parseArgs } = require("node:util")

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function escapeSubject(subject) {
  return subject.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]])/g, "\\$1")
}

function generateReleaseNotes({ tag, repo = "Cliply/Cliply", target, execute = run }) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tag || "")) {
    throw new Error("Provide an app version tag, for example --tag v0.4.1")
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Expected repository owner/name")
  const existing = execute("git", ["tag", "--list", tag]).trim()
  const ref = target || (existing ? `refs/tags/${tag}` : "HEAD")
  const commit = execute("git", ["rev-parse", "--verify", `${ref}^{commit}`]).trim()
  if (existing && target && commit !== execute("git", ["rev-parse", `refs/tags/${tag}^{commit}`]).trim()) {
    throw new Error("The target must match the existing tag; GitHub generates notes from that tag")
  }
  // Ignore helper releases, drafts, and tags whose builds never published.
  // Excluding the current tag keeps rebuilds on the original release range.
  const releases = JSON.parse(execute("gh", ["api", "--paginate", "--slurp",
    `repos/${repo}/releases?per_page=100`])).flat()
  const published = new Set(releases.filter((release) => !release.draft && !release.prerelease)
    .map((release) => release.tag_name))
  const previous = execute("git", ["tag", "--merged", commit, "--list", "v*", "--sort=-version:refname"])
    .trim().split("\n").find((name) => name !== tag && /^v\d+\.\d+\.\d+$/.test(name) && published.has(name))
  // Without an earlier app release, GitHub could choose the helper release
  // implicitly. Use the complete commit history instead of that wrong range.
  let generated = { body: "" }
  if (previous) {
    generated = JSON.parse(execute("gh", ["api", "--method", "POST", `repos/${repo}/releases/generate-notes`,
      "-f", `tag_name=${tag}`, "-f", `target_commitish=${commit}`, "-f", `previous_tag_name=${previous}`]))
  }
  if (typeof generated.body !== "string") throw new Error("GitHub returned no release notes")

  const range = previous ? `${previous}..${commit}` : commit
  const commits = execute("git", ["log", "--no-merges", "--reverse", "--format=%H%x00%s", range, "--"])
    .trim().split("\n").filter(Boolean).map((line) => {
      const [sha, subject] = line.split("\0")
      return `- ${escapeSubject(subject)} ([${sha.slice(0, 7)}](https://github.com/${repo}/commit/${sha}))`
    })
  const installation = fs.readFileSync(path.join(__dirname, "../.github/RELEASE_NOTES.md"), "utf8").trim()
  const summary = generated.body.trim() || "## What's changed\n\nSee commit details below."
  const details = ["<details>", `<summary>Commit details (${commits.length})</summary>`, "",
    commits.length ? commits.join("\n") : "No new commits in this range.", "", "</details>"].join("\n")
  return [installation, summary, details].join("\n\n")
    .replace(/[ \t]*\u2014[ \t]*/g, " - ") + "\n"
}

if (require.main === module) {
  try {
    const { values } = parseArgs({ options: {
      tag: { type: "string" }, target: { type: "string" }, repo: { type: "string" }
    } })
    process.stdout.write(generateReleaseNotes({ ...values, repo: values.repo || process.env.GITHUB_REPOSITORY }))
  } catch (error) {
    console.error(error.stderr?.toString().trim() || error.message)
    process.exitCode = 1
  }
}

module.exports = { generateReleaseNotes }
