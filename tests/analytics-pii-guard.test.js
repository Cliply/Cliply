/**
 * the privacy invariant, held over the boundary as a whole.
 *
 * services/analytics.js already refuses a great deal: a per-event property
 * allowlist, a vocabulary or a numeric anchor for every string kind, and a
 * sanitizer that fails closed on the one free-text property. a guard that
 * merely re-sent the values those already reject would pass forever and catch
 * nothing - the mechanism is what stops them, and it is already tested in
 * analytics.test.js.
 *
 * so this file guards the two things the mechanism cannot guard about itself.
 *
 *   - what actually leaves, for every event and every property the module
 *     declares. the matrix is derived from ALLOWED_PROPERTIES rather than
 *     listed here, so a property or an event added by a later task is driven
 *     through the same hostile corpus without anybody remembering to come back
 *     and add it - the way error_category's vocabulary extended for free when
 *     the taxonomy grew.
 *
 *   - the shape of the boundary itself: which kinds exist, which properties
 *     are free text, which events may carry free text, and what rides every
 *     event as a super property outside the allowlist entirely. each of those
 *     is pinned below, so widening one means editing this file, which makes it
 *     a decision somebody took on purpose rather than a line that slipped past
 *     a reviewer.
 *
 * nothing here is mocked. a suite that mocks services/ytdlp-engine takes
 * redactLogLine down with it, and one that mocks utils/analytics-helpers takes
 * describeError; either way every text-bearing capture dies in capture()'s
 * catch and the guard passes having sent nothing. the liveness assertions at
 * the bottom of the census are what would notice.
 */

const os = require("os")
const {
  Analytics,
  ALLOWED_PROPERTIES,
  PROPERTY_KINDS
} = require("../src/main/services/analytics")
const {
  ERROR_CATEGORIES,
  ERROR_STAGES
} = require("../src/main/utils/error-taxonomy")

const HOME = os.homedir()

let warn

beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

/** a real Analytics with a fake transport, so what is asserted is what leaves */
async function ready() {
  const sent = []

  const analytics = new Analytics({
    settingsStore: {
      getInstallId: async () => "11111111-2222-3333-4444-555555555555",
      isAnalyticsEnabled: async () => true,
      setAnalyticsEnabled: async () => ({ success: true })
    },
    createClient: () => ({
      capture: (message) => sent.push(message),
      flush: async () => {}
    }),
    forceEnabled: true
  })

  await analytics.init()

  return { analytics, sent }
}

/**
 * text nobody at this company wrote.
 *
 * every value carries the secrets it must not give up, and the assertion is
 * their absence from the message the client received - not that some pattern
 * fired, which is the mechanism's own business. the wording is deliberately
 * not ours: a fixture built from our own error table proves only that we can
 * write a safe sentence.
 */
const HOSTILE = [
  {
    name: "a watch url",
    value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    secrets: ["dQw4w9WgXcQ", "youtube.com"]
  },
  {
    name: "a short link carrying the id in its path",
    value: "https://youtu.be/dQw4w9WgXcQ",
    secrets: ["dQw4w9WgXcQ", "youtu.be"]
  },
  {
    name: "a path under this machine's home directory",
    value: `${HOME}/Movies/My Holiday Video.mp4`,
    secrets: [HOME, "Holiday", ".mp4"]
  },
  {
    name: "a windows path naming its user",
    value: "C:\\Users\\devansh\\Videos\\My Holiday Video.mp4",
    secrets: ["devansh", "Holiday", ".mp4"]
  },
  {
    name: "a unc share",
    value: "\\\\nas-01\\media\\My Holiday Video.mp4",
    secrets: ["nas-01", "Holiday", ".mp4"]
  },
  {
    name: "a relative path, which no pattern can tell from prose",
    value: "Movies/My Holiday Video.mp4 failed",
    secrets: ["Holiday", ".mp4"]
  },
  {
    name: "a path hanging off a home marker",
    value: "~/Movies/My Holiday Video.mp4",
    secrets: ["Holiday", ".mp4"]
  },
  {
    name: "a bare filename in another script",
    value: "видео.mp4",
    secrets: ["видео", ".mp4"]
  },
  {
    name: "a quoted title",
    value: 'Failed to process "My Holiday Video"',
    secrets: ["Holiday"]
  },
  {
    name: "an email address",
    value: "mail someone@example.com about it",
    secrets: ["someone@example.com", "example.com"]
  },
  {
    name: "an ipv4",
    value: "could not connect to 140.82.121.4 for the release",
    secrets: ["140.82.121.4"]
  },
  {
    name: "a link-local ipv6 naming the interface",
    value: "could not connect to fe80::a%en0",
    secrets: ["fe80::a", "en0"]
  },
  {
    name: "a mac address, which is an identity no ip rule catches",
    value: "hardware id 00:1b:44:11:3a:b7 refused",
    secrets: ["00:1b:44"]
  },
  {
    name: "a line out of a cookie jar",
    value:
      ".youtube.com\tTRUE\t/\tTRUE\t1799999999\tSID\tg.a000abcdEFGHijkl0123",
    secrets: ["g.a000abcdEFGHijkl0123", "youtube.com"]
  },
  {
    name: "a windows temp path with the user in the middle",
    value:
      "ffmpeg could not write C:/Users/devansh/AppData/Local/Temp/clip.part",
    secrets: ["devansh", "AppData"]
  }
]

