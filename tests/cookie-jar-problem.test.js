// which sentence an unusable jar gets
//
// these are the words a blocked user reads, and the two signed-out cases ask
// for different things: one says sign in before exporting, the other says your
// session ended, export again. They looked identical to this function until a
// real jar - signed out mid-session by youtube, LOGIN_INFO gone and
// __Secure-3PAPISID left behind - was told it had never been signed in.

const { cookieJarProblem } = require("../src/main/ipc-handlers")

const jar = (over = {}) => ({
  total: 12,
  youtube: 12,
  expired: 0,
  hasSid: false,
  signedIn: false,
  ...over
})

test("an empty jar", () => {
  expect(cookieJarProblem(jar({ total: 0, youtube: 0 }))).toBe("nothing imported yet")
})

test("a jar exported for some other site", () => {
  expect(cookieJarProblem(jar({ youtube: 0 }))).toMatch(/no youtube cookies/)
})

test("every youtube cookie past its expiry", () => {
  expect(cookieJarProblem(jar({ expired: 12 }))).toMatch(/expired/)
})

// the two that used to share a sentence
test("signed out by youtube: the SAPISID remnant is the tell", () => {
  expect(cookieJarProblem(jar({ hasSid: true }))).toBe(
    "youtube ended this session, export your cookies again"
  )
})

test("never signed in: no remnant to find", () => {
  expect(cookieJarProblem(jar({ hasSid: false }))).toBe(
    "these cookies aren't from a signed-in session, sign in first then export"
  )
})

// a jar yt-dlp refuses whole inspects as zero of everything, so without this it
// falls into the "No cookies imported" branch - the words for an untouched
// install, said about a file sitting right there full of cookies and taking
// every download down with it
describe("a file yt-dlp will not open at all", () => {
  const {
    JAR_UNREADABLE,
    JAR_DOMAIN_FLAG
  } = require("../src/main/utils/cookie-jar")

  const refused = (loadError) =>
    cookieJarProblem(jar({ total: 0, youtube: 0, loadError }))

  test("a domain column that disagrees with its own flag", () => {
    expect(refused(JAR_DOMAIN_FLAG)).toMatch(/malformed/)
  })

  test("a file with no netscape header", () => {
    expect(refused(JAR_UNREADABLE)).toMatch(/isn't a cookies\.txt/)
  })
})

// "every last cookie expired" was too narrow a test to reach the expiry
// sentence. a real export whose login has aged out still carries a live PREF or
// SOCS, so expired < youtube, and it fell through to being told it was never a
// signed-in export - which sends the user to fix something that was never wrong
test("a login that expired beside a still-live visitor cookie", () => {
  expect(cookieJarProblem(jar({ youtube: 3, expired: 2, hasSid: false }))).toMatch(
    /expired/
  )
})

test("a jar with nothing expired in it is not called expired", () => {
  expect(cookieJarProblem(jar({ youtube: 3, expired: 0, hasSid: false }))).toMatch(
    /aren't from a signed-in session/
  )
})
