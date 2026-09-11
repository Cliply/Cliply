// the sanitizer for the one property whose values cannot be enumerated, and it
// fails closed.
//
// it works the other way round from the grammars in schema.js: scrub the shapes
// we can name, then ask whether anything location-shaped or identity-shaped is
// still standing, and send a fixed placeholder rather than the text if so. the
// patterns below are the whole of that, and each one is here because something
// got through without it.

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

// scrubText is the whole surface. everything above is its working, and keeping
// it private is what stops a later caller assembling a weaker version of the
// same check out of the parts
module.exports = { scrubText }
