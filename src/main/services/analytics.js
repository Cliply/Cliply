// the only place telemetry leaves the app. the renderer routes through ipc to
// here, so the opt-out gate, the allowlist and the redaction cannot be
// bypassed.
//
// the three of those live beside this file rather than in it: analytics/
// schema.js is what each event may carry and in what vocabulary, analytics/
// redact.js the sanitizer for the one free-text property, analytics/validate.js
// the kind check every value passes through, and analytics/environment.js the
// facts about this install. this file is the class that consults them, and the
// only export surface any of it has.

const { APP_CONFIG } = require("../utils/constants")
const { redactLogLine } = require("../utils/log-redaction")
const { describeError, getAppVersion } = require("../utils/analytics-helpers")
const {
  ALLOWED_BY_EVENT,
  ALLOWED_PROPERTIES,
  ENVIRONMENT_DEVELOPMENT,
  ENVIRONMENT_PRODUCTION,
  KIND_BY_PROPERTY,
  PROPERTY_KINDS
} = require("./analytics/schema")
const { checkKind, safeLabel } = require("./analytics/validate")
const {
  checkSuperProperties,
  defaultCreateClient,
  drainClient,
  isPackagedBuild,
  kernelVersion,
  readLocale,
  retireClient
} = require("./analytics/environment")

