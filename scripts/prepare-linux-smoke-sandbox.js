// Configure only the disposable test copy's genuine Electron SUID helper.
// This is the same ownership/mode an installed DEB supplies, not a sandbox bypass.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict")
const { createHash } = require("node:crypto"), { spawnSync } = require("node:child_process")
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
function prepareLinuxSmokeSandbox(scratch, appDir) {
  assert.equal(process.platform, "linux")
  assert.equal(process.env.GITHUB_ACTIONS, "true", "sandbox helper setup is restricted to a disposable GitHub runner")
  assert.equal(process.env.CI, "true")
  const uid = process.getuid()
  assert.notEqual(uid, 0, "launch Electron as the ordinary runner user")
  assert.equal(path.dirname(scratch), os.tmpdir())
  assert.match(path.basename(scratch), /^cliply-local-package-[A-Za-z0-9]+$/)
  assert.equal(fs.realpathSync(scratch), scratch, "scratch must not be redirected")
  const root = fs.lstatSync(scratch)
  assert(root.isDirectory() && root.uid === uid && (root.mode & 0o777) === 0o700, "scratch must be privately owned")
  assert.equal(appDir, path.join(scratch, "app"))
  assert(fs.lstatSync(appDir).isDirectory(), "app copy must not be a symlink")
  const helper = path.join(appDir, "chrome-sandbox")
  const original = path.resolve(__dirname, "../node_modules/electron/dist/chrome-sandbox")
  assert(fs.lstatSync(helper).isFile() && fs.lstatSync(original).isFile(), "sandbox helper must be a regular file")
  assert.equal(digest(helper), digest(original), "test helper differs from the installed Electron dependency")
  function sudo(args) {
    const result = spawnSync("sudo", ["-n", ...args], { encoding: "utf8", timeout: 30000 })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
  }
  // All privileged arguments are fixed except this verified, task-owned file.
  // If mode setup or verification fails after chown, the helper stays non-SUID.
  sudo(["chown", "root:root", "--", helper])
  try {
    sudo(["chmod", "4755", "--", helper])
    const ready = fs.statSync(helper)
    assert.equal(ready.uid, 0); assert.equal(ready.gid, 0); assert.equal(ready.mode & 0o7777, 0o4755)
    assert.equal(digest(helper), digest(original))
  } catch (error) { sudo(["chmod", "0755", "--", helper]); throw error }
  return () => sudo(["chmod", "0755", "--", helper])
}
module.exports = { prepareLinuxSmokeSandbox }
