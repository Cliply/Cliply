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
 * every spelling that truncates to zero is a session cookie, not a bad row.
 * "0.5", "0.0" and "00" all pass yt-dlp's guard and land on 0 - verified
 * against the bundled 2026.08.19 binary, which saved each of them back as 0.
 * rejecting them dropped cookies yt-dlp keeps.
 *
 * the column is used exactly as written: yt-dlp fullmatches it before anything
 * strips whitespace, so " 1999999999 " is a row it skips rather than a padded
 * timestamp.
 *
 * @param {string} raw - the column as written in the file
 * @returns {number|null} seconds since the epoch, 0 for session, null if invalid
 */
function parseExpiry(raw) {
  const text = String(raw == null ? "" : raw)

  // an absent expiry is a session cookie
  if (text === "") {
    return 0
  }

  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) {
    return null
  }

  // int(float(...)): 1999999999.5 is the same second as 1999999999
  const value = Math.trunc(Number(text))

  return Number.isSafeInteger(value) ? value : null
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
 * the two ways a file is refused whole rather than row by row
 *
 * yt-dlp's loader has two layers and they fail differently. Its prepare_line
 * drops a bad *row* with a warning and carries on. MozillaCookieJar underneath
 * raises LoadError for the *file*, and yt-dlp turns that into CookieLoadError -
 * which aborts the run before a single byte is downloaded. A jar that trips the
 * second kind is worse than no jar at all, so it has to be told apart.
 */
const JAR_UNREADABLE = "not-netscape"
const JAR_DOMAIN_FLAG = "domain-flag-mismatch"

/**
 * read a jar the way yt-dlp's two layers read one
 *
 * a jar is a map keyed by domain, path and name rather than a list of rows, so
 * a file listing the same cookie twice holds one of them - the last, which is
 * what MozillaCookieJar's set_cookie leaves behind. Real youtube exports do
 * this: VISITOR_INFO1_LIVE and friends are written once per session. Counting
 * rows claimed more cookies than yt-dlp would have, and could read an expiry
 * off the row that lost.
 *
 * lines are not trimmed. yt-dlp splits on \t with the newline still attached
 * and refuses any length but seven, so a trailing tab is an eighth column and
 * the row is skipped - while trimming turned that same row back into a valid
 * seven and let a jar yt-dlp loads nothing from report itself as a login. The
 * mirror image cost real cookies: a row whose value is empty ends in a tab too,
 * and trimming collapsed it to six columns and dropped a cookie yt-dlp keeps.
 * Both verified against the bundled 2026.08.19 binary.
 *
 * @param {string} content - file contents
 * @returns {{error: string|null, cookies: Object[]}} why it is unloadable, or
 *   its cookies in file order
 */
function readJar(content) {
  const text = String(content == null ? "" : content)

  // the magic is read off line one; without it yt-dlp raises for the whole file
  if (!hasNetscapeHeader(text)) {
    return { error: JAR_UNREADABLE, cookies: [] }
  }

  const cookies = new Map()

  for (const rawLine of text.split("\n")) {
    // python reads with universal newlines, so only \r is ours to drop
    const line = rawLine.replace(/\r$/, "")

    if (!line.trim()) continue

    let row = line

    if (row.startsWith(HTTP_ONLY_PREFIX)) {
      row = row.slice(HTTP_ONLY_PREFIX.length)
    } else if (row.startsWith("#")) {
      continue
    }

    // tabs only, and exactly seven columns. yt-dlp skips the row otherwise -
    // including a space separated one, which is a single column to it
    const parts = row.split("\t")
    if (parts.length !== ENTRY_LEN) continue

    const expires = parseExpiry(parts[4])
    if (expires === null) continue

    const domain = String(parts[0] || "").toLowerCase()

    /**
     * the row that kills the whole download.
     *
     * MozillaCookieJar requires column 2 to agree with the leading dot, and
     * raises LoadError for the file when it does not - so one hand-edited row,
     * or one exporter that writes "music.youtube.com TRUE", makes yt-dlp exit
     * with CookieLoadError and nothing downloads. This is the only per-row
     * problem that is not survivable, which is why it returns instead of
     * skipping. Confirmed both ways against the bundled binary: ".youtube.com
     * FALSE" and "music.youtube.com TRUE" each aborted the run.
     */
    if ((parts[1] === "TRUE") !== domain.startsWith(".")) {
      return { error: JAR_DOMAIN_FLAG, cookies: [] }
    }

    const cookie = { domain, path: parts[2], expires, name: parts[5] }

    // set() on an existing key overwrites the value and keeps the original
    // insertion order, which is the jar's behaviour and the file's order
    cookies.set(`${cookie.domain}\n${cookie.path}\n${cookie.name}`, cookie)
  }

  return { error: null, cookies: [...cookies.values()] }
}

/**
 * the cookies yt-dlp would load from this file, or none if it would refuse it
 *
 * @param {string} content - file contents
 * @returns {Object[]} {domain, path, name, expires} per cookie, in file order
 */
function parseCookieFile(content) {
  return readJar(content).cookies
}

// only a youtube cookie can authenticate a youtube request - a jar holding
// nothing but google.com or unrelated cookies is not a youtube login. this is
// the loose question, "did this come from youtube", and it is what the counts
// shown to the user are about
function isYouTubeDomain(domain) {
  const bare = String(domain || "").replace(/^\./, "")

  return bare === "youtube.com" || bare.endsWith(".youtube.com")
}

