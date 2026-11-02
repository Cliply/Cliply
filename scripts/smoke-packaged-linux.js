// Exercise the actual AppImage launcher and DEB installation without changing
// release artifacts or starting production services. Only run on an ephemeral
// GitHub Linux runner, under Xvfb or an existing graphical session.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const repo = path.resolve(__dirname, "..")
const metadata = require("../package.json")
const successMarker = "Electron runtime smoke passed:"

function run(command, args, { env, timeout = 60000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: repo, env, encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} exited ${result.status} (${result.signal || "no signal"})`)
  return result.stdout
}

function installedPackage(name) {
  const result = spawnSync("dpkg-query", ["-W", "-f=${db:Status-Status}", name], { encoding: "utf8" })
  if (result.error) throw result.error
  return result.status === 0 && result.stdout.trim() !== "not-installed"
}

function findExecutable(directory) {
  const candidates = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => {
    if (!entry.isFile() || ["chrome-sandbox", "chrome_crashpad_handler"].includes(entry.name)) return false
    if (entry.name.includes(".so")) return false
    const file = path.join(directory, entry.name)
    if (!(fs.statSync(file).mode & 0o111)) return false
    const handle = fs.openSync(file, "r")
    try {
      const header = Buffer.alloc(4)
      return fs.readSync(handle, header, 0, header.length, 0) === 4 &&
        header.equals(Buffer.from([127, 69, 76, 70]))
    } finally {
      fs.closeSync(handle)
    }
  })
  assert.equal(candidates.length, 1, "expected one packaged Electron executable")
  return candidates[0].name
}

function main() {
  assert.equal(process.platform, "linux", "packaged Linux smoke requires Linux")
  assert.equal(process.arch, "x64", "packaged Linux smoke requires x64")
  assert.equal(process.env.GITHUB_ACTIONS, "true", "DEB installation is restricted to an ephemeral GitHub runner")
  assert.equal(process.env.CI, "true", "DEB installation is restricted to CI")
  assert.notEqual(process.getuid(), 0, "launch the app as the ordinary runner user")
  run("sudo", ["-n", "true"])

  const source = path.join(repo, "dist", "linux-unpacked")
  assert.ok(fs.existsSync(path.join(source, "resources", "app.asar")), "build the Linux app first")
  const executable = findExecutable(source)
  const productName = metadata.build.productName || metadata.name
  assert.match(productName, /^[A-Za-z0-9._ -]+$/, "expected a simple Linux product directory")
  const installDirectory = path.join("/opt", productName)
  assert.ok(!fs.existsSync(installDirectory), `refusing to replace ${installDirectory}`)
  assert.ok(!fs.existsSync(path.join("/usr/bin", executable)), "refusing to replace an existing launcher")

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-linux-package-"))
  let packageName
  let installAttempted = false
  try {
    const appDir = path.join(root, "appdir")
    fs.cpSync(source, appDir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
    const resources = path.join(appDir, "resources")
    fs.renameSync(path.join(resources, "app.asar"), path.join(resources, "cliply-under-test.asar"))
    if (fs.existsSync(path.join(resources, "app.asar.unpacked"))) {
      fs.renameSync(path.join(resources, "app.asar.unpacked"), path.join(resources, "cliply-under-test.asar.unpacked"))
    }
    fs.mkdirSync(path.join(resources, "app"))
    fs.writeFileSync(path.join(resources, "app", "package.json"), JSON.stringify({
      name: metadata.name,
      version: metadata.version,
      main: path.join(repo, "scripts", "smoke-electron.js")
    }))

    const output = path.join(root, "out")
    const config = path.join(root, "electron-builder.json")
    fs.writeFileSync(config, JSON.stringify({
      extends: null,
      appId: metadata.build.appId,
      productName,
      directories: { output },
      toolsets: metadata.build.toolsets,
      linux: {
        executableName: executable,
        icon: path.resolve(repo, metadata.build.linux.icon),
        category: metadata.build.linux.category,
        target: ["AppImage", "deb"]
      },
      appImage: metadata.build.appImage,
      deb: metadata.build.deb,
      publish: null
    }, null, 2))

    const env = {
      ...process.env,
      NODE_ENV: "production",
      TMPDIR: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_DATA_HOME: path.join(root, "data"),
      ELECTRON_BUILDER_CACHE: path.join(root, "builder-cache"),
      CLIPLY_SMOKE_APP_ROOT: "bundled"
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    for (const directory of [env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    run(process.execPath, [require.resolve("electron-builder/cli.js"),
      "--prepackaged", appDir, "--linux", "AppImage", "deb", "--x64",
      "--publish", "never", "--config", config
    ], { env, timeout: 10 * 60 * 1000 })

    const artifacts = fs.readdirSync(output)
    function artifact(extension) {
      const matches = artifacts.filter((name) => name.endsWith(extension))
      assert.equal(matches.length, 1, `expected one disposable ${extension}`)
      return path.join(output, matches[0])
    }
    function launch(binary, label) {
      const userData = path.join(root, `user-data-${label}`)
      fs.mkdirSync(userData)
      const stdout = run(binary, [], {
        env: { ...env, CLIPLY_SMOKE_USER_DATA: userData }, timeout: 90000
      })
      assert.ok(stdout.includes(successMarker), `${label} did not execute the isolated Electron smoke`)
      console.log(`packaged Linux ${label} startup passed`)
    }

    launch(artifact(".AppImage"), "appimage")
    const deb = artifact(".deb")
    packageName = run("dpkg-deb", ["--field", deb, "Package"]).trim()
    assert.match(packageName, /^[a-z0-9][a-z0-9+.-]+$/, "invalid disposable DEB package name")
    assert.ok(!installedPackage(packageName), `refusing to replace installed package ${packageName}`)
    installAttempted = true
    run("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y",
      "--no-install-recommends", deb
    ], { timeout: 3 * 60 * 1000 })
    launch(path.join(installDirectory, executable), "deb")
  } finally {
    try {
      if (installAttempted) {
        run("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "purge", "-y", packageName], {
          timeout: 2 * 60 * 1000
        })
        assert.ok(!installedPackage(packageName), "disposable DEB package was not removed")
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
