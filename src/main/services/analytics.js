// the only place telemetry leaves the app. the renderer routes through ipc to
// here, so the opt-out gate, the allowlist and the redaction below cannot be
// bypassed.

const os = require("os")
const { APP_CONFIG, SUPPORTED_PLATFORMS } = require("../utils/constants")
const { redactLogLine } = require("./ytdlp-engine")
const { getAppVersion } = require("../utils/analytics-helpers")
const {
  ERROR_CATEGORIES,
  ERROR_STAGES
} = require("../utils/error-taxonomy")

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

/**
 * the shape each property is allowed to have. an allowed name is only half a
 * privacy boundary - `platform` set to a url would have left verbatim.
 *
 * kinds rather than per-property enums on purpose: an enum would have to list
 * every platform, quality and bucket label this app will ever produce, and
 * would silently drop the ones a later task adds without updating this file.
 * a shape check stays true as the vocabulary grows.
 */
const PROPERTY_KINDS = {
  // flags
  is_first_launch: "bool",
  is_trimmed: "bool",
  success: "bool",
  has_youtube_cookies: "bool",

  // counts and measures
  formats_count: "number",
  file_size_mb: "number",
  progress_at_failure: "number",
  progress_at_cancel: "number",

  // a controlled vocabulary that normalizes instead of dropping
  platform: "platform",

  // lowercase identifiers from a vocabulary this app controls
  url_kind: "slug",
  media_type: "slug",
  quality: "slug",
  audio_format: "slug",
  reason: "slug",
  update_reason: "slug",

  // version strings, which must lead with a digit - that is what a filename
  // cannot do
  previous_version: "version",
  engine_version: "version",
  from_version: "version",
  to_version: "version",

  // pre-bucketed measurements, never a raw one
  duration_bucket: "bucket",
  elapsed_bucket: "bucket",
  speed_bucket: "bucket",
  load_ms_bucket: "bucket",

  // checked against the taxonomy itself, not a copy of it
  error_category: "error_category",
  error_stage: "error_stage",

  // free text, scrubbed and clipped
  error_message: "text"
}

const KIND_BY_PROPERTY = new Map(Object.entries(PROPERTY_KINDS))

/**
 * one charset for all short strings could not work, and did not: a single
 * grammar wide enough for "1-5 min" also admitted "My Holiday Video", and one
 * that allowed "2026.08.19" also allowed "vacation.mp4". a character allowlist
 * cannot tell a controlled label from prose or a basename - only a grammar
 * shaped like the specific thing can.
 */

// a lowercase identifier. no spaces and no dots, which is what stops a title
// and a filename respectively
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

// digits and dots, with an optional prerelease tail. leading with a digit was
// not enough on its own: "2024.mp4" leads with one too. letters are only
// reachable after a `-`, which is the one place a version legitimately has
// them ("1.2.3-beta.1"), and a filename extension cannot get there.
const VERSION_PATTERN = /^[0-9][0-9.]{0,30}(?:-[A-Za-z0-9.]{1,16})?$/

// a pre-bucketed measurement: leads with a digit or a comparison, ends in a
// short unit. "1-5 min", "<1m", "10-50 MB", "60+ min"
//
// the trailing `+` is admitted because an open-ended top bucket is written
// that way more often than any other, and a grammar that forbids the reflex
// spelling buys nothing: ">60 min" carries the identical information, so the
// only thing rejecting "60+ min" achieves is a dropped event behind a warning
// production never shows anyone. still anchored on a digit or a comparison,
// so no title or filename becomes reachable.
//
// the unit is required, not optional: without it a bare "2024" was a valid
// bucket, and a unitless label is unreadable in a chart anyway - so demanding
// one tightens the boundary and improves the data at the same time.
const BUCKET_PATTERN = /^[<>]?[0-9]+(-[0-9]+)?\+?\s?[a-zA-Z]{1,4}$/

/**
 * the error vocabularies are referenced, never copied. task 2 made the
 * taxonomy the single source of truth, so a category added there validates
 * here for free - and a typo'd one becomes a loud drop instead of a bad
 * segment sitting in posthog forever.
 */
const ERROR_CATEGORY_VALUES = new Set(Object.values(ERROR_CATEGORIES))
const ERROR_STAGE_VALUES = new Set(Object.values(ERROR_STAGES))

// what an unrecognised platform becomes. it is not a drop: which unsupported
// sites people paste is one of the questions analytics exists to answer
const PLATFORM_UNSUPPORTED = "unsupported"

