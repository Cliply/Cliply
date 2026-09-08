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
  expect(cookieJarProblem(jar({ total: 0, youtube: 0 }))).toBe("No cookies imported")
})

test("a jar exported for some other site", () => {
  expect(cookieJarProblem(jar({ youtube: 0 }))).toMatch(/no YouTube cookies/)
})

test("every youtube cookie past its expiry", () => {
  expect(cookieJarProblem(jar({ expired: 12 }))).toMatch(/expired/)
})

// the two that used to share a sentence
test("signed out by youtube: the SAPISID remnant is the tell", () => {
  expect(cookieJarProblem(jar({ hasSid: true }))).toBe(
    "YouTube ended this session - export your cookies again"
  )
})

test("never signed in: no remnant to find", () => {
  expect(cookieJarProblem(jar({ hasSid: false }))).toBe(
    "These YouTube cookies aren't from a signed-in session - sign in first, then export"
  )
})
