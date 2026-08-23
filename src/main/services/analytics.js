// the only place telemetry leaves the app. the renderer routes through ipc to
// here, so the opt-out gate, the allowlist and the redaction below cannot be
// bypassed.

const os = require("os")
const { APP_CONFIG, SUPPORTED_PLATFORMS } = require("../utils/constants")
const { redactLogLine } = require("./ytdlp-engine")
const { describeError, getAppVersion } = require("../utils/analytics-helpers")
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
 * see the note above the patterns below for why the string kinds are
 * vocabularies and numeric grammars rather than one general-purpose charset.
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

  // finite vocabularies, listed in PROPERTY_VOCABULARIES
  url_kind: "vocabulary",
  media_type: "vocabulary",
  audio_format: "vocabulary",
  reason: "vocabulary",
  update_reason: "vocabulary",
  error_category: "vocabulary",
  error_stage: "vocabulary",

  // part grammar, part vocabulary - see checkKind
  quality: "quality",

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

  // free text, scrubbed and clipped
  error_message: "text",

  /**
   * the super properties.
   *
   * these are never named in ALLOWED_PROPERTIES, because no caller may send
   * one - init() builds them and capture() spreads them last, over the
   * validated bag. they are kinded all the same: that placement is exactly
   * what makes them worth checking, since one of them rides every event this
   * app will ever send, and a leak there is the most amplified one available.
   */
  app_version: "version",
  os: "vocabulary",
  os_version: "version",
  arch: "vocabulary",
  locale: "locale"
}

const KIND_BY_PROPERTY = new Map(Object.entries(PROPERTY_KINDS))

/**
 * there is no general-purpose grammar for a short label, and six rounds of
 * counterexamples were the proof. a charset wide enough for "1-5 min" admits
 * "My Holiday Video"; narrow it to a lowercase identifier and it still admits
 * "holiday". a single word is indistinguishable from a title by inspection,
 * because it may *be* one.
 *
 * so every string property is now one of three things, and none of them is a
 * general grammar:
 *
 *   - a vocabulary, when the values are ours and finite
 *   - a numerically anchored grammar, when the values genuinely grow but only
 *     along a numeric axis (heights, bitrates, versions, buckets)
 *   - redacted text, when the value is free prose and treated as such
 *
 * the enumeration cost is real, and it is the same cost ALLOWED_PROPERTIES
 * already pays on property names: a later task that sends something new has
 * to come here and say so. that friction is the feature.
 */

// heights and bitrates grow with the format list, so they are matched rather
// than listed - but both are anchored on digits, which "holiday" cannot fake
const QUALITY_HEIGHT_PATTERN = /^\d{2,4}p$/
const QUALITY_BITRATE_PATTERN = /^\d{1,4}kbps$/

// everything else extractQuality() can return (analytics-helpers.js). these
// are fixed outputs of its own branches, not values a format list supplies,
// so they are listed rather than matched
const QUALITY_VALUES = new Set([
  "audio",
  "best_audio",
  "best_available",
  "high_quality",
  "low_quality",
  "m4a",
  "medium_quality",
  "mp3",
  "original_audio",
  "unknown"
])

// digits and dots, with an optional prerelease tail. leading with a digit was
// not enough on its own: "2024.mp4" leads with one too.
//
// letters are confined to the prerelease's *first* segment; every later
// dot-segment is numeric. an earlier version of this allowed dots inside the
// tail, which let "1-holiday.mp4" through - "1" satisfied the head and the
// extension rode along behind the dash.
const VERSION_PATTERN =
  /^[0-9][0-9.]{0,30}(?:-[A-Za-z0-9]{1,16}(?:\.[0-9]+)*)?$/

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
 * a bcp-47 language tag, anchored on case and length.
 *
 * this one is neither a vocabulary nor numerically anchored, and the reason is
 * that the values are chromium's rather than ours: app.getLocale() returns
 * whichever ui locale it resolved, and that set grows with electron upgrades.
 * a listed set would silently stop reporting the locale of everybody who ran
 * the version that added one - a drop nobody triggered and nobody would see,
 * which is a different thing from the deliberate friction the other lists buy.
 *
 * so it is anchored on shape, but on a shape prose does not have: two or three
 * lowercase letters, then at most a titlecase four-letter script and a
 * two-letter uppercase or three-digit region. "my-video" fails on the second
 * segment's case and "holiday" on the first one's length, which is the pair
 * that defeated every general-purpose slug grammar tried before this.
 */
const LOCALE_PATTERN =
  /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/

// what readLocale() reports when electron is not there to ask
const LOCALE_UNKNOWN = "unknown"

