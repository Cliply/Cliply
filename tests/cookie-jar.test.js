// the jar parser agrees with yt-dlp about what a cookie file is
//
// every expectation here was taken from running yt-dlp's own loader - the
// prepare_line() in yt_dlp/cookies.py feeding CPython's MozillaCookieJar - over
// the same fixture. where we used to disagree we were wrong in both directions:
// we accepted space-separated jars yt-dlp drops every line of, and we rejected
// decimal expiries yt-dlp reads fine. a jar we call usable and yt-dlp ignores is
// the worse half: the user is told cookies are active while every request goes
// out unauthenticated.

const {
  parseCookieFile,
  parseExpiry,
  hasNetscapeHeader,
  inspectCookieContent
} = require("../src/main/utils/cookie-jar")

const NETSCAPE = "# Netscape HTTP Cookie File"
// http.cookiejar's magic is `#( Netscape)? HTTP Cookie File` - the short form is
// just as valid, and we used to refuse it
const SHORT = "# HTTP Cookie File"

// domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
function row({ domain = ".youtube.com", expires = "1999999999", name = "SID" } = {}) {
  return [domain, "TRUE", "/", "TRUE", String(expires), name, "value"].join("\t")
}

describe("hasNetscapeHeader", () => {
  // yt-dlp reads the magic off the first line and fails the whole file without
  // it, so this is not cosmetic: no header means no cookies at all
  test.each([
    [NETSCAPE, true],
    [SHORT, true],
    ["# Netscape HTTP Cookie File (exported by something)", true],
    // the space after # is part of the magic
    ["#HTTP Cookie File", false],
    ["# netscape http cookie file", false],
    ["", false]
  ])("%j -> %s", (first, expected) => {
    expect(hasNetscapeHeader(`${first}\n${row()}\n`)).toBe(expected)
  })

  test("the header has to be the first line, not merely present", () => {
    expect(hasNetscapeHeader(`# a note\n${NETSCAPE}\n${row()}\n`)).toBe(false)
  })
})

describe("parseCookieFile", () => {
  test("reads a tab separated row", () => {
    expect(parseCookieFile(`${NETSCAPE}\n${row()}\n`)).toEqual([
      { domain: ".youtube.com", expires: 1999999999, name: "SID" }
    ])
  })

  test("strips the #HttpOnly_ prefix rather than reading it as a comment", () => {
    const content = `${NETSCAPE}\n#HttpOnly_${row({ name: "__Secure-1PSID" })}\n`

    expect(parseCookieFile(content)).toEqual([
      { domain: ".youtube.com", expires: 1999999999, name: "__Secure-1PSID" }
    ])
  })

  // yt-dlp splits on \t and nothing else: a space separated row is one field,
  // and it skips the line. we used to fall back to splitting on whitespace,
  // which reported cookies yt-dlp would never load
  test("skips a space separated row, as yt-dlp does", () => {
    const content = `${NETSCAPE}\n${row().replace(/\t/g, " ")}\n`

    expect(parseCookieFile(content)).toEqual([])
  })

  // exactly seven, not at least seven
  test("skips a row with an extra field", () => {
    expect(parseCookieFile(`${NETSCAPE}\n${row()}\textra\n`)).toEqual([])
  })

  test("carries on past a bad row instead of failing the file", () => {
    const content = `${NETSCAPE}\n${row({ expires: "-5" })}\n${row({ name: "HSID" })}\n`

    expect(parseCookieFile(content).map((c) => c.name)).toEqual(["HSID"])
  })
})

describe("parseExpiry", () => {
  // yt-dlp's guard is /[0-9]+(?:\.[0-9]+)?/ and MozillaCookieJar then does
  // int(float(...)), so a decimal is a real expiry rather than a malformed row
  test("truncates a decimal expiry", () => {
    expect(parseExpiry("1999999999.5")).toBe(1999999999)
  })

  // an empty expires column is how a session cookie is written, and session
  // cookies carry the login when 'remember me' was never ticked
  test("treats an empty expiry as a session cookie", () => {
    expect(parseExpiry("")).toBe(0)
  })

  test("0 is a session cookie", () => {
    expect(parseExpiry("0")).toBe(0)
  })

  test.each(["-5", "abc", "1e9"])("%j is a malformed row", (raw) => {
    expect(parseExpiry(raw)).toBeNull()
  })
})

// what makes a jar a youtube *login*, rather than merely a jar with youtube
// cookies in it
//
// yt-dlp's _has_auth_cookies is LOGIN_INFO alongside one of the SAPISID trio -
// see yt_dlp/extractor/youtube/_base.py. Everything else is what an anonymous
// visitor already carries, so "we found youtube cookies" was never the same
// question as "you are signed in".
describe("signedIn", () => {
  const live = () => String(Math.floor(Date.now() / 1000) + 3600)
  const jar = (...names) =>
    `${NETSCAPE}\n${names.map((n) => row({ name: n, expires: live() })).join("\n")}\n`

  test.each([
    // LOGIN_INFO plus any one of the three
    [["LOGIN_INFO", "SAPISID"], true],
    [["LOGIN_INFO", "__Secure-1PAPISID"], true],
    [["LOGIN_INFO", "__Secure-3PAPISID"], true],
    // the trio without LOGIN_INFO: youtube clears LOGIN_INFO on sign-out but
    // leaves 3PAPISID behind, so this is the shape of a rotated-out jar
    [["SAPISID", "__Secure-3PAPISID"], false],
    // LOGIN_INFO on its own
    [["LOGIN_INFO"], false],
    // what a signed-out visitor has, and what a careless export collects
    [["PREF", "SOCS", "VISITOR_INFO1_LIVE"], false]
  ])("%j -> %s", (names, expected) => {
    expect(inspectCookieContent(jar(...names)).signedIn).toBe(expected)
  })

  test("an expired auth cookie is not a login", () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600)
    const content =
      `${NETSCAPE}\n` +
      `${row({ name: "LOGIN_INFO", expires: stale })}\n` +
      `${row({ name: "SAPISID", expires: stale })}\n`

    expect(inspectCookieContent(content).signedIn).toBe(false)
  })

  // the whole point of the field: usable has to mean "this will authenticate
  // us", or we tell the user cookies are active while yt-dlp sends none
  test("a jar of visitor cookies is not usable", () => {
    expect(inspectCookieContent(jar("PREF", "SOCS"))).toMatchObject({
      youtube: 2,
      expired: 0,
      signedIn: false,
      usable: false
    })
  })
})

describe("inspectCookieContent", () => {
  const live = () => String(Math.floor(Date.now() / 1000) + 3600)
  // the smallest jar yt-dlp calls a login
  const login = (expires = live()) =>
    `${row({ name: "LOGIN_INFO", expires })}\n${row({ name: "SAPISID", expires })}\n`

  test("a jar with no header is unusable, whatever it holds", () => {
    // yt-dlp raises rather than reading it, so every cookie in it is moot
    expect(inspectCookieContent(login())).toEqual({
      total: 0,
      youtube: 0,
      expired: 0,
      signedIn: false,
      usable: false
    })
  })

  test("the short header is accepted", () => {
    expect(inspectCookieContent(`${SHORT}\n${login()}`)).toEqual({
      total: 2,
      youtube: 2,
      expired: 0,
      signedIn: true,
      usable: true
    })
  })

  test("session cookies carry a login, and have not expired", () => {
    // a sign-in without "remember me" ticked lives entirely in these
    expect(inspectCookieContent(`${NETSCAPE}\n${login("")}`)).toMatchObject({
      expired: 0,
      usable: true
    })
  })
})