/**
 * shapes that may not appear in anything sent, whatever property carries them
 * and whether or not the corpus above put them there.
 *
 * this is the half that speaks for the values nobody thought to seed - a
 * property a later task adds and populates from somewhere none of us looked.
 */
const FORBIDDEN = [
  { name: "a url scheme", pattern: /[a-z][a-z0-9+.-]*:\/\//i },
  { name: "a windows drive path", pattern: /\b[A-Za-z]:[\\/]/ },
  { name: "a unix home path", pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]/ },
  { name: "a unc share", pattern: /\\\\[A-Za-z0-9]/ },
  {
    name: "a media file name",
    pattern: /\.(?:mp4|webm|mkv|mov|avi|mp3|m4a|opus|aac|flac|wav|part)\b/i
  },
  { name: "an email address", pattern: /\S@\S/ },
  { name: "an ipv4", pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ }
]

// this machine's own home directory, added only when it is long enough to be
// a meaningful match - a homedir of "/" would otherwise match every string
if (HOME && HOME.length > 3) {
  FORBIDDEN.push({
    name: "this machine's home directory",
    pattern: new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  })
}

/** every string a message would carry over the wire, keys included */
function strings(message) {
  const found = []

  for (const [key, value] of Object.entries(message.properties || {})) {
    found.push(key)
    if (typeof value === "string") found.push(value)
  }

  return found
}

function assertShapesClean(message, context) {
  for (const text of strings(message)) {
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) {
        throw new Error(
          `${context}: sent something shaped like ${name} - ${JSON.stringify(text)}`
        )
      }
    }
  }
}

// every (event, property) pair the module declares, read off the module rather
// than typed out - a pair added later is covered without a line changing here
const PAIRS = Object.entries(ALLOWED_PROPERTIES).flatMap(([event, keys]) =>
  keys.map((key) => ({ event, key }))
)

describe("nothing personal survives any declared property", () => {
  /**
   * the census. every declared property is handed every hostile value, and
   * nothing the value was hiding may appear in what the client received.
   *
   * most pairs pass by dropping, which is the mechanism doing its job and is
   * not what this proves. what it proves is that the *next* property - and the
   * next kind, and the next event - is held to the same thing on the day it is
   * added, by a matrix that grew to include it on its own.
   */
  it("holds for every event and property the module declares", async () => {
    const { analytics, sent } = await ready()

    for (const { event, key } of PAIRS) {
      for (const { name, value, secrets } of HOSTILE) {
        const before = sent.length

        analytics.capture(event, { [key]: value })

        const context = `${event}.${key} given ${name}`

        // an event that stopped being sent is a census that stopped proving
        // anything - the failure mode where capture() dies in its catch and
        // the whole file passes having transmitted nothing
        expect(sent.length).toBe(before + 1)

        const message = sent[sent.length - 1]
        const serialised = JSON.stringify(message)

        for (const secret of secrets) {
          if (serialised.includes(secret)) {
            throw new Error(
              `${context}: ${JSON.stringify(secret)} left in ${serialised}`
            )
          }
        }

        assertShapesClean(message, context)
      }
    }

    expect(sent).toHaveLength(PAIRS.length * HOSTILE.length)
  })

  it("says nothing about the values it refused, either", async () => {
    // the drop warning is the other way out of this process. it goes to a log
    // file people attach to bug reports, so a future kind that named the value
    // it rejected would move the leak rather than close it
    const { analytics } = await ready()

    warn.mockClear()

    for (const { event, key } of PAIRS) {
      for (const { value } of HOSTILE) {
        analytics.capture(event, { [key]: value })
      }
    }

    const logged = warn.mock.calls
      .flat()
      .map((entry) => String(entry))
      .join(" ")

    for (const { secrets } of HOSTILE) {
      for (const secret of secrets) {
        expect(logged).not.toContain(secret)
      }
    }

    // and the catch that reports a capture blowing up must not have fired:
    // a census that spent itself inside that catch proves nothing at all
    expect(logged).not.toContain("capture failed")
  })

  it("is driving the real sanitizer, not a mock that happens to say nothing", async () => {
    // the liveness check the two above lean on. if redactLogLine or
    // describeError were mocked away by a future change to this file's imports,
    // this is the assertion that goes red instead of the suite going quiet
    const { analytics, sent } = await ready()

    analytics.capture("download_failed", {
      error_message: `unable to open ${HOME}/Movies/x.mp4 (permission denied)`
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].properties.error_message).toBe(
      "unable to open [path] (permission denied)"
    )
  })
})

