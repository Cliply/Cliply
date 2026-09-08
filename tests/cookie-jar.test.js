// the jar parser agrees with yt-dlp about what a cookie file is
//
// every expectation here was taken from the bundled yt-dlp 2026.08.19 itself,
// not from reading its source: --cookies is a write destination as well as a
// read source, so feeding it a fixture and reading back the jar it saves gives
// the exact set of cookies it loaded. /tmp is not a place to keep that, so the
// answers are recorded here.
//
// where we used to disagree we were wrong in both directions. we accepted
// space-separated jars yt-dlp drops every line of, and rejected session
// cookies it keeps. a jar we call usable and yt-dlp ignores is the worse half:
// the user is told cookies are active while every request goes out
// unauthenticated.

const {
  parseCookieFile,
  parseExpiry,
  hasNetscapeHeader,
  inspectCookieContent,
  JAR_UNREADABLE,
  JAR_DOMAIN_FLAG
} = require("../src/main/utils/cookie-jar")

const NETSCAPE = "# Netscape HTTP Cookie File"
// http.cookiejar's magic is `#( Netscape)? HTTP Cookie File` - the short form is
// just as valid, and we used to refuse it
const SHORT = "# HTTP Cookie File"

// domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
//
// the flag follows the leading dot rather than being fixed, because http
// .cookiejar refuses the whole file when the two disagree - a fixture that
// hardcoded TRUE was writing jars yt-dlp would not load
function row({
  domain = ".youtube.com",
  expires = "1999999999",
  name = "SID",
  path = "/",
  value = "value"
} = {}) {
  const flag = domain.startsWith(".") ? "TRUE" : "FALSE"

  return [domain, flag, path, "TRUE", String(expires), name, value].join("\t")
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
      { domain: ".youtube.com", path: "/", expires: 1999999999, name: "SID" }
    ])
  })

  test("strips the #HttpOnly_ prefix rather than reading it as a comment", () => {
    const content = `${NETSCAPE}\n#HttpOnly_${row({ name: "__Secure-1PSID" })}\n`

    expect(parseCookieFile(content)).toEqual([
      { domain: ".youtube.com", path: "/", expires: 1999999999, name: "__Secure-1PSID" }
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

  // a cookie jar is a map keyed by domain/path/name, so a real export that
  // lists a cookie twice - youtube does, for VISITOR_INFO1_LIVE among others -
  // holds one of them, not both. counting rows reported more cookies than
  // yt-dlp would have, and read the wrong expiry off the row that lost
  test("keeps the last of two rows for the same cookie", () => {
    const content =
      `${NETSCAPE}\n` +
      `${row({ name: "VISITOR_INFO1_LIVE", expires: "1797784158" })}\n` +
      `${row({ name: "VISITOR_INFO1_LIVE", expires: "1804407914" })}\n`

    expect(parseCookieFile(content)).toEqual([
      { domain: ".youtube.com", path: "/", expires: 1804407914, name: "VISITOR_INFO1_LIVE" }
    ])
  })

  test("the same name on a different path is a different cookie", () => {
    const content =
      `${NETSCAPE}\n` +
      `.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tv\n` +
      `.youtube.com\tTRUE\t/watch\tTRUE\t1999999999\tSID\tv\n`

    expect(parseCookieFile(content)).toHaveLength(2)
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
      hasSid: false,
      signedIn: false,
      usable: false,
      // and it says so, rather than reading as an empty jar - the sentence for
      // an unreadable file is not the one for a file with nothing in it
      loadError: JAR_UNREADABLE
    })
  })

  test("the short header is accepted", () => {
    expect(inspectCookieContent(`${SHORT}\n${login()}`)).toEqual({
      total: 2,
      youtube: 2,
      expired: 0,
      hasSid: true,
      signedIn: true,
      usable: true,
      loadError: null
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

// what a signed-out jar looks like, and why it is not the same as one that was
// never signed in
//
// taken from a real jar after youtube ended the session: LOGIN_INFO and most of
// the auth cookies gone, __Secure-3PAPISID left behind. yt-dlp writes the jar
// back after every run, so this is the shape our own stored copy takes - and
// the two cases ask the user for different things.
describe("hasSid", () => {
  const live = () => String(Math.floor(Date.now() / 1000) + 3600)
  const jar = (...names) =>
    `${NETSCAPE}\n${names.map((n) => row({ name: n, expires: live() })).join("\n")}\n`

  test("a jar youtube signed out still carries a SAPISID cookie", () => {
    expect(
      inspectCookieContent(jar("__Secure-3PAPISID", "PREF", "VISITOR_INFO1_LIVE"))
    ).toMatchObject({ hasSid: true, signedIn: false })
  })

  test("a jar exported without signing in carries none", () => {
    expect(inspectCookieContent(jar("PREF", "SOCS"))).toMatchObject({
      hasSid: false,
      signedIn: false
    })
  })

  test("an expired SAPISID is not a remnant of a live session", () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600)

    expect(
      inspectCookieContent(`${NETSCAPE}\n${row({ name: "SAPISID", expires: stale })}\n`)
    ).toMatchObject({ hasSid: false })
  })
})

// the cases where we and yt-dlp used to disagree, each answer taken from the
// bundled binary. reverting any one fix turns exactly the test below it red -
// checked by doing it.
describe("what the real yt-dlp does with an awkward row", () => {
  const live = () => String(Math.floor(Date.now() / 1000) + 3600)
  const jar = (...rows) => `${NETSCAPE}\n${rows.join("\n")}\n`
  const names = (content) => parseCookieFile(content).map((c) => c.name)

  // this is the direction that matters: yt-dlp splits on \t with the newline
  // still attached, so an eighth column is a row it refuses. trimming the line
  // first turned it back into a valid seven, and a jar yt-dlp loads nothing
  // from reported itself as a signed-in login
  test("a trailing tab is an eighth column, and the row is dropped", () => {
    const keep = row({ name: "KEEP" })

    expect(names(jar(keep, `${row({ name: "TAIL" })}\t`))).toEqual(["KEEP"])
  })

  // the mirror image, which cost real cookies: an empty value ends the row in a
  // tab too, and trimming collapsed it to six columns
  test("a row whose value is empty is still seven columns, and is kept", () => {
    expect(names(jar(row({ name: "EMPTY", value: "" })))).toEqual(["EMPTY"])
  })

  test.each([
    ["0.5", "HALF"],
    ["0.0", "ZEROFLOAT"],
    ["00", "DBLZERO"],
    ["0", "ZERO"],
    ["", "BLANK"]
  ])(
    "expiry %j is a session cookie, not a malformed row",
    (expires, name) => {
      expect(names(jar(row({ name, expires })))).toEqual([name])
    }
  )

  // yt-dlp fullmatches the column before anything strips whitespace
  test("a padded expiry is a malformed row", () => {
    const keep = row({ name: "KEEP" })

    expect(
      names(jar(keep, row({ name: "PADDED", expires: " 1999999999 " })))
    ).toEqual(["KEEP"])
  })

  // the one that takes the whole download with it: http.cookiejar raises
  // LoadError for the file, yt-dlp turns that into CookieLoadError, and the run
  // exits before anything is fetched. so this is not a row to skip
  test.each([
    [".youtube.com", "FALSE"],
    ["music.youtube.com", "TRUE"]
  ])(
    "a domain column disagreeing with its flag (%s / %s) refuses the whole file",
    (domain, flag) => {
      const bad = [domain, flag, "/", "TRUE", "1999999999", "BAD", "v"].join("\t")

      expect(inspectCookieContent(jar(row({ name: "KEEP" }), bad))).toMatchObject({
        total: 0,
        usable: false,
        loadError: JAR_DOMAIN_FLAG
      })
    }
  )

  test("a jar with no magic first line names that as the reason", () => {
    expect(inspectCookieContent(`${row({ name: "SID" })}\n`)).toMatchObject({
      loadError: JAR_UNREADABLE
    })
  })
})

// _has_auth_cookies reads _get_cookies('https://www.youtube.com'), so the
// question is never "is this cookie from youtube" but "would it be sent there".
// counting any *.youtube.com cookie called a login something yt-dlp would look
// straight past.
describe("only cookies yt-dlp would actually send count as a login", () => {
  const live = () => String(Math.floor(Date.now() / 1000) + 3600)
  const pair = (extra) =>
    `${NETSCAPE}\n${row({ name: "LOGIN_INFO", expires: live(), ...extra })}\n${row({ name: "SAPISID", expires: live(), ...extra })}\n`

  test("the ordinary export - .youtube.com at the root - is a login", () => {
    expect(inspectCookieContent(pair())).toMatchObject({ signedIn: true })
  })

  test("host-only music.youtube.com is youtube's, but never reaches www", () => {
    expect(inspectCookieContent(pair({ domain: "music.youtube.com" }))).toMatchObject({
      youtube: 2,
      signedIn: false
    })
  })

  // a cookie at /account is not sent for a request to /
  test("a path-scoped login is youtube's, and is not sent either", () => {
    expect(inspectCookieContent(pair({ path: "/account" }))).toMatchObject({
      youtube: 2,
      signedIn: false
    })
  })

  // this test used to assert the opposite, on the reasoning that a missing
  // leading dot means exact host only. That is the rule as it is usually
  // described, but python gates it behind strict_ns_domain & DomainStrictNonDomain
  // and defaults strict_ns_domain to DomainLiberal, so it never runs. The real
  // binary was asked directly, through its own extractor, and answered
  // _has_auth_cookies=True for exactly this jar.
  //
  // cliply was telling those users they were signed out, skipping the cookie
  // test for them, and reporting it to analytics that way
  test("a dotless youtube.com login is one yt-dlp calls signed in", () => {
    expect(inspectCookieContent(pair({ domain: "youtube.com" }))).toMatchObject({
      youtube: 2,
      signedIn: true
    })
  })

  // the suffix still has to be a domain suffix, so a sibling subdomain is not
  // sent to www and is not a login there
  test("music.youtube.com is not sent to www.youtube.com", () => {
    expect(
      inspectCookieContent(pair({ domain: "music.youtube.com" }))
    ).toMatchObject({ youtube: 2, signedIn: false })
  })
})
