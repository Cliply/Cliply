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

const fs = require("fs")
const os = require("os")
const path = require("path")
const {
  Analytics,
  ALLOWED_PROPERTIES,
  PROPERTY_KINDS
} = require("../src/main/services/analytics")
const {
  ERROR_CATEGORIES,
  ERROR_STAGES
} = require("../src/main/utils/error-taxonomy")
// required for real, which is the whole point: these two tables are what the
// sanitizer must not cost us, and a mocked engine would hand back an empty one
const {
  ERROR_METADATA,
  TERMINAL_ERRORS
} = require("../src/main/services/ytdlp-engine")
// the real store, because every other test in this file hands Analytics a fake
// one that returns a uuid a test wrote. this is the half that asks what
// happens when the file on disk does not
const { SettingsStore } = require("../src/main/services/settings-store")

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

/** one free-text capture, returning what the client received */
async function captureText(text) {
  const { analytics, sent } = await ready()
  analytics.capture("download_failed", { error_message: text })
  expect(sent).toHaveLength(1)
  return sent[0].properties.error_message
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
  /**
   * `open` is the half that matters for the pin below it: does this kind admit
   * a value that is correct for the kind and sensitive all the same? a closed
   * kind cannot, whatever property is pointed at it. an open one can, so which
   * properties may point at it becomes a decision rather than a detail.
   */
  const REVIEWED_KINDS = {
    bool: {
      open: false,
      why: "two values exist and neither can carry anything"
    },
    number: {
      open: true,
      why: "a finite non-negative number, never a coerced string - but an account id is one too"
    },
    platform: {
      open: false,
      why: "a closed set of site names; anything else is rewritten to 'unsupported'"
    },
    vocabulary: {
      open: false,
      why: "a finite set listed per property in analytics.js, so a new value is an edit that names it"
    },
    quality: {
      open: false,
      why: "digit-anchored heights and bitrates plus a listed set; no prose fits either"
    },
    version: {
      open: true,
      why: "digits and dots, letters only inside a prerelease - and a phone number written with dots is one"
    },
    bucket: {
      open: true,
      why: "a digit or a comparison and a short unit - which '52 kg' also is"
    },
    locale: {
      open: true,
      why: "a bcp-47 tag anchored on case and length, because the values are chromium's and grow with it - and a short name has that shape"
    },
    text: {
      open: true,
      why: "free prose, scrubbed and then refused if any shape still stands"
    }
  }

  it("declares no kind that has not been argued for", () => {
    const declared = [...new Set(Object.values(PROPERTY_KINDS))].sort()

    // both directions on purpose. an unreviewed kind is the leak; a reviewed
    // kind nobody uses any more is a stale claim about a boundary that moved
    expect(declared).toEqual(Object.keys(REVIEWED_KINDS).sort())
  })

  /**
   * which properties may use a kind that admits arbitrary values.
   *
   * pinning which kinds *exist* is not enough, and the gap it leaves is the
   * one that looks least like a mistake: somebody adds a property, reaches for
   * a kind that is already there, and the boundary widens without a single
   * line that reads as dangerous. `display_name: "locale"` passes the kind
   * census, because "locale" was argued for long before. it passes both
   * free-text pins, because it is not text. and no hostile value in the matrix
   * touches it, because "amy" is a perfectly legitimate locale and only
   * becomes a leak once the property it sits on is called display_name.
   *
   * no value check can see that. the value is right for the kind and sensitive
   * for the property; only the pairing is wrong, so the pairing is what gets
   * pinned. closed kinds are deliberately absent - a vocabulary property
   * cannot be added without listing its values in analytics.js, a platform
   * rewrites whatever it does not recognise, and neither can widen quietly.
   */
  const OPEN_KIND_PROPERTIES = {
    formats_count: "number",
    file_size_mb: "number",
    progress_at_failure: "number",
    progress_at_cancel: "number",

    previous_version: "version",
    engine_version: "version",
    from_version: "version",
    to_version: "version",
    app_version: "version",
    os_version: "version",

    duration_bucket: "bucket",
    elapsed_bucket: "bucket",
    speed_bucket: "bucket",
    load_ms_bucket: "bucket",

    locale: "locale",

    error_message: "text"
  }

  it("pins which properties may use a kind that admits arbitrary values", () => {
    const openKinds = new Set(
      Object.entries(REVIEWED_KINDS)
        .filter(([, kind]) => kind.open)
        .map(([name]) => name)
    )

    const using = Object.fromEntries(
      Object.entries(PROPERTY_KINDS).filter(([, kind]) => openKinds.has(kind))
    )

    expect(using).toEqual(OPEN_KIND_PROPERTIES)
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

  it("holds the platform and the architecture this actually runs on", async () => {
    // the vocabularies for `os` and `arch` are written out from node's
    // documented range, which is the kind of list that goes stale quietly.
    // asserting against the running process makes every machine that runs this
    // suite check one entry of it for real
    const { analytics, sent } = await ready()

    analytics.capture("app_launched")

    expect(sent[0].properties.os).toBe(process.platform)
    expect(sent[0].properties.arch).toBe(process.arch)
  })

  it("drops a super property that fails its kind, and keeps the event", async () => {
    // the amplification argument made concrete: one bad value here would ride
    // every event this app ever sends, so it goes through the same gate a
    // caller's does - and dropping it costs one dimension rather than the event
    jest.spyOn(os, "release").mockReturnValue("My Holiday Video")

    const { analytics, sent } = await ready()
    analytics.capture("app_launched")

    expect(sent[0].properties).not.toHaveProperty("os_version")
    expect(JSON.stringify(sent[0])).not.toContain("Holiday")

    // still attributable and still useful: distinctId is a field on the
    // message rather than a super property, so nothing about it moved, and
    // every other dimension is where it was
    expect(sent[0].distinctId).toBe("11111111-2222-3333-4444-555555555555")
    expect(sent[0].properties.app_version).toBeDefined()
    expect(sent[0].properties.os).toBe(process.platform)
  })

  it("keeps a linux kernel release rather than dropping os_version on linux", async () => {
    // validating os.release() as it comes would have dropped this property on
    // every linux install, silently and forever - the packaging tail is not a
    // version and no grammar admits it without admitting "1-holiday.mp4"
    const cases = [
      ["25.5.0", "25.5.0"],
      ["10.0.22631", "10.0.22631"],
      ["5.15.0-91-generic", "5.15.0"],
      ["6.6.9-200.fc39.x86_64", "6.6.9"],
      ["5.15.153.1-microsoft-standard-WSL2", "5.15.153.1"],
      ["4.18.0-513.9.1.el8_5.x86_64", "4.18.0"]
    ]

    for (const [release, expected] of cases) {
      jest.spyOn(os, "release").mockReturnValue(release)

      const { analytics, sent } = await ready()
      analytics.capture("app_launched")

      expect(sent[0].properties.os_version).toBe(expected)
    }

    // and a release that is not a release at all is dropped, not cut
    jest.spyOn(os, "release").mockReturnValue("/Users/someone/Movies")

    const { analytics, sent } = await ready()
    analytics.capture("app_launched")

    expect(sent[0].properties).not.toHaveProperty("os_version")
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

describe("the identity every event is filed under", () => {
  /**
   * distinctId is neither a super property nor an allowed one. it is a field
   * on the message, nothing in capture() looks at it, and it is the most
   * amplified value in the whole system: one stable identity carried by every
   * event this installation will ever send.
   *
   * and it comes out of a json file a person can open and edit. the store used
   * to return whatever was in there so long as it was a non-empty string, so a
   * name, an address or a hostname typed into that field became the identity
   * the install reported itself by. it is repaired now - treated as absent and
   * minted over, because the field has only ever held what randomUUID() put
   * there and so a value that is not one is corruption in a file we own.
   *
   * driven end to end here, through the real store into the real Analytics,
   * because the assertion worth having is about what leaves rather than about
   * what the store returns.
   */
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  let root
  let counter

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-pii-guard-"))
    counter = 0
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** what the client is handed when the settings file holds `stored` */
  async function messageFor(stored) {
    const settingsFile = path.join(root, `settings-${(counter += 1)}.json`)
    fs.writeFileSync(settingsFile, JSON.stringify({ install_id: stored }))

    const sent = []
    const analytics = new Analytics({
      settingsStore: new SettingsStore({
        settingsFile,
        defaultPath: path.join(root, "downloads")
      }),
      createClient: () => ({
        capture: (message) => sent.push(message),
        flush: async () => {}
      }),
      forceEnabled: true
    })

    await analytics.init()
    analytics.capture("app_launched", { is_first_launch: true })

    expect(sent).toHaveLength(1)
    return sent[0]
  }

  it("is a uuid whatever the settings file was holding", async () => {
    const corrupt = [
      "devansh@example.com",
      "Devansh's MacBook Pro",
      "/Users/devansh",
      "https://private.example/u/devansh",
      "user-1234"
    ]

    for (const stored of corrupt) {
      const message = await messageFor(stored)

      expect(message.distinctId).toMatch(UUID)
      expect(JSON.stringify(message)).not.toContain(stored)
    }
  })

  it("keeps an identity the store really minted", async () => {
    // the other direction, so the repair above cannot be a blanket reset that
    // gives everybody a new identity on every launch
    const stored = "11111111-2222-3333-4444-555555555555"
    const message = await messageFor(stored)

    expect(message.distinctId).toBe(stored)
  })
})

describe("locale, the one value chromium picks and we do not", () => {
  /**
   * every ui locale this electron build ships, read off
   * node_modules/electron/dist/Electron.app/Contents/Resources/*.lproj and
   * written in the hyphenated form app.getLocale() returns rather than the
   * underscored form the directories use.
   *
   * this is the evidence for the grammar rather than the grammar itself. a
   * vocabulary of these would go stale the first time an electron upgrade
   * added one, and would then drop the locale of everybody running it - which
   * is why the kind is anchored on shape. the list's job is to prove the shape
   * covers what really arrives.
   */
  const SHIPPED = [
    "af", "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en",
    "en-GB", "es", "es-419", "et", "fa", "fi", "fil", "fr", "gu", "he",
    "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt", "lv", "ml",
    "mr", "ms", "nb", "nl", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk",
    "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk", "ur", "vi",
    "zh-CN", "zh-TW",
    // returned rather than shipped: getLocale() resolves american english to
    // en-US even where the resource directory is named "en"
    "en-US",
    // and the two shapes chromium has that this build does not ship, which the
    // grammar has to hold or the next upgrade drops them
    "sr-Latn", "zh-Hans-CN"
  ]

  /** drive init() with the locale electron would have handed it */
  async function localeSentAs(locale) {
    jest.resetModules()
    jest.doMock("electron", () => ({ app: { getLocale: () => locale } }))

    try {
      const { Analytics: Fresh } = require("../src/main/services/analytics")
      const sent = []
      const analytics = new Fresh({
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
      analytics.capture("app_launched")

      return sent[0].properties.locale
    } finally {
      jest.dontMock("electron")
      jest.resetModules()
    }
  }

  it("keeps every locale this build can hand it", async () => {
    expect(SHIPPED.length).toBeGreaterThan(50)

    for (const locale of SHIPPED) {
      expect(await localeSentAs(locale)).toBe(locale)
    }
  })

  it("keeps the reserved value for a lookup that could not run", async () => {
    // electron is absent under jest, so this is what every other test in this
    // file is really sending - it has to be accepted or the property vanishes
    expect(await localeSentAs("unknown")).toBe("unknown")
  })

  it("drops the words a slug grammar would have taken", async () => {
    // the pair that defeated every general-purpose short-label grammar tried
    // before this one, plus the shapes a careless edit would put in this slot
    for (const value of [
      "holiday",
      "my-video",
      "My Holiday Video",
      "en-US/Movies",
      `${HOME}/Movies`,
      "https://private.example",
      "someone@example.com"
    ]) {
      expect(await localeSentAs(value)).toBeUndefined()
    }
  })

  it("cannot tell a short personal name from a language tag", async () => {
    // two or three lowercase letters is a language and also a name, and no
    // amount of tightening separates them - "amy" is exactly as well-formed a
    // tag as "ami" is a real one. harmless on `locale`, which is what this
    // grammar exists for, and a leak the moment a later task points a
    // `display_name` at the same kind. OPEN_KIND_PROPERTIES is what stops that
    for (const name of ["amy", "ana", "ali", "bob"]) {
      expect(await localeSentAs(name)).toBe(name)
    }
  })
})

describe("a credential, which is shapeless but not edgeless", () => {
  /**
   * an opaque token stands where a bare title stands: no separator, no dot, no
   * host. it is taken anyway, because the two are not the same case twice - a
   * credential carries a marker beside it that no wording of ours, node's or
   * yt-dlp's uses, and a leaked token is a different category of harm from a
   * leaked title. the block below this one measures what that costs.
   */
  it("takes the token and leaves the diagnosis", async () => {
    expect(await captureText("Authorization: Bearer abc123def456")).toBe(
      "[credential]"
    )
    expect(await captureText("Bearer abc123def456 was rejected")).toBe(
      "[credential] was rejected"
    )
    expect(await captureText("request failed with api_key=abc123def456")).toBe(
      "request failed with [credential]"
    )
    expect(await captureText("refresh_token: abc123def456 expired")).toBe(
      "[credential] expired"
    )
    expect(await captureText("cookie: SID=g.a000abcdEFGHijkl0123")).toBe(
      "[credential]"
    )
    expect(await captureText("password=hunter2 rejected")).toBe(
      "[credential] rejected"
    )
  })

  it("finds the name wherever in the key it sits", async () => {
    /**
     * this rule was wrong twice for one reason. `\b` missed `client_secret`,
     * because "_" is a word character. a prefix then missed
     * `aws_secret_access_key` - a standard aws field - because the marker was
     * in the middle. each fix moved the position the marker was assumed to
     * occupy instead of dropping the assumption that it occupies one.
     *
     * so the cases below are deliberately spread: leading, trailing, middle,
     * hyphenated, and two markers in one key. if any position is ever special
     * again, one of these is where it shows.
     */

    // the marker in the middle, which is what defeated the prefix
    expect(
      await captureText("AWS rejected aws_secret_access_key=abc123")
    ).toBe("AWS rejected [credential]")
    expect(await captureText("OAuth rejected client_secret_key=abc123")).toBe(
      "OAuth rejected [credential]"
    )
    expect(await captureText("cache says cookie_store=SID123")).toBe(
      "cache says [credential]"
    )

    // trailing components after the marker
    expect(await captureText("my_api_key_v2: abc123 rejected")).toBe(
      "[credential] rejected"
    )
    expect(await captureText("refresh_token_secret_holder=zzz refused")).toBe(
      "[credential] refused"
    )

    // and the leading-component cases the prefix already handled
    expect(await captureText("OAuth failed: client_secret=hunter2")).toBe(
      "OAuth failed: [credential]"
    )
    expect(await captureText("request rejected: signing_secret=abc123")).toBe(
      "request rejected: [credential]"
    )
    expect(
      await captureText("github_access_token=ghp_abcdef123456 was revoked")
    ).toBe("[credential] was revoked")
    expect(await captureText("x-api-key: abcdef123456 rejected")).toBe(
      "[credential] rejected"
    )
    expect(await captureText("app_session_id: abc123 expired")).toBe(
      "[credential] expired"
    )

    // the header name composes too, and hyphenated or not
    for (const text of [
      "Proxy-Authorization: Basic dXNlcjpwYXNz",
      "proxy_authorization: Basic dXNlcjpwYXNz"
    ]) {
      expect(await captureText(text)).toBe("[credential]")
    }
  })

  it("finds the key however the serializer spelled it", async () => {
    /**
     * a flat identifier is one spelling of a key and not the only one. a form
     * serializer writes brackets, a query encoder percent-escapes them, a json
     * dump quotes them, and an object dump quotes them the other way. none of
     * those is a new *position* for the marker - the position argument closed
     * with the previous fix - they are different notations for the same key,
     * and enumerating notations would be that same mistake in a new costume.
     *
     * so the key is a run of key characters and any arrangement of them counts.
     */
    const cases = [
      // bracket notation, which is ordinary nested form serialization
      ["nested credentials[secret]=hunter2", "nested [credential]"],
      ["form config[api_key]=abc123", "form [credential]"],
      ["creds[0][secret]=hunter2", "[credential]"],
      // the same thing after a query encoder has been at it
      ["config%5Bapi_key%5D=abc123", "[credential]"],
      // a json dump, quoted on both sides - and the value has to go with it,
      // since stopping at the opening quote would publish what follows
      ['{"secret": "hunter2"}', "{[credential]}"],
      // and an object dump, which quotes the other way
      ["{'secret': 'hunter2'}", "{[credential]}"],
      // a dotted key, which is neither bracketed nor quoted
      ["auth.client_secret=hunter2", "[credential]"]
    ]

    for (const [text, expected] of cases) {
      expect(await captureText(text)).toBe(expected)
    }
  })

  it("leaves the quotes it did not take in a state the span rule can read", async () => {
    // the key grammar consumes quotes now, so it has to consume them in pairs -
    // a stranded one would pair up with the next quote in the message and take
    // the safe text between them, or worse, fail to
    expect(
      await captureText('"My Holiday Video" failed with api_key=abc123')
    ).toBe("[text] failed with [credential]")

    expect(
      await captureText('token="abc123" and "My Holiday Video"')
    ).toBe("[credential] and [text]")

    // and the span rule's own job is untouched: node writes its file errors
    // this way and "open '[path]'" is worth more than "open [text]"
    expect(
      await captureText("ENOENT: no such file or directory, open '/tmp/x.mp4'")
    ).toBe("ENOENT: no such file or directory, open '[path]'")
  })

  it("does not fire on the words those markers are made of", async () => {
    // the cost side. a keyword only counts as a credential when something is
    // being assigned to it, so ordinary wording that happens to use the word
    // is untouched - and "basic" and "digest" are not matched as schemes at
    // all, because unlike "bearer" they are ordinary english
    for (const text of [
      "Unable to extract the player token",
      "the basic settings could not be read",
      "your cookie file has no entries",
      "a digest of the archive did not match",
      // cookie wording is the app's own bread and butter, and none of it is
      // an assignment, so none of it is touched
      "cookies expired, sign in again",
      "the cookie file is missing",
      "no cookies found for this site",
      "cookie file: could not be read",
      "cookie jar: empty"
    ]) {
      expect(await captureText(text)).toBe(text)
    }
  })

  /**
   * what matching the marker anywhere in the key costs, stated rather than
   * discovered later.
   *
   * a marker word directly assigned a value is taken even when the value is a
   * count rather than a secret, because "cookies" contains "cookie" and there
   * is no way to know from the key alone which one this is. narrowing it -
   * requiring the marker to be a separator-delimited component, so "cookies"
   * stops matching and "cookie_store" keeps doing so - is available and would
   * buy these back, but it reintroduces exactly the kind of structural
   * assumption that made this rule wrong twice, and `awssecretkey=x` would
   * walk straight through it.
   *
   * so the trade is deliberate: a diagnostic loses a number, in a direction
   * that fails closed. nothing this app actually writes is affected - the
   * whole engine wording table is asserted untouched two blocks down, and the
   * cookie wording above is the app's own.
   */
  it("takes a count as well as a secret, when the key is a marker", async () => {
    for (const text of [
      "cookies: 3",
      "cookie_count: 12",
      "cookies_found: 4",
      "tokens: 5",
      "passwords: 0"
    ]) {
      expect(await captureText(text)).toBe("[credential]")
    }

    // and it takes only the assignment, not the sentence around it
    expect(await captureText("usable cookies: 0 for this site")).toBe(
      "usable [credential] for this site"
    )
  })
})

describe("what the sanitizer may not cost us", () => {
  /**
   * every message and suggestion the app can put in front of a person, read
   * off the engine's two wording tables rather than sampled from them.
   *
   * a scrub rule is only ever added on the argument that it costs nothing, and
   * "nothing" was measured by hand until now - the previous version of this
   * assertion picked five entries out of thirty-three. derived, it holds the
   * next rule to the same standard on the day it is written, including the
   * credential rules above.
   */
  const WORDING = [
    ...new Set(
      [...Object.values(ERROR_METADATA), ...Object.values(TERMINAL_ERRORS)]
        .flatMap((entry) => [entry.message, entry.suggestion])
        .filter((text) => typeof text === "string" && text.length > 0)
    )
  ]

  it("leaves the engine's whole wording table exactly as it is", async () => {
    // a table that came back empty would make this pass having checked nothing
    expect(WORDING.length).toBeGreaterThan(20)

    for (const text of WORDING) {
      expect(await captureText(text)).toBe(text)
    }
  })
})

describe("what an open kind admits, which is what the pairing pin is for", () => {
  /**
   * the evidence behind OPEN_KIND_PROPERTIES, in the same spirit as the floor
   * block below: a limit is only weighable once somebody can see it.
   *
   * each of these is a sensitive value that is *correct* for the kind holding
   * it, and each is sent. that is not a defect to fix at the value level -
   * there is nothing about `1.234.567.8901` that distinguishes a phone number
   * from a version, and a rule that could tell them apart would have to know
   * which property it was looking at. which is the pin.
   *
   * so these assert what really happens rather than what we would like to. if
   * one of them ever stops being sent, the kind got narrower and both this and
   * the pin want re-reading.
   */
  async function sentOn(event, properties) {
    const { analytics, sent } = await ready()
    analytics.capture(event, properties)
    expect(sent).toHaveLength(1)
    return sent[0].properties
  }

  it("takes a phone number as a version, because it is one", async () => {
    const properties = await sentOn("engine_updated", {
      to_version: "1.234.567.8901"
    })

    expect(properties.to_version).toBe("1.234.567.8901")
  })

  it("takes an identifier as a number, because it is one", async () => {
    // a row id, an account number, a date of birth written as digits: all
    // finite, all non-negative, all under the ceiling
    const properties = await sentOn("download_completed", {
      file_size_mb: 19870514
    })

    expect(properties.file_size_mb).toBe(19870514)
  })

  it("takes a measurement of a person as a bucket, because it is one", async () => {
    const properties = await sentOn("download_completed", {
      elapsed_bucket: "52 kg"
    })

    expect(properties.elapsed_bucket).toBe("52 kg")
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
