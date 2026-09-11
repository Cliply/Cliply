// the facts about this install, and the life cycle of the client that carries
// them.
//
// which locale, which kernel, whether this is a build somebody installed: the
// things that describe the machine rather than any one operation, and so ride
// every event as super properties. the electron lookups here are required
// lazily on purpose - see readLocale below.

const os = require("os")
const { describeError } = require("../../utils/analytics-helpers")
const { KIND_BY_PROPERTY, LOCALE_UNKNOWN } = require("./schema")
const { checkKind } = require("./validate")

// how long the background drain an opt-out starts is given before it gives up.
// nobody waits on it, so this is not about responsiveness - it is what stops a
// detached client sitting on a dead socket indefinitely. the same two seconds
// the quit path allows (QUIT_FLUSH_TIMEOUT_MS in index.js), because the amount
// of unsent telemetry worth holding a resource for is the same either way.
const OPT_OUT_FLUSH_TIMEOUT_MS = 2000

// electron is not present under jest, so the locale lookup must degrade
// instead of exploding at require time
function readLocale() {
  try {
    const { app } = require("electron")
    return typeof app?.getLocale === "function"
      ? app.getLocale()
      : LOCALE_UNKNOWN
  } catch {
    return LOCALE_UNKNOWN
  }
}

/**
 * whether this is a build somebody installed, rather than one run from source.
 *
 * this is the production indicator, and it used to be NODE_ENV === "production"
 * - which nothing in this repo ever sets. the dev scripts set "development",
 * electron-builder puts no NODE_ENV into a packaged app's environment at all,
 * and there is no .env, so every build a user actually installed evaluated that
 * gate to false and sent nothing. app.isPackaged is electron's own answer to
 * the same question and is true in exactly the builds this is about.
 *
 * NODE_ENV is deliberately not kept alongside it. it is not merely redundant:
 * it is set by tooling for reasons of its own, so keeping it as an alternative
 * signal means a machine that happens to carry NODE_ENV=production - a build
 * step, a CI shell, an exported variable - starts reporting into the production
 * project from source. that is the same class of mistake inverted, and one
 * signal that answers the question beats two where the spare one can only be
 * wrong.
 *
 * required lazily, the way readLocale() does and for the same reason: electron
 * is not present under jest, and a require at module top would take every test
 * in this file down with it.
 *
 * it fails CLOSED - unreadable means not packaged, which means no telemetry.
 * that cannot cost a real packaged build anything, because in one the electron
 * module is part of the runtime and this lookup cannot fail; the only place it
 * can fail is outside electron, where sending would be wrong anyway. failing
 * open would invert exactly that: a script, a test or a tool that constructed
 * this class would be treated as a shipped install.
 */
function isPackagedBuild() {
  try {
    const { app } = require("electron")
    return app?.isPackaged === true
  } catch {
    return false
  }
}

/**
 * the kernel release, cut back to the part of it that is a version.
 *
 * os.release() is already one on darwin ("25.5.0") and on windows
 * ("10.0.22631"), but on linux it carries the distribution's packaging behind
 * a dash - "5.15.0-91-generic", "6.6.9-200.fc39.x86_64". no grammar admits
 * that tail without also admitting "1-holiday.mp4", which is the
 * counterexample VERSION_PATTERN was narrowed against in the first place; and
 * validating os.release() as-is would simply drop os_version on every linux
 * install, silently, for the life of the property.
 *
 * so it is cut rather than matched. the kernel version is the answer to "which
 * os version"; the suffix is packaging that differs per distribution and makes
 * the two harder to compare rather than easier.
 *
 * @returns {string|null} the leading numeric release, or null if there is none
 */
function kernelVersion() {
  const match = /^\d+(?:\.\d+)*/.exec(os.release())
  return match ? match[0] : null
}