describe("the shape of the boundary is pinned, so widening it is a decision", () => {
  /**
   * every kind that exists, and the argument that makes it safe.
   *
   * a kind is where a value stops being checked, so adding one is the single
   * most consequential edit available in that module - and the one edit no
   * allowlist governs, because the allowlist is a list of names and this is a
   * list of what may be done with them.
   *
   * a new kind fails this test until it is written down here with a reason.
   */
  const REVIEWED_KINDS = {
    bool: "a javascript boolean, or nothing",
    number: "a finite non-negative number, never a coerced string",
    platform: "a closed set of site names; anything else becomes 'unsupported'",
    vocabulary: "a finite set of values we own, per property",
    quality: "digit-anchored heights and bitrates, plus a closed list",
    version: "digits and dots, letters only inside a prerelease segment",
    bucket: "a pre-bucketed label, anchored on a digit or a comparison",
    text: "free prose, scrubbed and then refused if any shape still stands"
  }

  it("declares no kind that has not been argued for", () => {
    const declared = [...new Set(Object.values(PROPERTY_KINDS))].sort()

    // both directions on purpose. an unreviewed kind is the leak; a reviewed
    // kind nobody uses any more is a stale claim about a boundary that moved
    expect(declared).toEqual(Object.keys(REVIEWED_KINDS).sort())
  })

  it("gives every declared property a kind", () => {
    // an allowed but unkinded property reaches checkKind's default and drops,
    // so it is not a leak - it is an event that quietly stopped carrying the
    // thing somebody added it for
    const unkinded = PAIRS.filter(
      ({ key }) => !Object.hasOwn(PROPERTY_KINDS, key)
    ).map(({ event, key }) => `${event}.${key}`)

    expect(unkinded).toEqual([])
  })

  /**
   * free text is the one kind with no closed set behind it, and it has a
   * documented floor (see the last block in this file). one property is worth
   * that floor because a failure nobody can read is a failure nobody can fix.
   * a second one has to earn it the same way, in review.
   */
  it("keeps free text to the one property that has argued for it", () => {
    const freeText = Object.entries(PROPERTY_KINDS)
      .filter(([, kind]) => kind === "text")
      .map(([key]) => key)
      .sort()

    expect(freeText).toEqual(["error_message"])
  })

  it("keeps free text to the events that have argued for it", () => {
    // the failures a person can act on. a success path carrying free text
    // would be prose written while nothing was wrong, which is the shape a
    // title arrives in
    const textKeys = new Set(
      Object.entries(PROPERTY_KINDS)
        .filter(([, kind]) => kind === "text")
        .map(([key]) => key)
    )

    const bearers = Object.entries(ALLOWED_PROPERTIES)
      .filter(([, keys]) => keys.some((key) => textKeys.has(key)))
      .map(([event]) => event)
      .sort()

    expect(bearers).toEqual([
      "download_failed",
      "engine_update_failed",
      "media_info_failed"
    ])
  })

  /**
   * the super properties, which the allowlist does not cover at all.
   *
   * capture() spreads them last, over the validated bag, and they are the
   * module's own values rather than a caller's - so nothing in checkKind ever
   * looks at them. a later task adding one to init() would put it on every
   * event with no review anywhere in the code. this is that review.
   */
  it("pins what rides every event outside the allowlist", async () => {
    const { analytics, sent } = await ready()

    // no caller properties at all, so what arrives is exactly the super set
    analytics.capture("app_launched")

    expect(sent).toHaveLength(1)
    expect(Object.keys(sent[0].properties).sort()).toEqual([
      "app_version",
      "arch",
      "locale",
      "os",
      "os_version"
    ])

    assertShapesClean(sent[0], "the super properties")
  })

  it("pins the one super property a caller can reach", async () => {
    // setEngineVersion is the only path from outside into that bag, and it is
    // the only key allowed to appear beyond the five above
    const { analytics, sent } = await ready()

    analytics.setEngineVersion("2026.08.19")
    analytics.capture("app_launched")

    expect(Object.keys(sent[0].properties).sort()).toEqual([
      "app_version",
      "arch",
      "engine_version",
      "locale",
      "os",
      "os_version"
    ])
  })
})