/**
 * the platforms a value may name.
 *
 * SUPPORTED_PLATFORMS is imported rather than copied, but it is not the whole
 * set: it lists youtube, instagram and tiktok, while the engine's own
 * download list (SUPPORTED_DOWNLOAD_PLATFORMS, ipc-handlers.js:43) lists
 * youtube, pinterest and tiktok. the two are not mirrors. pinterest is fully
 * supported - it has dedicated handling in ipc-handlers and its own
 * extractQuality mapping - so validating against SUPPORTED_PLATFORMS alone
 * would relabel a real platform as unsupported.
 *
 * pinterest is therefore the one name written out here. that list is
 * module-local to ipc-handlers and cannot be imported: analytics is about to
 * become one of ipc-handlers' dependencies, so requiring it back would be a
 * cycle, and it pulls in electron besides. the real fix is one list instead
 * of two, which is not this task's to make.
 */
const KNOWN_PLATFORMS = new Set([
  ...Object.keys(SUPPORTED_PLATFORMS).map((key) => key.toLowerCase()),
  "pinterest",
  "unknown",
  PLATFORM_UNSUPPORTED
])

const MAX_TEXT_LENGTH = 500
const MAX_NUMBER = 1e9

/**
 * check a value against its kind, returning the value to send.
 *
 * never coerces and never stringifies: the input may be a hostile object from
 * the renderer, and asking it for a string is asking it to run code.
 * @returns {{ok: boolean, value?: *}}
 */
function checkKind(kind, value) {
  switch (kind) {
    case "bool":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false }

    case "number":
      // isFinite does not coerce, so "5" and NaN both fail here
      return Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER
        ? { ok: true, value }
        : { ok: false }

    case "slug":
      return typeof value === "string" && SLUG_PATTERN.test(value)
        ? { ok: true, value }
        : { ok: false }

    // the one kind that rewrites rather than rejects. a name we do not know
    // is far more likely to be an unsupported site than a leak, and which
    // sites people try is data worth having - so the event goes out carrying
    // "unsupported" rather than being dropped over its platform. a non-string
    // is still a plain drop: that is a caller bug, not an unknown site.
    case "platform":
      if (typeof value !== "string") return { ok: false }
      if (KNOWN_PLATFORMS.has(value)) return { ok: true, value }
      return { ok: true, value: PLATFORM_UNSUPPORTED, normalized: true }

    case "version":
      return typeof value === "string" && VERSION_PATTERN.test(value)
        ? { ok: true, value }
        : { ok: false }

    case "bucket":
      return typeof value === "string" && BUCKET_PATTERN.test(value)
        ? { ok: true, value }
        : { ok: false }

    case "error_category":
      return typeof value === "string" && ERROR_CATEGORY_VALUES.has(value)
        ? { ok: true, value }
        : { ok: false }

    case "error_stage":
      return typeof value === "string" && ERROR_STAGE_VALUES.has(value)
        ? { ok: true, value }
        : { ok: false }

    case "text":
      return typeof value === "string"
        ? { ok: true, value: redactLogLine(value).slice(0, MAX_TEXT_LENGTH) }
        : { ok: false }

    default:
      return { ok: false }
  }
}

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
   *
   * validated here rather than trusted, because this is the only caller
   * supplied value that reaches superProperties - and capture() spreads those
   * last, so an unchecked one would ride every event and outrank even a
   * validated caller value.
   */
  setEngineVersion(version) {
    if (!version) return

    const checked = checkKind("version", version)

    if (!checked.ok) {
      console.warn("analytics: ignored an engine version, expected version")
      return
    }

    this.engineVersion = checked.value
    this.superProperties.engine_version = checked.value
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

        // absence is free and silent. a first launch has no previous version
        // and a cancel may have no progress yet - legitimate states, not
        // defects. warning on those would fire on every clean install, and a
        // channel that cries during normal operation is one people stop
        // reading, taking the real privacy drops down with it. note this is a
        // null check, not a truthiness one: `false` and `0` are values.
        if (value === null || value === undefined) continue

        const kind = KIND_BY_PROPERTY.get(key)

        if (!kind) {
          // allowed but unkinded - a gap in this file, not a caller's fault.
          // the test that walks ALLOWED_PROPERTIES exists to prevent it
          console.warn(
            `analytics: dropped ${safeLabel(key)} on ${label}, no kind declared`
          )
          continue
        }

        const checked = checkKind(kind, value)

        if (!checked.ok) {
          // the key and the expected kind, never the value: the value is the
          // suspected pii, and this warning may end up in a log a user sends us
          console.warn(
            `analytics: dropped ${safeLabel(key)} on ${label}, expected ${kind}`
          )
          continue
        }

        if (checked.normalized) {
          // a normalization is information, so it is still reported - naming
          // the replacement, which is a reserved constant, and never the
          // original, which is the value we could not vouch for
          console.warn(
            `analytics: normalized ${safeLabel(key)} on ${label} to ${checked.value}`
          )
        }

        safe[key] = checked.value
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

// the client factory stays private: this module being the only way out is the
// whole basis of the privacy argument. the schema is exported because it emits
// nothing and later tasks need to assert against it.
module.exports = { Analytics, ALLOWED_PROPERTIES, PROPERTY_KINDS }
