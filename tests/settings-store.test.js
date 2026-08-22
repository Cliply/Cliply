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

describe("analytics preferences", () => {
  test("generates an install id once and reuses it", async () => {
    const first = await store.getInstallId()
    const second = await store.getInstallId()

    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).toBe(first)
  })

  test("defaults analytics to enabled and round-trips a change", async () => {
    expect(await store.isAnalyticsEnabled()).toBe(true)

    await store.setAnalyticsEnabled(false)
    expect(await store.isAnalyticsEnabled()).toBe(false)
  })

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
