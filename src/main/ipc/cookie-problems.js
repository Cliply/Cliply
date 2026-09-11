// which sentence an unusable cookie jar gets

const { JAR_DOMAIN_FLAG } = require("../utils/cookie-jar")

/**
 * urls the cookie test probes, tried in order
 *
 * a probe target can die upstream - yt-dlp's own long-standing test video
 * (BaW_jenozKc) is gone - and a dead target must never be read as "your
 * cookies failed". so an unavailable video moves on to the next url instead of
 * deciding anything, and only a real extraction result ends the probe.
 */
const COOKIE_TEST_URLS = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  // the oldest video on youtube - about as unlikely to vanish as they come
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "https://www.youtube.com/watch?v=9bZkp7q19f0"
]

/**
 * say which way the jar is unusable, so "not working" is actionable
 *
 * the two signed-in cases below are the ones worth telling apart, because they
 * ask the user for different things and both used to report as a working
 * login. yt-dlp calls a jar authenticated when LOGIN_INFO sits alongside a
 * SAPISID cookie, so:
 *
 *   - youtube cookies, no LOGIN_INFO, no SAPISID either: the export was taken
 *     from a browser that was never signed in
 *   - SAPISID but no LOGIN_INFO: they *were* signed in and youtube has since
 *     rotated the session away. yt-dlp warns about exactly this, and since
 *     --cookies writes the jar back it is our own copy that lost the marker
 */
const JAR_PROBLEMS = {
  JAR_MALFORMED: "that file is malformed, export a fresh one instead of editing it",
  JAR_NOT_COOKIE_FILE: "that isn't a cookies.txt file, export it again",
  JAR_NOTHING_IMPORTED: "nothing imported yet",
  JAR_NO_YOUTUBE: "no youtube cookies in that file",
  JAR_EXPIRED: "your cookies expired, grab a fresh export",
  JAR_SESSION_ENDED: "youtube ended this session, export your cookies again",
  JAR_NEVER_SIGNED_IN:
    "these cookies aren't from a signed-in session, sign in first then export",
  JAR_UNUSABLE: "no usable youtube cookies"
}

/**
 * which of the sentences above a jar has earned
 *
 * the code travels to the renderer beside the sentence, so a russian install
 * can say the same thing without matching english prose - and the english stays
 * the one wording the logs and issue bodies carry.
 */
function cookieJarProblemCode({ total, youtube, expired, hasSid, signedIn, loadError }) {
  // checked first: a jar yt-dlp refuses whole inspects as zero of everything,
  // and "no cookies imported" is the wrong thing to say about a file that is
  // sitting there full of them and taking every download down with it
  if (loadError === JAR_DOMAIN_FLAG) return "JAR_MALFORMED"
  if (loadError) return "JAR_NOT_COOKIE_FILE"
  if (total === 0) return "JAR_NOTHING_IMPORTED"
  if (youtube === 0) return "JAR_NO_YOUTUBE"

  // any expiry at all is worth saying so, rather than only a jar where every
  // last cookie is dead. an export whose login expired alongside a still-live
  // PREF used to fall through to "you were never signed in", which sends the
  // user to fix something that was never wrong
  if (!signedIn && expired > 0) return "JAR_EXPIRED"
  if (!signedIn) return hasSid ? "JAR_SESSION_ENDED" : "JAR_NEVER_SIGNED_IN"

  return "JAR_UNUSABLE"
}

function cookieJarProblem(inspection) {
  return JAR_PROBLEMS[cookieJarProblemCode(inspection)]
}

module.exports = {
  COOKIE_TEST_URLS,
  JAR_PROBLEMS,
  cookieJarProblemCode,
  cookieJarProblem
}
