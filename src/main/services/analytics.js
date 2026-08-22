// the only place telemetry leaves the app. the renderer routes through ipc to
// here, so the opt-out gate and the redaction below cannot be bypassed.

const os = require("os")
const { APP_CONFIG } = require("../utils/constants")
const { redactLogLine } = require("./ytdlp-engine")
const { getAppVersion } = require("../utils/analytics-helpers")

// properties whose values are free text and must be scrubbed before sending
const REDACTED_PROPERTIES = ["error_message"]

// electron is not present under jest, so the locale lookup must degrade
// instead of exploding at require time
function readLocale() {
  try {
    const { app } = require("electron")
    return typeof app?.getLocale === "function" ? app.getLocale() : "unknown"
  } catch {
    return "unknown"
  }
}

function defaultCreateClient(key, host) {
  const { PostHog } = require("posthog-node")
  return new PostHog(key, {
    host,
    // do not delete this as redundant - the sdk's own jsdoc says it defaults
    // to false, and that is wrong. the compiled source reads
    // `options.disableGeoip ?? true` (@posthog/core, posthog-core-stateless),
    // confirmed by constructing a client both ways: omitted gives true.
    // the node sdk assumes a server, where geoip on the server's own ip is
    // meaningless. in electron the machine IS the client, so without this
    // line country/region/city silently never arrive.
    disableGeoip: false,
    flushAt: 20,
    flushInterval: 10000
  })
}

class Analytics {
  /**
   * @param {Object} options
   * @param {Object} options.settingsStore - provides install id + preference
   * @param {Function} [options.createClient] - injected for tests
   * @param {boolean} [options.forceEnabled] - bypasses the dev-build check
   */
  constructor({
    settingsStore,
    createClient = defaultCreateClient,
    forceEnabled
  } = {}) {
    this.settingsStore = settingsStore
    this.createClient = createClient
    this.client = null
    this.installId = null
    this.enabled = false
    this.superProperties = {}
    // kept apart from superProperties because init() rebuilds those wholesale
    this.engineVersion = null

    this.allowedInThisBuild =
      typeof forceEnabled === "boolean"
        ? forceEnabled
        : process.env.NODE_ENV === "production" ||
          process.env.CLIPLY_ANALYTICS_DEV === "1"
  }

  async init() {
    if (!APP_CONFIG.ANALYTICS_CONFIG.ENABLED || !this.allowedInThisBuild) {
      return
    }

    try {
      this.enabled = await this.settingsStore.isAnalyticsEnabled()
      if (!this.enabled) return

      // read once, not per event: the store deliberately re-reads settings on
      // every call so the settings ui cannot go stale against it
      this.installId = await this.settingsStore.getInstallId()
      this.superProperties = {
        app_version: getAppVersion(),
        os: process.platform,
        os_version: os.release(),
        arch: process.arch,
        locale: readLocale()
      }

      // the engine is probed once per run, so whatever it reported has to be
      // put back after the rebuild - nothing would set it a second time
      if (this.engineVersion) {
        this.superProperties.engine_version = this.engineVersion
      }

      this.client = this.createClient(
        APP_CONFIG.ANALYTICS_CONFIG.POSTHOG_KEY,
        APP_CONFIG.ANALYTICS_CONFIG.POSTHOG_HOST
      )
    } catch (error) {
      // telemetry must never take the app down with it
      console.warn("analytics init failed:", error.message)
      this.client = null
    }
  }

  isEnabled() {
    return Boolean(this.enabled && this.client)
  }

  /**
   * set once the engine version is known, so every later event carries it.
   * a falsy version is ignored rather than stored: a probe that failed must
   * not erase what a successful one already established.
   */
  setEngineVersion(version) {
    if (!version) return

    this.engineVersion = version
    this.superProperties.engine_version = version
  }

  /**
   * @param {string} event
   * @param {Object} [properties]
   */
  capture(event, properties = {}) {
    if (!this.isEnabled()) return

    try {
      const safe = { ...properties }

      for (const key of REDACTED_PROPERTIES) {
        if (typeof safe[key] === "string") {
          safe[key] = redactLogLine(safe[key])
        }
      }

      this.client.capture({
        distinctId: this.installId,
        event,
        properties: { ...this.superProperties, ...safe }
      })
    } catch (error) {
      console.warn(`analytics capture failed for ${event}:`, error.message)
    }
  }

  /**
   * events batch on an interval, so whatever is still queued at quit is lost
   * unless this runs first
   */
  async flush() {
    if (!this.client) return

    try {
      await this.client.flush()
    } catch (error) {
      console.warn("analytics flush failed:", error.message)
    }
  }

  /**
   * user toggled the preference. turning it off stops the client immediately.
   * @param {boolean} enabled
   * @returns {Promise<Object>} the store's {success, error?} - the caller
   *   decides what to tell the user about a write that did not stick
   */
  async setEnabled(enabled) {
    const persisted = await this.settingsStore.setAnalyticsEnabled(enabled)

    // stop sending regardless - honouring the user's intent this session is
    // more important than the write succeeding. the caller surfaces the
    // failure so the user is not told an opt-out stuck when it did not.
    if (!enabled) {
      await this.flush()
      this.enabled = false
      this.client = null
      return persisted
    }

    this.enabled = true
    if (!this.client) await this.init()
    return persisted
  }
}

module.exports = { Analytics }
