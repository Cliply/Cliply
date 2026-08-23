// unit tests for the download-folder source of truth

const fs = require("fs")
const os = require("os")
const path = require("path")

const { SettingsStore } = require("../src/main/services/settings-store")

let root
let store

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-settings-"))
  store = new SettingsStore({
    settingsFile: path.join(root, "settings.json"),
    defaultPath: path.join(root, "default-downloads")
  })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("download path", () => {
  test("falls back to the default when nothing is configured", () => {
    expect(store.getDownloadPath()).toBe(path.join(root, "default-downloads"))
  })

  test("reads the path the settings ui persisted", () => {
    const chosen = path.join(root, "chosen")
    fs.writeFileSync(store.settingsFile, JSON.stringify({ download_path: chosen }))

    expect(store.getDownloadPath()).toBe(chosen)
  })

  test("ignores a blank or malformed settings file", () => {
    fs.writeFileSync(store.settingsFile, "{ not json")
    expect(store.getDownloadPath()).toBe(path.join(root, "default-downloads"))

    fs.writeFileSync(store.settingsFile, JSON.stringify({ download_path: "  " }))
    expect(store.getDownloadPath()).toBe(path.join(root, "default-downloads"))
  })

  test("creates the configured folder on demand", async () => {
    const chosen = path.join(root, "made-on-demand")
    fs.writeFileSync(store.settingsFile, JSON.stringify({ download_path: chosen }))

    expect(await store.ensureDownloadPath()).toBe(chosen)
    expect(fs.existsSync(chosen)).toBe(true)
  })

  test("falls back when the configured folder cannot be created", async () => {
    // a file where a directory should be
    const blocked = path.join(root, "blocked")
    fs.writeFileSync(blocked, "not a directory")
    fs.writeFileSync(
      store.settingsFile,
      JSON.stringify({ download_path: path.join(blocked, "sub") })
    )

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    expect(await store.ensureDownloadPath()).toBe(path.join(root, "default-downloads"))
    warn.mockRestore()
  })

  // chmod does not restrict the superuser, and is a no-op on windows
  const canRevokeWrite =
    typeof process.getuid === "function" && process.getuid() !== 0

  ;(canRevokeWrite ? test : test.skip)(
    "falls back when the configured folder exists but can no longer be written to",
    async () => {
      // the regression this guards: mkdir(recursive:true) succeeds for a
      // directory that is already there, permissions and all - it was never
      // going to notice that this one lost write access after it was chosen
      const chosen = path.join(root, "revoked")
      fs.mkdirSync(chosen)
      fs.chmodSync(chosen, 0o555)
      fs.writeFileSync(
        store.settingsFile,
        JSON.stringify({ download_path: chosen })
      )

      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        expect(await store.ensureDownloadPath()).toBe(
          path.join(root, "default-downloads")
        )
        expect(fs.existsSync(path.join(root, "default-downloads"))).toBe(true)
      } finally {
        fs.chmodSync(chosen, 0o755)
        warn.mockRestore()
      }
    }
  )

  ;(canRevokeWrite ? test : test.skip)(
    "throws when neither the configured folder nor the default can be written to",
    async () => {
      const chosen = path.join(root, "revoked")
      fs.mkdirSync(chosen)
      fs.chmodSync(chosen, 0o555)
      fs.writeFileSync(
        store.settingsFile,
        JSON.stringify({ download_path: chosen })
      )
      fs.mkdirSync(path.join(root, "default-downloads"))
      fs.chmodSync(path.join(root, "default-downloads"), 0o555)

      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        await expect(store.ensureDownloadPath()).rejects.toThrow()
      } finally {
        fs.chmodSync(chosen, 0o755)
        fs.chmodSync(path.join(root, "default-downloads"), 0o755)
        warn.mockRestore()
      }
    }
  )
})

describe("persisting a new path", () => {
  test("writes it and keeps other settings intact", async () => {
    fs.writeFileSync(store.settingsFile, JSON.stringify({ other: "keep me" }))
    const chosen = path.join(root, "new-place")

    expect(await store.setDownloadPath(chosen)).toEqual({ success: true, path: chosen })

    const saved = JSON.parse(fs.readFileSync(store.settingsFile, "utf8"))
    expect(saved.download_path).toBe(chosen)
    expect(saved.other).toBe("keep me")
    // and the very next download resolves there
    expect(store.getDownloadPath()).toBe(chosen)
  })

  test("refuses an unwritable location without saving it", async () => {
    const blocked = path.join(root, "afile")
    fs.writeFileSync(blocked, "x")

    const result = await store.setDownloadPath(path.join(blocked, "nope"))

    expect(result.success).toBe(false)
    expect(store.readDownloadPath()).toBeNull()
  })

  test("rejects an empty path", async () => {
    expect((await store.setDownloadPath("")).success).toBe(false)
  })
})

