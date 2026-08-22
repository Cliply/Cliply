/**
 * settings store - the one place the main process reads and writes the
 * download folder, the install id and the analytics preference
 *
 * the python server persisted this to ~/.config/app-data-7c4f/settings.json and
 * the settings ui still round-trips through it, so we read and write the very
 * same file. once the server is gone this stays the source of truth unchanged.
 */

const crypto = require("crypto")
const fs = require("fs")
const fsp = require("fs").promises
const os = require("os")
const path = require("path")

const { APP_CONFIG } = require("../utils/constants")

const SETTINGS_DIR = path.join(os.homedir(), ".config", "app-data-7c4f")
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json")

class SettingsStore {
  constructor(options = {}) {
    this.settingsFile = options.settingsFile || SETTINGS_FILE
    this.defaultPath = options.defaultPath || APP_CONFIG.DOWNLOADS_DIR
    // a mint in progress, so racing callers share one id rather than each
    // rolling their own. it is the work in flight, never a cached result
    this.installIdInFlight = null
  }

  /**
   * the folder downloads should be written to
   * @returns {string} an existing, writable directory
   */
  getDownloadPath() {
    const configured = this.readDownloadPath()

    if (configured) {
      return configured
    }

    return this.defaultPath
  }

  // read is sync so the download handlers can resolve a path without awaiting
  readDownloadPath() {
    try {
      const raw = fs.readFileSync(this.settingsFile, "utf8")
      const parsed = JSON.parse(raw)
      const configured = parsed && parsed.download_path

      return typeof configured === "string" && configured.trim()
        ? configured
        : null
    } catch {
      // no settings yet, or unreadable - the default applies
      return null
    }
  }

  /**
   * make sure the download folder exists, falling back when it cannot be used
   * @returns {Promise<string>} the directory downloads will land in
   */
  async ensureDownloadPath() {
    const target = this.getDownloadPath()

    try {
      await fsp.mkdir(target, { recursive: true })
      return target
    } catch (error) {
      console.warn(
        `download folder ${target} is unusable (${error.message}), falling back`
      )
      await fsp.mkdir(this.defaultPath, { recursive: true })
      return this.defaultPath
    }
  }

  /**
   * persist a new download folder
   * @param {string} newPath - absolute directory
   * @returns {Promise<Object>} {success, path} or {success:false, error}
   */
  async setDownloadPath(newPath) {
    if (!newPath || typeof newPath !== "string") {
      return { success: false, error: "A folder path is required" }
    }

    try {
      await fsp.mkdir(newPath, { recursive: true })

      // prove we can actually write there before saving it
      const probe = path.join(newPath, ".cliply-write-test")
      await fsp.writeFile(probe, "test")
      await fsp.rm(probe, { force: true })
    } catch (error) {
      return {
        success: false,
        error: `Can't write to that folder: ${error.message}`
      }
    }

    try {
      await fsp.mkdir(path.dirname(this.settingsFile), { recursive: true })

      const current = await this.readAll()
      current.download_path = newPath

      await fsp.writeFile(
        this.settingsFile,
        JSON.stringify(current, null, 2),
        "utf8"
      )
    } catch (error) {
      return { success: false, error: error.message }
    }

    return { success: true, path: newPath }
  }

  async readAll() {
    try {
      const raw = await fsp.readFile(this.settingsFile, "utf8")
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * the shape the settings ipc returns
   * @returns {Promise<Object>} {path, exists, writable}
   */
  async getDownloadPathInfo() {
    const target = this.getDownloadPath()
    let exists = false
    let writable = false

    try {
      const stats = await fsp.stat(target)
      exists = stats.isDirectory()
    } catch {
      exists = false
    }

    if (exists) {
      try {
        await fsp.access(target, fs.constants.W_OK)
        writable = true
      } catch {
        writable = false
      }
    }

    return { path: target, exists, writable }
  }

  /**
   * merge a patch into settings.json without clobbering other keys
   *
   * the new contents go to a scratch file first and are renamed over the
   * target, so a reader finds either the old file or the new one and never a
   * half-written one. writing in place would truncate settings.json before
   * refilling it, and a crash in that window loses the download folder - or an
   * opt-out, which then quietly reads as analytics-enabled at the next launch.
   * @param {Object} patch
   */
  async writeSettings(patch) {
    const current = await this.readAll()
    const next = { ...current, ...patch }

    const dir = path.dirname(this.settingsFile)
    await fsp.mkdir(dir, { recursive: true })

    // beside the target, so the rename stays within one filesystem, and
    // uniquely named so concurrent writers cannot share a scratch file
    const temp = path.join(dir, `.settings-${crypto.randomUUID()}.tmp`)

    try {
      await fsp.writeFile(temp, JSON.stringify(next, null, 2), "utf8")
      await fsp.rename(temp, this.settingsFile)
    } catch (error) {
      // never leave scratch files behind, and never report the cleanup's
      // problem in place of the one that actually failed the write
      await fsp.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * a random id for this installation. not derived from the machine or the
   * person - it is a dice roll, and reinstalling produces a new one.
   *
   * callers arriving together share one mint. without that, each would read
   * an absent id and roll its own, and a single installation would report
   * itself as several - only the last write surviving to the next launch.
   * @returns {Promise<string>}
   */
  async getInstallId() {
    if (!this.installIdInFlight) {
      this.installIdInFlight = this.resolveInstallId()
    }

    const inFlight = this.installIdInFlight

    try {
      return await inFlight
    } finally {
      // cleared once it settles rather than kept: a later call re-reads the
      // file, so an id the settings ui changed underneath is still picked up
      if (this.installIdInFlight === inFlight) {
        this.installIdInFlight = null
      }
    }
  }

  /**
   * read the stored id, or mint and persist one. never rejects
   * @returns {Promise<string>}
   */
  async resolveInstallId() {
    const settings = await this.readAll()

    if (typeof settings.install_id === "string" && settings.install_id.length) {
      return settings.install_id
    }

    const installId = crypto.randomUUID()

    try {
      await this.writeSettings({ install_id: installId })
    } catch (error) {
      // an unwritable settings file must not break the caller - this run just
      // gets an id that will not survive a restart
      console.warn(`could not persist the install id (${error.message})`)
    }

    return installId
  }

  /** @returns {Promise<boolean>} analytics is on unless the user turned it off */
  async isAnalyticsEnabled() {
    const settings = await this.readAll()
    return settings.analytics_enabled !== false
  }

  /**
   * a privacy control, so a failed write must be reported rather than
   * swallowed - an opt-out that silently fails to persist comes back on at
   * the next launch
   * @param {boolean} enabled
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async setAnalyticsEnabled(enabled) {
    try {
      await this.writeSettings({ analytics_enabled: Boolean(enabled) })
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }
}

module.exports = { SettingsStore, SETTINGS_FILE }
