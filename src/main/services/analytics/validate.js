// is this value of its declared kind.
//
// the one gate every property passes through, a caller's and a super property
// alike. it never coerces and never stringifies, because the bag it checks
// arrives from the renderer over ipc: asking a hostile object for a string is
// asking it to run code.

// the ceiling on any one playlist link, which is what bounds every item count
// below. imported rather than written out: a cap that moves has to move the
// validation with it, or every count above the old one is dropped in silence
const { PLAYLIST_MAX_ITEMS } = require("../../utils/ytdlp-mappers")
const {
  BUCKET_PATTERN,
  KNOWN_PLATFORMS,
  LOCALE_PATTERN,
  LOCALE_UNKNOWN,
  PLATFORM_UNSUPPORTED,
  QUALITY_BITRATE_PATTERN,
  QUALITY_HEIGHT_PATTERN,
  QUALITY_VALUES,
  VERSION_PATTERN,
  VOCABULARY_BY_PROPERTY
} = require("./schema")
const { scrubText } = require("./redact")

const MAX_TEXT_LENGTH = 500
const MAX_NUMBER = 1e9

/**
 * check a value against its kind, returning the value to send.
 *
 * never coerces and never stringifies: the input may be a hostile object from
 * the renderer, and asking it for a string is asking it to run code.
 * @param {string} kind
 * @param {*} value
 * @param {string} key - the property name, for the per-property vocabularies
 * @param {Function} redact - redactLogLine, handed in by analytics.js rather
 *   than required here. the tests that drive this module mock the engine
 *   barrel and re-export the real redaction through it, and a second require
 *   site is a second thing that has to keep resolving to the mocked one - so
 *   there is exactly one, and it is in the module those tests already load.
 * @returns {{ok: boolean, value?: *, normalized?: boolean, because?: string}}
 */
function checkKind(kind, value, key, redact) {
  switch (kind) {
    case "bool":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false }

    case "number":
      // isFinite does not coerce, so "5" and NaN both fail here
      return Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER
        ? { ok: true, value }
        : { ok: false }

    /**
     * a whole number of playlist items, 0 to the cap.
     *
     * isInteger rather than isFinite, because half a video was not saved: a
     * fraction here is a caller that computed something rather than counted it,
     * and the same is true of a count above the cap - a run covers at most
     * PLAYLIST_MAX_ITEMS videos, so anything larger did not come from one.
     */
    case "count":
      return Number.isInteger(value) &&
        value >= 0 &&
        value <= PLAYLIST_MAX_ITEMS
        ? { ok: true, value }
        : { ok: false }

    // a finite set of values we own. an empty one is reported differently,
    // because "nobody has declared these yet" needs a different fix from
    // "that is not one of them"
    case "vocabulary": {
      const vocabulary = VOCABULARY_BY_PROPERTY.get(key)

      if (!vocabulary) return { ok: false }
      if (vocabulary.size === 0) return { ok: false, because: "empty" }
      if (typeof value !== "string") return { ok: false }

      return vocabulary.has(value) ? { ok: true, value } : { ok: false }
    }

    // heights and bitrates are matched because they grow; everything else
    // extractQuality can return is listed because it does not
    case "quality":
      if (typeof value !== "string") return { ok: false }

      return QUALITY_HEIGHT_PATTERN.test(value) ||
        QUALITY_BITRATE_PATTERN.test(value) ||
        QUALITY_VALUES.has(value)
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

    case "locale":
      if (typeof value !== "string") return { ok: false }

      return value === LOCALE_UNKNOWN || LOCALE_PATTERN.test(value)
        ? { ok: true, value }
        : { ok: false }


    // scrubbed, then re-checked, and only then truncated: cutting first would
    // leave the front half of a path behind, which no pattern then matches
    case "text": {
      if (typeof value !== "string") return { ok: false }

      const scrubbed = scrubText(redact(value))

      return {
        ok: true,
        value: scrubbed.text.slice(0, MAX_TEXT_LENGTH),
        // a refusal is reported the way a normalization is, naming only the
        // placeholder - which is a reserved constant - and never the text we
        // could not vouch for
        normalized: scrubbed.refused
      }
    }

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

module.exports = { checkKind, safeLabel }