/**
 * the url yt-dlp actually asks the jar about when it decides you are signed in
 *
 * _has_auth_cookies reads self._get_cookies('https://www.youtube.com'), so the
 * question is never "is this cookie from youtube" but "would this cookie be
 * sent to that address". A host-only cookie on music.youtube.com, or one scoped
 * to /account, is a real youtube cookie that yt-dlp will not see there.
 */
const AUTH_HOST = "www.youtube.com"
const AUTH_PATH = "/"

/**
 * would http.cookiejar attach this cookie to that request?
 *
 * this used to treat a missing leading dot as "exact host only", which is the
 * rule as it is usually described and not the one python applies. DefaultCookiePolicy
 * gates that restriction behind strict_ns_domain & DomainStrictNonDomain, and
 * strict_ns_domain defaults to DomainLiberal, so the check never runs. What is
 * left for a version 0 cookie is ("." + request host).endswith("." + domain),
 * which ".www.youtube.com" satisfies against "youtube.com".
 *
 * so a jar holding LOGIN_INFO and SAPISID on a dotless youtube.com is one the
 * real binary calls signed in - confirmed by loading its own extractor, which
 * answered _has_auth_cookies=True - while cliply called it signed out, told the
 * user so, skipped the cookie test and reported it that way to analytics.
 *
 * path stays a prefix match against "/", so a cookie scoped to /account still
 * does not qualify, and music.youtube.com still fails the suffix test.
 */
function appliesToAuthRequest(cookie) {
  const domain = String(cookie.domain || "").replace(/^\./, "")
  const dotted = `.${domain}`

  return (
    `.${AUTH_HOST}`.endsWith(dotted) &&
    AUTH_PATH.startsWith(cookie.path || "/")
  )
}

// expiry 0 means a session cookie, which has not expired. the comparison is
// <=, matching http.cookiejar's Cookie.is_expired - a cookie whose second has
// arrived is gone, not live for one more tick
function isExpired(cookie, now) {
  return cookie.expires > 0 && cookie.expires * 1000 <= now
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
 * does this jar carry a SAPISID cookie, signed in or not?
 *
 * the half of the pair youtube leaves behind. ending a session clears
 * LOGIN_INFO and most of the auth cookies but not __Secure-3PAPISID, so a jar
 * with one of these and no LOGIN_INFO is one that used to work - which is a
 * different thing to tell someone than "you were never signed in", and asks
 * for a different fix.
 *
 * @param {Object[]} live - unexpired youtube cookies
 * @returns {boolean} true when the remnant of a session is present
 */
function hasSidCookie(live) {
  const names = new Set(live.map((cookie) => cookie.name))

  return SID_COOKIES.some((name) => names.has(name))
}

/**
 * describe what a jar holds
 *
 * three separate questions, kept separate because conflating them is what put
 * wrong sentences in front of users:
 *
 *   - `loadError` - would yt-dlp refuse the file outright. A jar that trips
 *     this is worse than no jar: the run aborts before anything downloads
 *   - `youtube` - how many cookies came from youtube, which is what the counts
 *     on screen mean
 *   - `signedIn` / `usable` - would yt-dlp call this authenticated, which is
 *     narrower still: only cookies it would actually send to www.youtube.com
 *     count, so a login exported host-only on music.youtube.com is cookies
 *     from youtube that authenticate nothing
 *
 * @param {string} content - file contents
 * @param {number} now - epoch millis, injectable for tests
 * @returns {Object} {total, youtube, expired, hasSid, signedIn, usable, loadError}
 */
function inspectCookieContent(content, now = Date.now()) {
  const { error, cookies } = readJar(content)

  if (error) {
    return {
      total: 0,
      youtube: 0,
      expired: 0,
      hasSid: false,
      signedIn: false,
      usable: false,
      loadError: error
    }
  }

  const youtube = cookies.filter((cookie) => isYouTubeDomain(cookie.domain))
  const live = youtube.filter((cookie) => !isExpired(cookie, now))
  // the auth pair is looked for only among cookies that would reach the address
  // yt-dlp asks about
  const sendable = live.filter(appliesToAuthRequest)
  const signedIn = isSignedIn(sendable)

  return {
    total: cookies.length,
    youtube: youtube.length,
    expired: youtube.length - live.length,
    hasSid: hasSidCookie(sendable),
    signedIn,
    usable: signedIn,
    loadError: null
  }
}

/**
 * is this file worth passing to --cookies at all?
 *
 * sync on purpose: the engine resolves this while building its argument list.
 *
 * the bar is deliberately low - loadable, and holding something. Whether a jar
 * is worth anything is yt-dlp's call to make, not ours, and gating this on our
 * own authentication test meant a jar with a partial or rotating session was
 * silently withheld from a download that might have gone through with it. The
 * one thing we do owe yt-dlp is not handing it a file that makes it abort:
 * a missing header or a domain-flag mismatch raises rather than downloads, so
 * those are worse than passing nothing.
 *
 * @param {string} filePath - netscape cookie file
 * @returns {boolean} true when it holds at least one cookie yt-dlp would load
 */
function cookieFileHasEntries(filePath) {
  try {
    const { error, cookies } = readJar(fs.readFileSync(filePath, "utf8"))

    return !error && cookies.length > 0
  } catch {
    return false
  }
}

module.exports = {
  HTTP_ONLY_PREFIX,
  JAR_UNREADABLE,
  JAR_DOMAIN_FLAG,
  parseExpiry,
  readJar,
  parseCookieFile,
  hasNetscapeHeader,
  isYouTubeDomain,
  appliesToAuthRequest,
  isSignedIn,
  hasSidCookie,
  isExpired,
  inspectCookieContent,
  cookieFileHasEntries
}