/**
 * the finite vocabularies, one per property.
 *
 * the two error vocabularies are read from the taxonomy module rather than
 * copied, so a category added there is accepted here for free. the rest are
 * listed because their sources are scattered literals rather than an exported
 * table - each is noted with where it comes from, so it can be re-derived.
 *
 * an empty set is a deliberate state, not an oversight: it means the values
 * do not exist yet, and the first task to send one has to come here first.
 */
const PROPERTY_VOCABULARIES = {
  error_category: new Set(Object.values(ERROR_CATEGORIES)),
  error_stage: new Set(Object.values(ERROR_STAGES)),

  // node's whole documented range for process.platform and process.arch. both
  // are genuinely finite and genuinely not ours to invent, and node adds to
  // them about once a decade - which is the case a list is for. the app runs
  // on three of these; the rest are here because this set claims to be the
  // whole list, and a drop on an unusual platform would take that install's
  // os off every event it ever sends
  os: new Set([
    "aix",
    "android",
    "cygwin",
    "darwin",
    "freebsd",
    "haiku",
    "linux",
    "netbsd",
    "openbsd",
    "sunos",
    "win32"
  ]),
  arch: new Set([
    "arm",
    "arm64",
    "ia32",
    "loong64",
    "mips",
    "mipsel",
    "ppc",
    "ppc64",
    "riscv64",
    "s390",
    "s390x",
    "x64"
  ]),

  // the runner emits "combined" for a video download - an ffmpeg detail
  // meaning two streams were merged - and task 6 normalizes that to "video"
  // before sending. the raw term is deliberately absent rather than missing:
  // this taxonomy answers whether people take video or audio, and should not
  // carry a word that describes how the engine assembled the file
  media_type: new Set(["video", "audio"]),

  // the keys of AUDIO_MODE_PRESETS - normalizeAudioMode returns the key, not
  // the codec it maps to (ytdlp-engine.js:536, :617)
  audio_format: new Set(["mp3", "m4a", "original"]),

  // every reason ytdlp-updater can report: its `reason:` literals, the three
  // passed positionally to installDirectory(), and "download-failed", which is
  // written as a ternary arm (ytdlp-updater.js:567) and so is invisible to a
  // grep for the keyword. engine_seeded only ever sends the three positional
  // ones - the rest are here because this set claims to be the whole list
  reason: new Set([
    "asset-layout-unexpected",
    "bundled-newer",
    "busy",
    "cancelled",
    "check-failed",
    "checksum-mismatch",
    "checksum-missing",
    "completed",
    "copy-failed",
    "corrupt",
    "corrupt-and-no-bundle",
    "download-failed",
    "engine-dir-failed",
    "missing",
    "no-binary-available",
    "probe-failed",
    "repaired",
    "swap-failed",
    "swap-stranded",
    "unsupported-platform",
    "up-to-date",
    "version-mismatch"
  ]),

  // why an engine update did not happen: every reason checkForUpdate() can
  // return except the two that mean nothing went wrong, "up-to-date" and
  // "completed", which index.js sends no event for at all. read off its return
  // sites rather than seed()'s - the seeding-only reasons (missing, corrupt,
  // bundled-newer, copy-failed, engine-dir-failed, corrupt-and-no-bundle)
  // cannot reach this property, because runUpdateLocked ignores what
  // seedLocked said and returns its own.
  //
  // "busy" is one of these on purpose: the check refused because a download
  // held the engine gate, so it never ran - and an install whose engine
  // therefore never updates is exactly what this event exists to find
  update_reason: new Set([
    "asset-layout-unexpected",
    "busy",
    "cancelled",
    "check-failed",
    "checksum-mismatch",
    "checksum-missing",
    "download-failed",
    "no-binary-available",
    "probe-failed",
    "repaired",
    "swap-failed",
    "swap-stranded",
    "unsupported-platform",
    "version-mismatch",

    // the one value the updater does not produce. checkForUpdate() can reject
    // rather than return - runUpdateLocked leaves probeVersion and the
    // recovery renames unguarded - and index.js names that itself. kept apart
    // from "check-failed", which is the tag lookup failing and returning
    // normally: merging them would hide a bug in our own code inside the
    // commonest network blip there is
    "check-rejected"
  ]),

  // the shape of a submitted link, named by urlKind() in the renderer's
  // lib/analytics.ts - these are ours to invent, and this is the whole list.
  //
  // "playlist" is the one that pays for the rest: we take the single video out
  // of a playlist url, and how often somebody expected otherwise is a question
  // nothing else here answers. "short-link" is the redirect hosts (youtu.be,
  // pin.it, vm/vt.tiktok.com, tiktok.com/t), which cost a resolution step
  // before anything else can happen
  url_kind: new Set(["video", "shorts", "playlist", "short-link", "embed"])
}