// a real v4 uuid, not just 36 characters of the right alphabet - a shape-only
// check would pass an id source that stopped being random
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// scratch files from an atomic write, which must never outlive it
function tempFilesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))
}

describe("analytics preferences", () => {
  test("generates an install id once and reuses it", async () => {
    const first = await store.getInstallId()
    const second = await store.getInstallId()

    expect(first).toMatch(UUID_V4)
    expect(second).toBe(first)
  })

  test("gives two installs two different ids", async () => {
    const other = new SettingsStore({
      settingsFile: path.join(root, "other-install", "settings.json")
    })

    const mine = await store.getInstallId()
    const theirs = await other.getInstallId()

    expect(theirs).toMatch(UUID_V4)
    expect(theirs).not.toBe(mine)
  })

  test("mints a single id even when callers race", async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => store.getInstallId())
    )

    // one installation is one identity - a mint already underway has to win
    expect(new Set(ids).size).toBe(1)
    // and the id they all got is the one that actually landed on disk
    expect((await store.readAll()).install_id).toBe(ids[0])
    expect(await store.getInstallId()).toBe(ids[0])
  })

  /**
   * this field is the distinct id on every event analytics sends, and it comes
   * out of a json file a person can open and edit. a non-empty-string check
   * let anything in there become the stable identity the whole installation
   * reports itself by - a name, an email, a machine's hostname.
   *
   * so an entry that is not a uuid is treated as absent and repaired. it is
   * not something the user chose: this field has only ever held what
   * randomUUID() put there.
   */
  describe("an install id that is not one", () => {
    const NOT_IDS = [
      "devansh@example.com",
      "Devansh's MacBook Pro",
      "/Users/devansh",
      "user-1234",
      "",
      "   ",
      42,
      null,
      { id: "11111111-2222-3333-4444-555555555555" },
      // uuid-shaped but not: too short, and a non-hex character
      "11111111-2222-3333-4444-55555555555",
      "gggggggg-2222-3333-4444-555555555555"
    ]

    test("replaces it rather than reporting it", async () => {
      jest.spyOn(console, "warn").mockImplementation(() => {})

      for (const stored of NOT_IDS) {
        const file = path.join(root, `stored-${NOT_IDS.indexOf(stored)}.json`)
        fs.writeFileSync(file, JSON.stringify({ install_id: stored }))

        const other = new SettingsStore({ settingsFile: file })
        const resolved = await other.getInstallId()

        expect(resolved).toMatch(UUID_V4)
        // repaired on disk, so the next launch is the same install
        expect(JSON.parse(fs.readFileSync(file, "utf8")).install_id).toBe(
          resolved
        )
      }

      // and the thing it could not vouch for is never written to the log
      const logged = console.warn.mock.calls.flat().map(String).join(" ")
      expect(logged).not.toContain("devansh")
      expect(logged).not.toContain("MacBook")

      jest.restoreAllMocks()
    })

    test("leaves a real one exactly where it is", async () => {
      const stored = "11111111-2222-3333-4444-555555555555"
      fs.writeFileSync(store.settingsFile, JSON.stringify({ install_id: stored }))

      expect(await store.getInstallId()).toBe(stored)
      expect((await store.readAll()).install_id).toBe(stored)
    })

    test("reports one identity per run when the repair cannot be written", async () => {
      // a file where the settings directory should be, so every write fails.
      // without a remembered mint each read would roll a fresh id, and a
      // single session would report itself as several people
      jest.spyOn(console, "warn").mockImplementation(() => {})

      const blocked = path.join(root, "blocked")
      fs.writeFileSync(blocked, "not a directory")

      const other = new SettingsStore({
        settingsFile: path.join(blocked, "settings.json")
      })

      const ids = [
        await other.getInstallId(),
        await other.getInstallId(),
        await other.getInstallId()
      ]

      expect(ids[0]).toMatch(UUID_V4)
      expect(new Set(ids).size).toBe(1)

      jest.restoreAllMocks()
    })

    test("still prefers a stored id that appears after a failed repair", async () => {
      // the mint is remembered only for want of anything better. an id that
      // turns up in the file afterwards is the installation's real identity
      // and has to win, which is what the re-read on every call is for
      jest.spyOn(console, "warn").mockImplementation(() => {})

      fs.writeFileSync(store.settingsFile, JSON.stringify({ install_id: "nope" }))
      const minted = await store.getInstallId()
      expect(minted).toMatch(UUID_V4)

      const stored = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      fs.writeFileSync(store.settingsFile, JSON.stringify({ install_id: stored }))

      expect(await store.getInstallId()).toBe(stored)

      jest.restoreAllMocks()
    })
  })

  test("defaults analytics to enabled and round-trips a change", async () => {
    expect(await store.isAnalyticsEnabled()).toBe(true)

    expect(await store.setAnalyticsEnabled(false)).toEqual({ success: true })
    expect(await store.isAnalyticsEnabled()).toBe(false)
  })

  test("reports a failed opt-out instead of swallowing it", async () => {
    // a file where the settings folder should be
    const blocked = path.join(root, "not-a-dir")
    fs.writeFileSync(blocked, "x")
    const unwritable = new SettingsStore({
      settingsFile: path.join(blocked, "settings.json")
    })

    const result = await unwritable.setAnalyticsEnabled(false)

    expect(result.success).toBe(false)
    expect(typeof result.error).toBe("string")
    expect(result.error.length).toBeGreaterThan(0)
    // the opt-out really did not stick - the caller has to be told
    expect(await unwritable.isAnalyticsEnabled()).toBe(true)
  })

  // analytics is on by default, so anything that is not a literal false has to
  // read as enabled. a regression here flips a privacy default silently
  test.each([
    ["no key at all", JSON.stringify({ download_path: "/tmp" })],
    ["an empty file", ""],
    ["malformed json", "{ not json"],
    ["a null", JSON.stringify({ analytics_enabled: null })],
    ["a zero", JSON.stringify({ analytics_enabled: 0 })],
    ['the string "false"', JSON.stringify({ analytics_enabled: "false" })]
  ])("stays enabled for %s", async (_label, contents) => {
    fs.writeFileSync(store.settingsFile, contents)

    expect(await store.isAnalyticsEnabled()).toBe(true)
  })

  test("only a literal false turns analytics off", async () => {
    fs.writeFileSync(
      store.settingsFile,
      JSON.stringify({ analytics_enabled: false })
    )

    expect(await store.isAnalyticsEnabled()).toBe(false)
  })

  test("leaves no temp file behind after a successful write", async () => {
    expect(await store.setAnalyticsEnabled(false)).toEqual({ success: true })

    expect(tempFilesIn(root)).toEqual([])
    expect(JSON.parse(fs.readFileSync(store.settingsFile, "utf8"))).toEqual({
      analytics_enabled: false
    })
  })

  // chmod does not restrict the superuser, and is a no-op on windows
  const canRevokeWrite =
    typeof process.getuid === "function" && process.getuid() !== 0

  ;(canRevokeWrite ? test : test.skip)(
    "leaves the previous settings whole when a write fails",
    async () => {
      const chosen = path.join(root, "chosen")
      fs.writeFileSync(
        store.settingsFile,
        JSON.stringify({ download_path: chosen })
      )

      // revoking the right to create entries stops the scratch file, so the
      // write fails before it can replace the target. this is what separates
      // the two implementations: writing in place needs no such permission,
      // so it would have truncated settings.json here quite happily
      fs.chmodSync(root, 0o555)

      try {
        expect((await store.setAnalyticsEnabled(false)).success).toBe(false)
      } finally {
        fs.chmodSync(root, 0o755)
      }

      // a reader still finds the old file, parseable and complete
      const saved = JSON.parse(fs.readFileSync(store.settingsFile, "utf8"))
      expect(saved.download_path).toBe(chosen)
      expect(tempFilesIn(root)).toEqual([])
    }
  )

  test("keeps the download path when analytics settings are written", async () => {
    const chosen = path.join(root, "still-mine")
    await store.setDownloadPath(chosen)
    await store.setAnalyticsEnabled(false)

    const all = await store.readAll()
    expect(all.download_path).toBe(chosen)
    expect(all.analytics_enabled).toBe(false)
  })
})

describe("path info", () => {
  test("reports existence and writability", async () => {
    const chosen = path.join(root, "info")
    fs.mkdirSync(chosen)
    fs.writeFileSync(store.settingsFile, JSON.stringify({ download_path: chosen }))

    expect(await store.getDownloadPathInfo()).toEqual({
      path: chosen,
      exists: true,
      writable: true
    })
  })

  test("reports a missing folder as not existing", async () => {
    fs.writeFileSync(
      store.settingsFile,
      JSON.stringify({ download_path: path.join(root, "gone") })
    )

    const info = await store.getDownloadPathInfo()
    expect(info.exists).toBe(false)
    expect(info.writable).toBe(false)
  })
})
