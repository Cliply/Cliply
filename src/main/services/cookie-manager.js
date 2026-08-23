/**
 * cookie manager - simple file-based cookie management for desktop app
 * no http api needed - uses file operations and electron dialogs
 */

const fs = require("fs").promises
const { readFileSync } = require("fs")
const path = require("path")
const { APP_CONFIG } = require("../utils/constants")
// the engine reads the same jar with the same parser - see utils/cookie-jar
const { inspectCookieContent } = require("../utils/cookie-jar")

// written by older builds; it claimed the cookies worked when all it knew was
// that the file existed, so it is stripped wherever status is read or written
const LEGACY_STATUS_KEYS = ["working"]

function withoutLegacyKeys(status) {
  const cleaned = { ...status }

  for (const key of LEGACY_STATUS_KEYS) {
    delete cleaned[key]
  }

  return cleaned
}

class CookieManager {
  constructor() {
    this.cookieDir = APP_CONFIG.COOKIES_DIR
    this.cookieFile = path.join(this.cookieDir, "youtube_cookies.txt")
    this.statusFile = path.join(this.cookieDir, "cookie_status.json")
    this.isValid = false
    this.lastTest = null

    this.initialize()
  }

  /**
   * initialize cookie manager
   */
  async initialize() {
    try {
      // create cookie directory if it doesn't exist
      await fs.mkdir(this.cookieDir, { recursive: true })

      // create empty cookie file if it doesn't exist
      await this.ensureCookieFile()

      // check if cookies are valid
      this.isValid = await this.validateCookieFile()

    } catch (error) {
      console.error("cookie manager initialization failed:", error)
    }
  }

  /**
   * ensure cookie file exists with proper format
   */
  async ensureCookieFile() {
    try {
      await fs.access(this.cookieFile)
    } catch (error) {
      // file doesn't exist, create empty one
      await this.createEmptyCookieFile()
    }
  }

  /**
   * create empty cookie file with proper netscape format
   */
  async createEmptyCookieFile() {
    const emptyContent = `# Netscape HTTP Cookie File
# This is a generated file! Do not edit.

`

    try {
      await fs.writeFile(this.cookieFile, emptyContent, "utf8")
    } catch (error) {
      console.error("failed to create cookie file:", error)
    }
  }

  /**
   * describe what the cookie jar actually holds
   *
   * "has some non-comment lines" was too weak: an expired jar, or one exported
   * for an unrelated site, would still be treated as a working youtube login.
   *
   * @returns {Promise<Object>} {total, youtube, expired, usable}
   */
  async inspectCookieFile(now = Date.now()) {
    try {
      const content = await fs.readFile(this.cookieFile, "utf8")

      return inspectCookieContent(content, now)
    } catch (error) {
      console.error("failed to read cookie file:", error.message)
      return { total: 0, youtube: 0, expired: 0, usable: false }
    }
  }

  /**
   * check if cookie file has usable youtube cookies
   * @returns {Promise<boolean>} true if a live youtube cookie is present
   */
  async validateCookieFile() {
    const { usable } = await this.inspectCookieFile()

    return usable
  }

  /**
   * import cookies from content string
   * @param {string} cookieContent - cookie file content
   * @returns {Promise<boolean>} success status
   */
  async importCookies(cookieContent) {
    try {
      // validate content format
      if (!cookieContent || !cookieContent.trim()) {
        throw new Error("cookie content is empty")
      }

      // ensure proper netscape format header
      let content = cookieContent.trim()
      if (!content.startsWith("# Netscape HTTP Cookie File")) {
        content = `# Netscape HTTP Cookie File
# This is a generated file! Do not edit.

${content}`
      }

      // write to file
      await fs.writeFile(this.cookieFile, content, "utf8")

      // validate the imported cookies
      this.isValid = await this.validateCookieFile()

      // update status
      await this.updateStatus({
        lastImport: new Date().toISOString(),
        valid: this.isValid,
        size: content.length
      })

      return this.isValid
    } catch (error) {
      console.error("failed to import cookies:", error)
      return false
    }
  }

  /**
   * import cookies from file path
   * @param {string} filePath - path to cookie file
   * @returns {Promise<boolean>} success status
   */
  async importCookieFile(filePath) {
    try {
      // read the cookie file
      const content = await fs.readFile(filePath, "utf8")

      // validate it's a cookie file
      if (!content.includes("# Netscape HTTP Cookie File")) {
        throw new Error(
          "invalid cookie file format. please select a netscape format cookie file."
        )
      }

      // import the content
      return await this.importCookies(content)
    } catch (error) {
      console.error("failed to import cookie file:", error.message)
      throw error
    }
  }