const VOCABULARY_BY_PROPERTY = new Map(Object.entries(PROPERTY_VOCABULARIES))

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
 * error_message is the one property whose values cannot be enumerated.
 *
 * every other string kind is answered by a vocabulary or a numeric anchor,
 * because - as six rounds of counterexamples established - a pattern cannot
 * establish what a string *is*, only what it still looks like. this property
 * has neither defence available to it: it is free text by design, and the
 * useful half of it is precisely the wording nobody wrote for us. an error
 * that did not come from the engine carries whatever node, yt-dlp or a throw
 * site put in it, and the updater's own http failures name their urls.
 *
 * redactLogLine is not the answer either. it serves the local log file, where
 * an absolute path is legitimately useful to whoever is debugging their own
 * machine; it scrubs the home directory and a query string and nothing else.
 * merging the two thresholds would degrade the logs to protect telemetry.
 *
 * so this works the other way round from a grammar. scrub the shapes we can
 * name, then ask whether anything location-shaped or identity-shaped is still
 * standing, and if so send a fixed placeholder rather than the text. an
 * incomplete pattern list then costs a message instead of a leak, which is the
 * direction this property has to fail in.
 */
const TEXT_PLACEHOLDER = "[redacted]"

/**
 * how far a path runs once it has started.
 *
 * paths hold spaces - "My Holiday Video.mp4" is one token to a person and
 * three to a regex - and stopping at the first space is what leaves the words
 * of a title standing after the filename at the end of them has gone. so a
 * space is consumed only while something further along the line still carries
 * a separator or a dot, which keeps the path whole without swallowing the
 * sentence that follows it.
 */
const PATH_TAIL = String.raw`(?:[^\s'"<>|,;)]|[ \t](?=[^\n\r]*[\\/.]))*`

const PATH_HEADS = [
  // a windows unc share
  String.raw`\\\\`,
  // a drive letter. the word boundary keeps "Note:" and a clock time out
  String.raw`\b[A-Za-z]:[\\/]`,
  // what redactLogLine leaves behind where a home directory was
  String.raw`~[\\/]`,
  // two separators, so "MiB/s" and "and/or" stay prose rather than becoming
  // locations. a *relative* path is deliberately unreachable here - it is
  // indistinguishable from prose, and the refusal below is what answers it
  String.raw`/[^\s'"<>|,;)]*/`
]

/**
 * the identifier a credential's name is a part of, wherever in it that is.
 *
 * this rule has now been wrong twice for the same reason, and the reason is
 * worth stating rather than patching around a third time. it anchored on `\b`,
 * which missed `client_secret` because "_" is a word character. it then
 * anchored on a prefix, which missed `aws_secret_access_key` - a standard aws
 * field - because the marker turned out to sit in the middle. both fixes moved
 * the position the marker was assumed to occupy; neither questioned that it
 * occupied a fixed one.
 *
 * it does not. `client_secret`, `aws_secret_access_key`, `cookie_store`,
 * `x-api-key`, `signing_secret`: the marker is a *component* of a compound
 * name, and a component can be anywhere. so the rule is now the whole of that
 * claim - a marker appearing anywhere in a key that is being assigned a value -
 * and there is no position left for a later counterexample to exploit.
 *
 * the same shape as task 6's ipv6 rule, which required every group to be
 * non-empty and so missed `::` - which is how one is actually written. that
 * fix, like this one, was to stop describing where the thing sits and start
 * matching what it is.
 *
 * the punctuation in the class is the second half of the same lesson, learned
 * the same way. a flat identifier is one spelling of a key and not the only
 * one: `credentials[secret]`, `creds[0][secret]`, `config%5Bapi_key%5D`,
 * `"api_key"`, `'secret'` and `auth.client_secret` are all one key with a
 * marker in it, written by a form serializer, a query encoder or a json dump.
 * enumerating those serializations would be the position mistake again in a
 * different costume, so the class says what a key character is and lets any
 * arrangement of them count.
 *
 * the lookbehind rather than `\b` is what makes the match start at the real
 * beginning of the key. with `\b` a quoted key began at the letter and left
 * its opening quote stranded, which then had nothing to pair with.
 *
 * `[=:]` on the key is what still keeps ordinary prose out, and that half has
 * held through every version of this rule.
 */