describe("the vocabularies that widen without this module being touched", () => {
  /**
   * error_category and error_stage are read from the taxonomy rather than
   * copied, which is what let task 7's new category work with no edit here.
   * that convenience is also the one route by which a value reaches the wire
   * without anybody opening services/analytics.js - so the taxonomy's whole
   * range is driven through the boundary and checked for shape.
   *
   * a category named after a path, a host or a file would arrive already
   * accepted. this is what stops it.
   */
  const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/

  it("sends every taxonomy value as a bare identifier and nothing more", async () => {
    const { analytics, sent } = await ready()

    const values = [
      ...Object.values(ERROR_CATEGORIES).map((value) => ({
        key: "error_category",
        value
      })),
      ...Object.values(ERROR_STAGES).map((value) => ({
        key: "error_stage",
        value
      }))
    ]

    expect(values.length).toBeGreaterThan(0)

    for (const { key, value } of values) {
      const before = sent.length
      analytics.capture("download_failed", { [key]: value })
      expect(sent.length).toBe(before + 1)

      const message = sent[sent.length - 1]

      // accepted, or the taxonomy and the boundary have drifted - which
      // analytics.test.js also asserts, from the other direction
      expect(message.properties[key]).toBe(value)
      expect(message.properties[key]).toMatch(IDENTIFIER)
      assertShapesClean(message, `${key} = ${value}`)
    }
  })
})

describe("the floor, written down where somebody will find it", () => {
  async function sent(text) {
    const { analytics, sent: messages } = await ready()
    analytics.capture("download_failed", { error_message: text })
    expect(messages).toHaveLength(1)
    return messages[0].properties.error_message
  }

  /**
   * what the sanitizer bounds, which is the part worth guarding.
   *
   * every one of these delimits the title itself - a quote around it, a
   * separator before it, an extension welded to it - and every one of them
   * takes the whole title with it.
   */
  it("takes a title the message itself delimits", async () => {
    expect(await sent('Failed to process "My Holiday Video"')).toBe(
      "Failed to process [text]"
    )

    expect(await sent("Failed to process MyHolidayVideo.mp4")).toBe(
      "Failed to process [file]"
    )

    // a relative path cannot be cleaned, so it is refused whole
    expect(await sent("Failed to process Movies/My Holiday Video")).toBe(
      "[redacted]"
    )

    expect(
      await sent(
        `unable to open ${HOME}/Movies/My Holiday Video.mp4 (permission denied)`
      )
    ).toBe("unable to open [path] (permission denied)")
  })

  /**
   * and what it does not bound, stated exactly, because a limit nobody can see
   * is a limit nobody can weigh.
   *
   * the residue is one thing in three costumes: **unquoted words survive
   * beside whatever was scrubbed**. a name holding spaces has no findable left
   * or right edge - "My Holiday Video.mp4" is one thing to a person and three
   * tokens to a regex - so the scrub takes the token that carried the shape and
   * leaves the words next to it standing. the same residue appears whether the
   * message carried a shape at all (the first case), carried one welded to the
   * last word (the second), or carried a real path whose final segment had no
   * dot to let PATH_TAIL keep going (the third).
   *
   * the two available fixes are both worse. refusing every message that holds
   * an extension turns nearly all of yt-dlp's and node's wording into
   * "[redacted]", and a failure nobody can read is a failure nobody can fix -
   * "could not write [file]" is the tested behaviour that says this design
   * chose otherwise on purpose. consuming leftwards to the start of the line
   * eats the diagnosis instead, which is the thing PATH_TAIL's space rule
   * exists to avoid.
   *
   * so it is accepted, and it is accepted knowingly: no caller in this codebase
   * puts a bare spaced name into an error string. node, ffmpeg and yt-dlp all
   * name an absolute path, which the block above shows is taken whole.
   *
   * this test is written to be deleted. the day a rule can bound a spaced name,
   * all three go red at once, and whoever tightened the sanitizer reads this
   * note and removes them.
   */
  it("leaves unquoted words standing beside whatever it scrubbed", async () => {
    // nothing to key on at all - the case that has no shape anywhere
    expect(await sent("Failed to process My Holiday Video")).toBe(
      "Failed to process My Holiday Video"
    )

    // a shape welded to the last word only takes that word
    expect(await sent("Failed to process My Holiday Video.mp4")).toBe(
      "Failed to process My Holiday [file]"
    )

    // a genuine home path, whose last segment has no dot for the tail's
    // lookahead to find, so the path match stops at the first space
    expect(await sent(`Failed to process ${HOME}/My Holiday Video`)).toBe(
      "Failed to process [path] Holiday Video"
    )
  })
})
