// netscape cookie jar parsing
//
// this lives here because two places need the same answer and used to disagree:
// the cookie manager decides whether the user has a usable youtube login, and
// the engine decides whether a jar is worth passing to --cookies. When only one
// of them understood "#HttpOnly_" lines, the ui reported cookies as loaded while
// downloads quietly ran without them.

const fs = require("fs")

// netscape marks http-only cookies with a comment-like prefix - those lines are
// real cookies, not comments, and dropping them loses the youtube auth cookies
const HTTP_ONLY_PREFIX = "#HttpOnly_"

/**
 * a netscape row is seven tab separated columns - not six, not eight
 *
 * yt-dlp's loader does `line.split('\t')` and refuses any length but this one.
 * we used to fall back to splitting on runs of whitespace when no tab was
 * found, which read a space separated export as a jar full of cookies while
 * yt-dlp skipped every line of it.
 */
const ENTRY_LEN = 7

/**
 * the magic first line, exactly as http.cookiejar spells it
 *
 * `#( Netscape)? HTTP Cookie File`, anchored - both spellings are valid, the
 * space after the hash is part of it, and it is matched rather than fullmatched
 * so an exporter may add its own trailing note.
 */
const NETSCAPE_MAGIC_RE = /^#( Netscape)? HTTP Cookie File/

/**
 * expiry is column 5: a unix timestamp, or 0 for a session cookie
 *
 * yt-dlp guards this column with /[0-9]+(?:\.[0-9]+)?/ and then hands it to
 * MozillaCookieJar, which does int(float(...)) - so a decimal timestamp is a
 * real expiry it truncates, not a malformed row. An empty column is how a
 * session cookie is written, and those matter: a login where "remember me" was
 * never ticked lives entirely in session cookies.
 *
 * anything else is a malformed row rather than a cookie that never expires -
 * treating "abc" or a negative timestamp as a live session cookie is how an
 * unusable jar gets reported as a working login.
 *
 * @param {string} raw - the column as written in the file
 * @returns {number|null} seconds since the epoch, 0 for session, null if invalid
 */
function parseExpiry(raw) {
  const text = String(raw == null ? "" : raw).trim()

  // an absent expiry is a session cookie, which is what 0 means here too
  if (text === "" || text === "0") {
    return 0
  }

  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) {
    return null
  }

  // int(float(...)): 1999999999.5 is the same second as 1999999999
  const value = Math.trunc(Number(text))

  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * does this file carry the magic line yt-dlp insists on?
 *
 * not cosmetic and not repairable after the fact: MozillaCookieJar reads the
 * magic off the *first* line and raises for the whole file without it. a jar
 * missing it yields no cookies at all, so "the header is somewhere in here"
 * is not the question - "is it line one" is.
 *
 * @param {string} content - file contents
 * @returns {boolean} true when yt-dlp would agree this is a cookie file
 */
function hasNetscapeHeader(content) {
  const [first = ""] = String(content == null ? "" : content).split("\n", 1)

  // only the carriage return of a crlf file is dropped. python reads the jar
  // with universal newlines, so \r never reaches its regex - but it anchors at
  // the true start of the line, so leading whitespace really is a mismatch
  return NETSCAPE_MAGIC_RE.test(first.replace(/\r$/, ""))
}

/**
 * parse a netscape cookie jar into its entries
 *
 * a jar is a map keyed by domain, path and name rather than a list of rows, so
 * a file listing the same cookie twice holds one of them - the last, which is
 * what MozillaCookieJar's set_cookie leaves behind. Real youtube exports do
 * this: VISITOR_INFO1_LIVE and friends are written once per session. Counting
 * rows claimed more cookies than yt-dlp would have, and could read an expiry
 * off the row that lost.
 *
 * @param {string} content - file contents
 * @returns {Object[]} {domain, path, name, expires} per cookie, in file order
 */
function parseCookieFile(content) {
  const cookies = new Map()

  for (const rawLine of String(content == null ? "" : content).split("\n")) {
    let line = rawLine.trim()

    if (!line) continue

    if (line.startsWith(HTTP_ONLY_PREFIX)) {
      line = line.slice(HTTP_ONLY_PREFIX.length)
    } else if (line.startsWith("#")) {
      continue
    }

    // tabs only, and exactly seven columns. yt-dlp skips the row otherwise -
    // including a space separated one, which is a single column to it
    const parts = line.split("\t")
    if (parts.length !== ENTRY_LEN) continue

    const expires = parseExpiry(parts[4])
    if (expires === null) continue

    const cookie = {
      domain: String(parts[0] || "").toLowerCase(),
      path: parts[2],
      expires,
      name: parts[5]
    }

    // set() on an existing key overwrites the value and keeps the original
    // insertion order, which is the jar's behaviour and the file's order
    cookies.set(`${cookie.domain}\n${cookie.path}\n${cookie.name}`, cookie)
  }

  return [...cookies.values()]
}

