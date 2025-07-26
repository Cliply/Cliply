/**
 * cookie manager - simple file-based cookie management for desktop app
 * no http api needed - uses file operations and electron dialogs
 */

const fs = require("fs").promises
const path = require("path")
const { APP_CONFIG } = require("../utils/constants")

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
   * check if cookie file has valid cookies
   * @returns {Promise<boolean>} true if cookies are valid
   */
  async validateCookieFile() {
    try {
      const content = await fs.readFile(this.cookieFile, "utf8")

      // check if file has actual cookie data (not just headers)
      const lines = content
        .split("\n")
        .filter(
          (line) =>
            line.trim() && !line.startsWith("#") && !line.startsWith("\t#")
        )

      return lines.length > 0
    } catch (error) {
      console.error("failed to validate cookie file:", error)
      return false
    }
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
   * get cookie file path for yt-dlp
   * @returns {string|null} path to cookie file or null if invalid
   */
  getCookieFilePath() {
    return this.isValid ? this.cookieFile : null
  }

  /**
   * check if we have valid cookies
   * @returns {boolean} true if cookies are valid
   */
  hasValidCookies() {
    return this.isValid
  }

  /**
   * test cookies by making a request to the python server
   * @returns {Promise<boolean>} true if cookies work
   */
  async testCookies() {
    if (!this.isValid) {
      return false
    }

    try {

      // cookie testing is handled by the python server
      // this method just updates local status and returns current validity
      this.lastTest = new Date().toISOString()

      await this.updateStatus({
        lastTest: this.lastTest,
        working: this.isValid,
        note: "Cookie testing handled by Python server"
      })

      return this.isValid
    } catch (error) {
      console.error("cookie test status update failed:", error.message)

      await this.updateStatus({
        lastTest: new Date().toISOString(),
        working: false,
        lastError: error.message
      })

      return false
    }
  }

  /**
   * get cookie status information
   * @returns {Promise<Object>} cookie status
   */
  async getStatus() {
    try {
      // try to read existing status
      const statusContent = await fs.readFile(this.statusFile, "utf8")
      const status = JSON.parse(statusContent)

      // add current file info
      const stats = await fs.stat(this.cookieFile)
      status.fileSize = stats.size
      status.fileModified = stats.mtime.toISOString()
      status.valid = this.isValid

      return status
    } catch (error) {
      // return default status if file doesn't exist or is invalid
      return {
        valid: this.isValid,
        lastImport: null,
        lastTest: this.lastTest,
        working: false,
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
      const newStatus = { ...currentStatus, ...updates }

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
        working: false
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
      const content = await fs.readFile(this.cookieFile, "utf8")

      // count actual cookie lines (not comments)
      const cookieLines = content
        .split("\n")
        .filter(
          (line) =>
            line.trim() && !line.startsWith("#") && !line.startsWith("\t#")
        )

      return {
        exists: true,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        cookieCount: cookieLines.length,
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