  /**
   * re-read the jar and recompute isValid, synchronously
   *
   * isValid used to be computed once at startup and then trusted: a jar
   * replaced by hand, or one whose cookies expired while the app stayed open,
   * kept its old verdict until something happened to call refresh(). downloads
   * then either skipped a perfectly good jar or passed a dead one. nothing is
   * cached here on purpose - a cookie jar is a few kilobytes, the engine
   * already re-reads it per operation, and both staleness modes need a fresh
   * read anyway (expiry is a function of the clock, not of the file).
   *
   * @returns {boolean} whether the jar holds a live youtube cookie
   */
  revalidate() {
    try {
      this.isValid = inspectCookieContent(
        readFileSync(this.cookieFile, "utf8")
      ).usable
    } catch {
      // missing or unreadable file - the same answer either way
      this.isValid = false
    }

    return this.isValid
  }

  /**
   * get cookie file path for yt-dlp
   * @returns {string|null} path to cookie file or null if invalid
   */
  getCookieFilePath() {
    return this.revalidate() ? this.cookieFile : null
  }

  /**
   * check if we have valid cookies
   * @returns {boolean} true if cookies are valid
   */
  hasValidCookies() {
    return this.revalidate()
  }

  // testCookies() used to live here. It reported working: this.isValid with the
  // note "handled by Python server" - the file simply existing was presented as
  // proof the cookies worked. Nothing called it, and the ipc cookie test now
  // owns this, so the claim is gone rather than left to be found and reused.

  /**
   * get cookie status information
   * @returns {Promise<Object>} cookie status
   */
  async getStatus() {
    // the jar may have been replaced or expired since anyone last looked
    this.revalidate()

    try {
      // try to read existing status
      const statusContent = await fs.readFile(this.statusFile, "utf8")
      // a status file written by an older build still carries "working"
      const status = withoutLegacyKeys(JSON.parse(statusContent))

      // add current file info
      const stats = await fs.stat(this.cookieFile)
      status.fileSize = stats.size
      status.fileModified = stats.mtime.toISOString()
      status.valid = this.isValid
      status.cookiesLoaded = this.isValid

      return status
    } catch (error) {
      // return default status if file doesn't exist or is invalid
      return {
        valid: this.isValid,
        cookiesLoaded: this.isValid,
        lastImport: null,
        lastTest: this.lastTest,
        fileSize: 0,
        fileModified: null
      }
    }
  }

  /**
   * update cookie status
   * @param {Object} updates - status updates
   */
  async updateStatus(updates) {
    try {
      const currentStatus = await this.getStatus()
      // strip here too, so a caller cannot write the retired key back in
      const newStatus = withoutLegacyKeys({ ...currentStatus, ...updates })

      await fs.writeFile(
        this.statusFile,
        JSON.stringify(newStatus, null, 2),
        "utf8"
      )
    } catch (error) {
      console.error("failed to update cookie status:", error)
    }
  }

  /**
   * clear cookies (reset to empty file)
   * @returns {Promise<boolean>} success status
   */
  async clearCookies() {
    try {
      await this.createEmptyCookieFile()
      this.isValid = false

      await this.updateStatus({
        lastClear: new Date().toISOString(),
        valid: false,
        cookiesLoaded: false,
        extractionCheck: "skipped",
        note: "No cookies imported"
      })

      return true
    } catch (error) {
      console.error("failed to clear cookies:", error)
      return false
    }
  }

  /**
   * get cookie file size and basic info
   * @returns {Promise<Object>} cookie file info
   */
  async getFileInfo() {
    try {
      const stats = await fs.stat(this.cookieFile)
      const inspection = await this.inspectCookieFile()

      // the inspection just answered the question - keep the field in step
      this.isValid = inspection.usable

      return {
        exists: true,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        cookieCount: inspection.total,
        youtubeCookieCount: inspection.youtube,
        expiredCookieCount: inspection.expired,
        valid: this.isValid,
        path: this.cookieFile
      }
    } catch (error) {
      return {
        exists: false,
        size: 0,
        modified: null,
        cookieCount: 0,
        valid: false,
        path: this.cookieFile,
        error: error.message
      }
    }
  }

  /**
   * refresh cookie validation status
   * @returns {Promise<boolean>} new validation status
   */
  async refresh() {
    this.isValid = await this.validateCookieFile()
    return this.isValid
  }
}

module.exports = CookieManager