const CREDENTIAL_KEY_CHAR = String.raw`[A-Za-z0-9_\-.%\[\]"']`
const CREDENTIAL_KEY_PART = CREDENTIAL_KEY_CHAR + "*"
const CREDENTIAL_KEY_START = String.raw`(?<!${CREDENTIAL_KEY_CHAR})`

/**
 * and the value, which may be quoted or bare. a json dump writes
 * `"secret": "hunter2"`, and stopping at the opening quote would publish
 * everything after it.
 */
const CREDENTIAL_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s'"&]+)`

const CREDENTIAL_NAMES = [
  "api[_-]?key",
  "access[_-]?token",
  "refresh[_-]?token",
  "auth[_-]?token",
  "id[_-]?token",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "session[_-]?id",
  "cookie"
].join("|")

const TEXT_SCRUBS = [
  // a scheme url first, so its own path is consumed here rather than by the
  // path patterns below. brackets end it so a parenthesised url reads
  // cleanly; angle brackets do not, because redactLogLine leaves a
  // "?<redacted>" tail behind that belongs to the url it came from
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"()[\]]+/gi, "[url]"],
  [/\bwww\.[^\s'"()[\]]+/gi, "[url]"],

  /**
   * a credential.
   *
   * an opaque token is prose to every rule below this one - no separator, no
   * dot, no host - which is the same position a bare title is in, and the
   * floor this module accepts for titles. it is admitted here anyway, because
   * the two are not the same thing twice: a token has a findable edge that a
   * title does not. no wording of ours, of node's or of yt-dlp's says "Bearer"
   * or "api_key=", so keying on the marker costs nothing, while a leaked
   * credential is a different category of harm from a leaked video title.
   *
   * an Authorization value is a secret in its entirety, so that one runs to
   * the end of the line rather than to the end of a token - a scheme and its
   * payload are two tokens, and stopping between them would publish the half
   * that matters. "bearer" and "negotiate" are also matched without their
   * header name; "basic" and "digest" deliberately are not, because unlike
   * those two they are ordinary english and would eat the word after them.
   *
   * see CREDENTIAL_KEY_PART above for why the name is matched as a component
   * of the key rather than at any particular end of it.
   */
  [
    new RegExp(
      CREDENTIAL_KEY_START +
        String.raw`${CREDENTIAL_KEY_PART}authorization${CREDENTIAL_KEY_PART}\s*[=:].*`,
      "gi"
    ),
    "[credential]"
  ],
  [/\b(?:bearer|negotiate)\s+[^\s'"]+/gi, "[credential]"],
  [
    new RegExp(
      CREDENTIAL_KEY_START +
        String.raw`${CREDENTIAL_KEY_PART}(?:${CREDENTIAL_NAMES})${CREDENTIAL_KEY_PART}\s*[=:]\s*${CREDENTIAL_VALUE}`,
      "gi"
    ),
    "[credential]"
  ],

  [/[^\s'"<>@]+@[^\s'"<>@]+\.[^\s'"<>@]+/g, "[email]"],

  // an address. the updater says "could not connect to <address> for <url>",
  // and while the address it means is github's, the check below cannot tell
  // one of those from the machine's own: an ipv4 carries no letters, so the
  // filename rule reads it as harmless and lets it through. four groups of
  // digits is more than a version string has, so "2026.08.19" is untouched
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[address]"],

  // ipv6, matched as "hex and colons around a ::" rather than by validating
  // the grammar. validating it is what went wrong the first time: requiring
  // every group after a colon to be non-empty excluded ::1, 2001:db8::1 and
  // fe80::a - which is to say every compressed form, which is to say every
  // ipv6 anyone writes. a generous match here can only ever replace more.
  // the brackets are the url spelling and %zone is a link-local's interface,
  // which names the machine's own hardware
  [/\[?[0-9a-f:]*::[0-9a-f:]*(?:%[A-Za-z0-9._-]+)?\]?/gi, "[address]"],
  // and the uncompressed eight-group form, which has no :: to find
  [/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, "[address]"],

  ...PATH_HEADS.map((head) => [new RegExp(head + PATH_TAIL, "g"), "[path]"]),

  // whatever is left carrying an extension. \p{L} rather than [A-Za-z]: a
  // title in another script is still a title
  [/\S*\p{L}\S*\.[\p{L}\p{N}]{1,6}(?=$|[\s.,;:!?)\]'"])/gu, "[file]"]
]

// a span that holds nothing but markers has already been cleaned, and keeping
// it is what leaves node's "open '[path]'" readable instead of "open [text]"
const MARKERS_ONLY =
  /^(?:\s|\[(?:url|path|file|email|address|credential|text)\])*$/

/**
 * what may not survive the scrub above.
 *
 * deliberately broader than it: this half decides whether the text may be sent
 * at all, so it asks whether the string still looks like a location or an
 * identity rather than whether we know how to clean it.
 */
const TEXT_UNSAFE = [
  // any separator still standing is one the scrubs could not account for -
  // a relative path, a windows path in a shape we did not parse
  /[/\\]/,
  /@/,
  // a dotted token carrying a letter: a filename whose extension the scrub
  // did not recognise. a version string is digits either side and survives
  /\S*\p{L}\S*\.[\p{L}\p{N}]/u,

  // two colons with nothing but hex between them: an address in a spelling
  // the scrub above did not name. this is the general answer to the shape,
  // rather than a longer list of address grammars - a mac address is not an
  // ip and no rule above would have caught one.
  //
  // it costs the messages that carry a second colon of their own: a
  // "10:30:45" clock, an ffmpeg "00:01:23" duration, an iso timestamp. one
  // colon is untouched, so "ERROR:", "reason: value", "code 137: Killed",
  // "10:30" and a windows drive letter all still send
  /[0-9a-f]*:[0-9a-f]*:/i,
  // something hanging off a home marker. a bare "~" is a whole home directory
  // and says nothing; "~something" is a path we did not parse
  /~\S/
]

/**
 * replace the quoted spans a message uses to name the thing it is about
 *
 * a title, an argument, a filename: whatever is still inside a span after the
 * scrubs above ran is text nobody vouched for, so the span goes as a whole.
 *
 * @param {string} text - already scrubbed of the shapes we can name
 * @returns {string} the same text with unvouched-for spans replaced
 */
function scrubQuotedSpans(text) {
  return (
    text
      .replace(/"([^"]*)"/g, (span, inner) =>
        MARKERS_ONLY.test(inner) ? span : "[text]"
      )
      // a single quote is an apostrophe far more often than a quote mark, so
      // this one only counts as a span when it is delimited on both sides -
      // otherwise "you're not a bot" and "don't" would pair up across a
      // perfectly safe sentence
      .replace(/(^|[\s(])'([^']*)'(?=$|[\s).,;:!?])/g, (span, lead, inner) =>
        MARKERS_ONLY.test(inner) ? span : `${lead}[text]`
      )
  )
}

/**
 * make a free-text message safe to send, or refuse to send it
 * @param {string} value - the caller's text, already through redactLogLine
 * @returns {{text: string, refused: boolean}}
 */
function scrubText(value) {
  let text = value

  for (const [pattern, replacement] of TEXT_SCRUBS) {
    text = text.replace(pattern, replacement)
  }

  text = scrubQuotedSpans(text)

  return TEXT_UNSAFE.some((pattern) => pattern.test(text))
    ? { text: TEXT_PLACEHOLDER, refused: true }
    : { text, refused: false }
}

/**
 * check a value against its kind, returning the value to send.
 *
 * never coerces and never stringifies: the input may be a hostile object from
 * the renderer, and asking it for a string is asking it to run code.
 * @param {string} kind
 * @param {*} value
 * @param {string} key - the property name, for the per-property vocabularies
 * @returns {{ok: boolean, value?: *, normalized?: boolean, because?: string}}
 */
function checkKind(kind, value, key) {
  switch (kind) {
    case "bool":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false }

    case "number":
      // isFinite does not coerce, so "5" and NaN both fail here
      return Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER
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

      const scrubbed = scrubText(redactLogLine(value))

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

// describeError moved to utils/analytics-helpers.js: the ipc layer and the
// download runner make the same never-throw promise this module does, and were
// each guarding it with a weaker spelling of the same thing

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
 * @returns {Object} the ones that passed
 */
function checkSuperProperties(candidates) {
  const safe = {}

  for (const [key, value] of Object.entries(candidates)) {
    const kind = KIND_BY_PROPERTY.get(key)
    const checked = checkKind(kind, value, key)

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
      this.superProperties = checkSuperProperties({
        app_version: getAppVersion(),
        os: process.platform,
        os_version: kernelVersion(),
        arch: process.arch,
        locale: readLocale()
      })

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

    const checked = checkKind("version", version, "engine_version")

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

        const checked = checkKind(kind, value, key)

        if (!checked.ok) {
          // the key and the expected kind, never the value: the value is the
          // suspected pii, and this warning may end up in a log a user sends us
          console.warn(
            checked.because === "empty"
              ? `analytics: dropped ${safeLabel(key)} on ${label} - its vocabulary is empty. add the value to PROPERTY_VOCABULARIES.${safeLabel(key)} in services/analytics.js before sending it.`
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