// describeError moved to utils/analytics-helpers.js: the ipc layer and the
// download runner make the same never-throw promise this module does, and were
// each guarding it with a weaker spelling of the same thing

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
    this.potEnvironment = null

    /**
     * which toggle currently speaks for the user.
     *
     * setEnabled takes a ticket on the way in and re-checks it after every
     * await. electron neither serialises menu clicks nor disables the item
     * while a handler runs, so a double-click puts two calls in flight - and
     * an older one resuming after a slow disk would otherwise apply a decision
     * the user has already replaced.
     */
    this.toggleGeneration = 0

    // preference writes are chained onto this so they land in the order the
    // clicks arrived. two racing writes otherwise leave the stored value
    // decided by whichever the disk finished first, which need not be the last
    // thing the user chose.
    this.pendingWrite = Promise.resolve()

    /**
     * read once, and used for two separate things: whether this build may send
     * at all, and what `environment` says on the events it sends. they have to
     * agree, and the second is what makes the first visible in the dashboard -
     * a gate that lets nothing through is otherwise indistinguishable from an
     * app nobody launched.
     */
    this.isProductionBuild = isPackagedBuild()

    this.allowedInThisBuild =
      typeof forceEnabled === "boolean"
        ? forceEnabled
        : this.isProductionBuild || process.env.CLIPLY_ANALYTICS_DEV === "1"
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
      this.superProperties = checkSuperProperties(
        {
          app_version: getAppVersion(),
          os: process.platform,
          os_version: kernelVersion(),
          arch: process.arch,
          locale: readLocale(),
          environment: this.isProductionBuild
            ? ENVIRONMENT_PRODUCTION
            : ENVIRONMENT_DEVELOPMENT
        },
        redactLogLine
      )

      // the engine is probed once per run, so whatever it reported has to be
      // put back after the rebuild - nothing would set it a second time
      if (this.engineVersion) {
        this.superProperties.engine_version = this.engineVersion
      }

      // same reason as the engine version above: probed once, at startup, and
      // this rebuild would otherwise drop it for the rest of the session
      if (this.potEnvironment) {
        Object.assign(this.superProperties, this.potEnvironment)
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

    const checked = checkKind(
      "version",
      version,
      "engine_version",
      redactLogLine
    )

    if (!checked.ok) {
      console.warn("analytics: ignored an engine version, expected version")
      return
    }

    this.engineVersion = checked.value
    this.superProperties.engine_version = checked.value
  }

  /**
   * record what this install could mint a PO token with, if it had to
   *
   * both are facts about the machine rather than about any one operation, so
   * they are super properties: they ride every event, and the one that matters
   * most is media_info_failed, which the renderer raises and which therefore
   * cannot know either of them first-hand.
   *
   * set again whenever the answer changes - the payload arrives by download
   * partway through a session, so `pot_provider` is not fixed at startup the
   * way the engine version is.
   *
   * validated rather than trusted, for the same reason setEngineVersion() is:
   * capture() spreads super properties last, so anything landing here outranks
   * even a validated caller value.
   *
   * @param {Object} environment - {denoPresent, potProvider}
   */
  setPotEnvironment({ denoPresent, potProvider } = {}) {
    const checked = checkSuperProperties(
      {
        deno_present: Boolean(denoPresent),
        pot_provider: Boolean(potProvider)
      },
      redactLogLine
    )

    this.potEnvironment = checked
    Object.assign(this.superProperties, checked)
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

        const checked = checkKind(kind, value, key, redactLogLine)

        if (!checked.ok) {
          // the key and the expected kind, never the value: the value is the
          // suspected pii, and this warning may end up in a log a user sends us
          console.warn(
            checked.because === "empty"
              ? `analytics: dropped ${safeLabel(key)} on ${label} - its vocabulary is empty. add the value to PROPERTY_VOCABULARIES.${safeLabel(key)} in services/analytics/schema.js before sending it.`
              : `analytics: dropped ${safeLabel(key)} on ${label}, expected ${kind}`
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
    await drainClient(this.client)
  }

  /**
   * write the preference, keeping this module's never-throws contract
   *
   * the store catches its own write failures today, but this module must not
   * rest its own guarantee on a collaborator's internals.
   *
   * chained rather than fired: overlapping toggles must reach the file in the
   * order the clicks arrived, or the stored value ends up decided by whichever
   * write the disk happened to finish first - and a file disagreeing with the
   * tick outlives the session, which is the part the user notices.
   *
   * the cost is written down as a choice rather than left to be found later. a
   * write that never settles blocks every write queued behind it, and because
   * turning analytics ON waits for its own write, a later opt-in then never
   * takes effect at all: the tick reads on and the service stays off until the
   * app restarts. that is not merely a delayed dialog - it is a real refusal to
   * start sending - and it is the direction we want, because storage this
   * broken is not a state to begin collecting in. an opt-OUT is unaffected
   * whatever the disk does, because it never waits on this.
   *
   * @param {boolean} enabled - the preference to store
   * @returns {Promise<Object|undefined>} the store's {success, error?}
   */
  async persistPreference(enabled) {
    const write = this.pendingWrite.then(() =>
      this.settingsStore.setAnalyticsEnabled(enabled)
    )

    // the chain has to survive a rejected write, or every later toggle
    // inherits the rejection and none of them ever runs
    this.pendingWrite = write.catch(() => {})

    try {
      return await write
    } catch (error) {
      return { success: false, error: describeError(error) }
    }
  }

  /**
   * stop sending, now
   *
   * synchronous by construction: everything that could take time happens after
   * the client is already gone, so there is no state in which this has been
   * asked for and not yet taken effect.
   */
  goInert() {
    const detached = this.client
    this.enabled = false
    this.client = null

    // fired, never awaited. those events were captured under consent and are
    // still worth delivering, so the detached client is retired properly -
    // bounded, and released rather than left running - but a menu click must
    // not wait on telemetry, least of all on the telemetry it just asked to
    // stop. the cost is that opting out and quitting at once may lose the last
    // batch, which is the right direction to lose it.
    //
    // the catch is load-bearing rather than decorative: this promise is
    // unobserved, so it is the place a rejection would surface as an unhandled
    // one instead of as a return value.
    retireClient(detached).catch(() => {})
  }

  /**
   * user toggled the preference. turning it off stops the client immediately.
   *
   * the two directions are deliberately NOT symmetric, because the risk is
   * not symmetric. stopping must never be delayed by anything that can hang;
   * starting must never run ahead of the write that would survive a restart.
   *
   * @param {boolean} enabled
   * @returns {Promise<Object>} the store's {success, error?} - the caller
   *   decides what to tell the user about a write that did not stick
   */
  async setEnabled(enabled) {
    const generation = ++this.toggleGeneration

    if (!enabled) {
      /**
       * inert SYNCHRONOUSLY - before this method awaits anything at all, and
       * NOT gated on the generation.
       *
       * the user said stop, and neither the network nor a settings write nor
       * another click gets to delay that. an await in front of this line is
       * the whole bug however it is spelled: draining first kept the pipe open
       * for as long as the flush took, and persisting first kept it open for
       * as long as the disk took.
       *
       * the asymmetry with the enable path below is deliberate rather than an
       * oversight. a superseded enable LOSES, because sending is the state
       * that needs a live mandate; a disable always WINS immediately, because
       * refusing to stop is never the safe way to resolve a race. so this side
       * applies its EFFECT with no ticket check at all, while the other side
       * re-checks after every await.
       *
       * its RESULT is still tagged, because by the time the write comes back a
       * newer click may own the checkbox - see tagIfSuperseded.
       *
       * the preference may then fail to stick, and that is the caller's to
       * report - honouring the intent for this session matters more than the
       * write landing, and the menu says so rather than claiming it stuck.
       */
      this.goInert()

      return this.tagIfSuperseded(await this.persistPreference(false), generation)
    }

    const persisted = await this.persistPreference(true)

    /**
     * superseded: a later click decided while this one was on the disk, and
     * that click is the one speaking for the user now. the result still goes
     * back to its own caller - the write did happen - but nothing here may
     * touch runtime state again.
     */
    if (generation !== this.toggleGeneration) {
      return this.tagIfSuperseded(persisted, generation)
    }

    /**
     * turning it ON waits for the write, and gives up if it did not land.
     *
     * the menu shows the tick the service's own state warrants, so a service
     * that enabled itself anyway would be sending behind a switch the user can
     * see is off. init()'s re-read of the preference usually covers for that
     * by accident - it reads back the value the failed write did not change -
     * but not when the settings file is unwritable AND unreadable, where the
     * read fails open to enabled and agrees with the caller. the state is not
     * safe to leave resting on that coincidence.
     */
    if (persisted && persisted.success === false) return persisted

    this.enabled = true
    if (!this.client) await this.init()

    // init() sets enabled and client from the store, so a disable that landed
    // while it ran has just been undone by init()'s own success. put it back,
    // and let go of the client it built rather than leaving one running behind
    // an off switch.
    if (generation !== this.toggleGeneration) {
      this.goInert()
      return this.tagIfSuperseded(persisted, generation)
    }

    return persisted
  }

  /**
   * mark a result whose click has already been replaced
   *
   * the caller is a menu handler that closed over the live MenuItem, so an
   * older call resuming late does not act on its own historical checkbox - it
   * acts on the one the NEWEST click left behind. a stale failure reported
   * there flips somebody else's tick and raises a dialog about a click nobody
   * is making any more.
   *
   * the write did happen, so the result still goes back to its own caller.
   * tagged, so that caller can tell it is answering a question that has been
   * withdrawn.
   *
   * @param {Object|undefined} persisted - the store's {success, error?}
   * @param {number} generation - the ticket this call took on the way in
   * @returns {Object|undefined} the result, marked if it is no longer current
   */
  tagIfSuperseded(persisted, generation) {
    if (generation === this.toggleGeneration) return persisted

    return { ...persisted, superseded: true }
  }
}

// the client factory stays private: this module being the only way out is the
// whole basis of the privacy argument. the schema is exported because it emits
// nothing and later tasks need to assert against it.
module.exports = { Analytics, ALLOWED_PROPERTIES, PROPERTY_KINDS }