// only a youtube cookie can authenticate a youtube request - a jar holding
// nothing but google.com or unrelated cookies is not a youtube login
function isYouTubeDomain(domain) {
  const bare = String(domain || "").replace(/^\./, "")

  return bare === "youtube.com" || bare.endsWith(".youtube.com")
}

// expiry 0 means a session cookie, which has not expired
function isExpired(cookie, now) {
  return cookie.expires > 0 && cookie.expires * 1000 < now
}

/**
 * youtube clears this on sign-out, which is what makes it the reliable half of
 * the pair - the SAPISID cookies survive a rotation, LOGIN_INFO does not
 */
const LOGIN_MARKER = "LOGIN_INFO"

/**
 * any one of these is the other half. SAPISID is sometimes absent where
 * __Secure-3PAPISID is present, so yt-dlp accepts whichever it finds.
 */
const SID_COOKIES = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]

/**
 * is this jar a youtube login, or just cookies from youtube?
 *
 * yt-dlp's _has_auth_cookies, in yt_dlp/extractor/youtube/_base.py: LOGIN_INFO
 * present alongside one of the SAPISID trio. Anything less is what an
 * anonymous visitor already carries - PREF, SOCS, VISITOR_INFO1_LIVE - so a jar
 * exported without signing in first passes "has youtube cookies" and
 * authenticates nothing.
 *
 * this doubles as rotation detection, and gets it for free. --cookies is a
 * write destination as well as a read source, so when youtube rotates the
 * session away it is our stored copy that loses LOGIN_INFO. The jar answers
 * "did these stop working" without us having to watch for the warning yt-dlp
 * prints - which --no-warnings suppresses anyway.
 *
 * @param {Object[]} live - unexpired youtube cookies
 * @returns {boolean} true when yt-dlp would call this authenticated
 */
function isSignedIn(live) {
  const names = new Set(live.map((cookie) => cookie.name))

  return names.has(LOGIN_MARKER) && SID_COOKIES.some((name) => names.has(name))
}

/**
 * describe what a jar holds
 *
 * `usable` answers the only question the app has - will passing this to
 * --cookies make youtube treat us as signed in - so it is yt-dlp's
 * authentication test rather than a count of rows. A jar of visitor cookies
 * used to satisfy it, which meant reporting cookies as active while every
 * request went out anonymous.
 *
 * @param {string} content - file contents
 * @param {number} now - epoch millis, injectable for tests
 * @returns {Object} {total, youtube, expired, signedIn, usable}
 */
function inspectCookieContent(content, now = Date.now()) {
  // no magic line, no cookies - yt-dlp refuses the file rather than reading
  // past it, so counting what is inside would describe a jar nothing will load
  if (!hasNetscapeHeader(content)) {
    return { total: 0, youtube: 0, expired: 0, signedIn: false, usable: false }
  }

  const cookies = parseCookieFile(content)
  const youtube = cookies.filter((cookie) => isYouTubeDomain(cookie.domain))
  const live = youtube.filter((cookie) => !isExpired(cookie, now))
  const signedIn = isSignedIn(live)

  return {
    total: cookies.length,
    youtube: youtube.length,
    expired: youtube.length - live.length,
    signedIn,
    usable: signedIn
  }
}

/**
 * is this file worth passing to --cookies at all?
 *
 * sync on purpose: the engine resolves this while building its argument list.
 *
 * the header is part of the question rather than a detail of it: handing
 * yt-dlp a jar without one makes it raise instead of downloading, so a file it
 * cannot load is worse than no --cookies at all.
 *
 * @param {string} filePath - netscape cookie file
 * @returns {boolean} true when it holds at least one cookie yt-dlp would load
 */
function cookieFileHasEntries(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8")

    return hasNetscapeHeader(content) && parseCookieFile(content).length > 0
  } catch {
    return false
  }
}

module.exports = {
  HTTP_ONLY_PREFIX,
  parseExpiry,
  parseCookieFile,
  hasNetscapeHeader,
  isYouTubeDomain,
  isSignedIn,
  isExpired,
  inspectCookieContent,
  cookieFileHasEntries
}