/**
 * check the module's own super properties the way a caller's bag is checked.
 *
 * they were never checked before, and their placement is exactly the argument
 * for checking them: capture() spreads them last, over the validated bag, onto
 * every event the app sends. a leak in one is the most amplified leak
 * available here, and nothing in ALLOWED_PROPERTIES governs them - that list
 * says what a caller may send, and no caller sends these.
 *
 * a value that fails its kind is dropped, exactly as a caller's would be. that
 * costs one dimension on the events that follow and nothing else: distinctId
 * is a separate field on the message rather than a super property, so the
 * events stay attributable, and every other property is unaffected.
 *
 * @param {Object} candidates - the property bag init() assembled
 * @param {Function} redact - redactLogLine, forwarded to checkKind. no super
 *   property is of the one kind that uses it, but a version of this that left
 *   the argument off would work by that coincidence and stop the day somebody
 *   adds a text-kinded one
 * @returns {Object} the ones that passed
 */
function checkSuperProperties(candidates, redact) {
  const safe = {}

  for (const [key, value] of Object.entries(candidates)) {
    const kind = KIND_BY_PROPERTY.get(key)
    const checked = checkKind(kind, value, key, redact)

    if (!checked.ok) {
      // the key and the kind, never the value - the same rule capture() keeps,
      // for the same reason: the value is the thing we could not vouch for
      console.warn(
        `analytics: dropped the ${key} super property, expected ${kind}`
      )
      continue
    }

    safe[key] = checked.value
  }

  return safe
}

/**
 * best-effort drain of one client
 *
 * takes the client rather than reading `this.client`, because the opt-out path
 * detaches it before draining: the flush has to run against a client the
 * instance no longer holds, and a version reading the field would find null
 * there and quietly do nothing.
 *
 * @param {Object|null} client - a posthog client, or nothing
 */
async function drainClient(client) {
  if (!client) return

  try {
    await client.flush()
  } catch (error) {
    console.warn("analytics flush failed:", describeError(error))
  }
}

/**
 * retire a client the instance has already let go of
 *
 * shutdown() rather than flush(), for three reasons - none of which is that
 * flush() leaks a timer. it does not: flush() reaches _flush(), which calls
 * clearFlushTimer() first thing (@posthog/core, posthog-core-stateless.js).
 * what shutdown() adds over it is (1) it drains in a LOOP until the queues are
 * empty rather than making one pass, (2) it waits on the in-flight sends
 * before it starts, and (3) it bounds the whole thing with the timeout it is
 * handed - which is the only cap left that means anything, now that nobody
 * waits on the result, and it is a cap we get without arming a timer of our
 * own. its documented caveat, do not reuse an instance after shutting it down,
 * is exactly this contract: the client is detached, and an opt-in builds a
 * fresh one through init().
 *
 * the flush() fallback is for a client injected by a test that has no
 * shutdown, so the drain still happens rather than being reported as broken.
 *
 * @param {Object|null} client - the client the instance no longer holds
 */
async function retireClient(client) {
  if (!client) return

  if (typeof client.shutdown !== "function") {
    await drainClient(client)
    return
  }

  try {
    await client.shutdown(OPT_OUT_FLUSH_TIMEOUT_MS)
  } catch (error) {
    console.warn("analytics drain failed:", describeError(error))
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
    // the same trap one option over, and the same reason. the node sdk assumes
    // a server, so `isServer ?? true` (posthog-node, client.js) attaches
    // `$is_server: true` to every event unless this says otherwise. in electron
    // the machine IS the client, so the default is not merely undisclosed - it
    // is wrong, and it would label every event in the project as server-side.
    //
    // note this omits the property rather than sending `false`:
    // getCommonEventProperties() only sets it when the option is truthy
    isServer: false,
    flushAt: 20,
    flushInterval: 10000
  })
}

module.exports = {
  readLocale,
  isPackagedBuild,
  kernelVersion,
  checkSuperProperties,
  drainClient,
  retireClient,
  defaultCreateClient
}
