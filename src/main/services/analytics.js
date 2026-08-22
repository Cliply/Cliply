// the only place telemetry leaves the app. the renderer routes through ipc to
// here, so the opt-out gate, the allowlist and the redaction below cannot be
// bypassed.

const os = require("os")
const { APP_CONFIG } = require("../utils/constants")
const { redactLogLine } = require("./ytdlp-engine")
const { getAppVersion } = require("../utils/analytics-helpers")

/**
 * every event we send, and every property it may carry. anything absent is
 * dropped rather than forwarded.
 *
 * this is the privacy contract, not documentation of it. a denylist would
 * only stop the leaks we thought of; this stops the ones a later caller
 * invents - a url, a title, a filename, a path - because it has to be added
 * here on purpose before it can leave. the renderer's events arrive over ipc
 * as an untrusted property bag, and this is what makes forwarding them safe.
 *
 * adding an event or a property here is a deliberate privacy decision. if a
 * later task finds this list in its way, that is the point of it.
 */
const ALLOWED_PROPERTIES = {
  app_launched: ["is_first_launch", "previous_version", "engine_version"],
  url_submitted: ["platform", "url_kind"],
  media_info_loaded: [
    "platform",
    "duration_bucket",
    "formats_count",
    "load_ms_bucket"
  ],
  media_info_failed: [
    "platform",
    "error_category",
    "error_stage",
    "error_message"
  ],
  download_started: [
    "platform",
    "media_type",
    "quality",
    "is_trimmed",
    "audio_format"
  ],
  download_completed: [
    "platform",
    "media_type",
    "quality",
    "is_trimmed",
    "file_size_mb",
    "elapsed_bucket",
    "speed_bucket"
  ],
  download_failed: [
    "platform",
    "media_type",
    "quality",
    "is_trimmed",
    "error_category",
    "error_stage",
    "error_message",
    "progress_at_failure"
  ],
  download_cancelled: ["platform", "media_type", "progress_at_cancel"],
  engine_seeded: ["reason", "engine_version", "elapsed_bucket"],
  engine_updated: ["from_version", "to_version"],
  engine_update_failed: ["update_reason", "error_message"],
  cookies_imported: ["success", "has_youtube_cookies"]
}

// built once, so a capture is a set lookup rather than a scan
const ALLOWED_BY_EVENT = new Map(
  Object.entries(ALLOWED_PROPERTIES).map(([event, keys]) => [
    event,
    new Set(keys)
  ])
)

// properties whose values are free text and must be scrubbed before sending
const REDACTED_PROPERTIES = new Set(["error_message"])

/**
 * a printable label for something that may not be printable. a Symbol event
 * name or an object with a throwing toString would otherwise blow up the very
 * console.warn meant to report it - out of telemetry and into a download.
 */
function safeLabel(value) {
  try {
    return String(value)
  } catch {
    return "<unprintable>"
  }
}

/** a message for anything a throw site may have produced, including null */
function describeError(error) {
  try {
    return error && error.message ? String(error.message) : String(error)
  } catch {
    return "unknown error"
  }
}

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
      console.warn("analytics init failed:", describeError(error))
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
   * send one event, keeping only the properties ALLOWED_PROPERTIES lists for
   * it. an unlisted event sends nothing at all.
   * @param {string} event
   * @param {Object} [properties]
   */
  capture(event, properties = {}) {
    if (!this.isEnabled()) return

    // resolved before the try, so the catch below can name the event without
    // risking a second throw on a value that will not print
    const label = safeLabel(event)

    try {
      const allowed = ALLOWED_BY_EVENT.get(event)

      if (!allowed) {
        console.warn(`analytics: dropped unknown event ${label}`)
        return
      }

      const safe = {}

      // read the caller's bag once, defensively: it arrives from the renderer
      // over ipc and is not ours to trust
      for (const [key, value] of Object.entries(properties || {})) {
        if (!allowed.has(key)) {
          console.warn(
            `analytics: dropped unlisted property ${safeLabel(key)} on ${label}`
          )
          continue
        }

        safe[key] =
          REDACTED_PROPERTIES.has(key) && typeof value === "string"
            ? redactLogLine(value)
            : value
      }

      // super properties last: this module sets them itself, so a caller
      // cannot shadow app_version or os with a value of its own
      this.client.capture({
        distinctId: this.installId,
        event,
        properties: { ...safe, ...this.superProperties }
      })
    } catch (error) {
      console.warn(
        `analytics capture failed for ${label}:`,
        describeError(error)
      )
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
      console.warn("analytics flush failed:", describeError(error))
    }
  }

  /**
   * user toggled the preference. turning it off stops the client immediately.
   * @param {boolean} enabled
   * @returns {Promise<Object>} the store's {success, error?} - the caller
   *   decides what to tell the user about a write that did not stick
   */
  async setEnabled(enabled) {
    let persisted

    // the store catches its own write failures today, but this module's
    // never-throws contract cannot rest on a collaborator's internals
    try {
      persisted = await this.settingsStore.setAnalyticsEnabled(enabled)
    } catch (error) {
      persisted = { success: false, error: describeError(error) }
    }

    // stop sending regardless - honouring the user's intent this session is
    // more important than the write succeeding, so a failed opt-out still
    // goes inert here. the caller surfaces the failure so the user is not
    // told an opt-out stuck when it did not.
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

// defaultCreateClient is exported so a test can pin the real client's options
// - disableGeoip in particular cannot be protected by a comment alone
module.exports = { Analytics, defaultCreateClient, ALLOWED_PROPERTIES }
