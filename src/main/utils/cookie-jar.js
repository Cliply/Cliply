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
 * expiry is column 5: a unix timestamp, or 0 for a session cookie
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

  if (text === "0") {
    return 0
  }

  if (!/^\d+$/.test(text)) {
    return null
  }

  const value = Number(text)

  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * parse a netscape cookie jar into its entries
 * @param {string} content - file contents
 * @returns {Object[]} {domain, name, expires} per valid cookie line
 */
function parseCookieFile(content) {
  const cookies = []

  for (const rawLine of String(content == null ? "" : content).split("\n")) {
    let line = rawLine.trim()

    if (!line) continue

    if (line.startsWith(HTTP_ONLY_PREFIX)) {
      line = line.slice(HTTP_ONLY_PREFIX.length)
    } else if (line.startsWith("#")) {
      continue
    }

    // the format is tab separated, but some exporters use runs of spaces
    let parts = line.split("\t")
    if (parts.length < 7) {
      parts = line.split(/\s+/)
    }
    if (parts.length < 7) continue

    const expires = parseExpiry(parts[4])
    if (expires === null) continue

    cookies.push({
      domain: String(parts[0] || "").toLowerCase(),
      expires,
      name: parts[5]
    })
  }

  return cookies
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
 * describe what a jar holds
 * @param {string} content - file contents
 * @param {number} now - epoch millis, injectable for tests
 * @returns {Object} {total, youtube, expired, usable}
 */
function inspectCookieContent(content, now = Date.now()) {
  const cookies = parseCookieFile(content)
  const youtube = cookies.filter((cookie) => isYouTubeDomain(cookie.domain))
  const live = youtube.filter((cookie) => !isExpired(cookie, now))

  return {
    total: cookies.length,
    youtube: youtube.length,
    expired: youtube.length - live.length,
    usable: live.length > 0
  }
}

/**
 * is this file worth passing to --cookies at all?
 *
 * sync on purpose: the engine resolves this while building its argument list.
 *
 * @param {string} filePath - netscape cookie file
 * @returns {boolean} true when it holds at least one parseable cookie
 */
function cookieFileHasEntries(filePath) {
  try {
    return parseCookieFile(fs.readFileSync(filePath, "utf8")).length > 0
  } catch {
    return false
  }
}

module.exports = {
  HTTP_ONLY_PREFIX,
  parseExpiry,
  parseCookieFile,
  isYouTubeDomain,
  isExpired,
  inspectCookieContent,
  cookieFileHasEntries
}
