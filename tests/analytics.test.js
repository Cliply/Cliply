// the default factory is private, so the geoip assertion goes through the
// constructor the app really uses
jest.mock("posthog-node", () => ({ PostHog: jest.fn() }))

const {
  Analytics,
  ALLOWED_PROPERTIES,
  PROPERTY_KINDS
} = require("../src/main/services/analytics")
const { APP_CONFIG } = require("../src/main/utils/constants")

// the module warns on every drop, which is the point of it - but it would
// bury the actual test output
beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

function fakeClient() {
  return {
    captured: [],
    capture(message) {
      this.captured.push(message)
    },
    flush: jest.fn().mockResolvedValue(undefined)
  }
}

function fakeStore(overrides = {}) {
  return {
    getInstallId: async () => "11111111-2222-3333-4444-555555555555",
    isAnalyticsEnabled: async () => true,
    setAnalyticsEnabled: jest.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe("Analytics", () => {
  it("attaches super properties to every event", async () => {
    const client = fakeClient()
    const analytics = new Analytics({
      settingsStore: fakeStore(),
      createClient: () => client,
      forceEnabled: true
    })
    await analytics.init()
    analytics.capture("app_launched", { is_first_launch: true })

    expect(client.captured).toHaveLength(1)
    const [message] = client.captured
    expect(message.distinctId).toBe("11111111-2222-3333-4444-555555555555")
    expect(message.event).toBe("app_launched")
    expect(message.properties.is_first_launch).toBe(true)
    expect(message.properties.app_version).toBeDefined()
    expect(message.properties.os).toBe(process.platform)
    expect(message.properties.arch).toBe(process.arch)
  })

  it("sends nothing when the user opted out", async () => {
    const client = fakeClient()
    const analytics = new Analytics({
      settingsStore: fakeStore({ isAnalyticsEnabled: async () => false }),
      createClient: () => client,
      forceEnabled: true
    })
    await analytics.init()
    analytics.capture("app_launched")

    expect(client.captured).toHaveLength(0)
    expect(analytics.isEnabled()).toBe(false)
  })

  it("does not construct a client in development", async () => {
    let created = false
    const analytics = new Analytics({
      settingsStore: fakeStore(),
      createClient: () => {
        created = true
        return fakeClient()
      },
      forceEnabled: false
    })
    await analytics.init()
    analytics.capture("app_launched")

    expect(created).toBe(false)
  })

  it("never throws when the client explodes", async () => {
    const analytics = new Analytics({
      settingsStore: fakeStore(),
      createClient: () => ({
        capture() {
          throw new Error("network down")
        },
        flush: jest.fn().mockResolvedValue(undefined)
      }),
      forceEnabled: true
    })
    await analytics.init()

    expect(() => analytics.capture("download_completed")).not.toThrow()
  })

  it("redacts error_message before it leaves", async () => {
    const client = fakeClient()
    const analytics = new Analytics({
      settingsStore: fakeStore(),
      createClient: () => client,
      forceEnabled: true
    })
    await analytics.init()
    analytics.capture("download_failed", {
      error_message: `ERROR: unable to open ${require("os").homedir()}/Movies/x.mp4`
    })

    expect(client.captured[0].properties.error_message).not.toContain(
      require("os").homedir()
    )
  })

  it("flush drains the queue", async () => {
    const client = fakeClient()
    const analytics = new Analytics({
      settingsStore: fakeStore(),
      createClient: () => client,
      forceEnabled: true
    })
    await analytics.init()
    await analytics.flush()

    expect(client.flush).toHaveBeenCalled()
  })

  describe("setEngineVersion", () => {
    it("stamps engine_version onto every later event", async () => {
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()
      analytics.setEngineVersion("2026.08.19")
      analytics.capture("download_completed")
      analytics.capture("download_failed")

      expect(client.captured).toHaveLength(2)
      for (const message of client.captured) {
        expect(message.properties.engine_version).toBe("2026.08.19")
      }
    })

    it("leaves an already-set version alone when handed a falsy one", async () => {
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()
      analytics.setEngineVersion("2026.08.19")

      // a probe that failed must not erase what a successful one established
      analytics.setEngineVersion(null)
      analytics.setEngineVersion("")
      analytics.setEngineVersion(undefined)
      analytics.capture("download_completed")

      expect(client.captured[0].properties.engine_version).toBe("2026.08.19")
    })

    it("survives the re-init that opting back in triggers", async () => {
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()
      analytics.setEngineVersion("2026.08.19")

      // setEnabled(true) rebuilds the super properties from scratch. the
      // engine version is probed once per run, so if the rebuild drops it
      // nothing sets it again for the rest of the session.
      await analytics.setEnabled(false)
      await analytics.setEnabled(true)
      analytics.capture("download_completed")

      expect(client.captured).toHaveLength(1)
      expect(client.captured[0].properties.engine_version).toBe("2026.08.19")
    })

    it("is carried over when it is known before init", async () => {
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      analytics.setEngineVersion("2026.08.19")
      await analytics.init()
      analytics.capture("download_completed")

      expect(client.captured[0].properties.engine_version).toBe("2026.08.19")
    })
  })

  describe("the property allowlist", () => {
    async function ready(client) {
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()
      return analytics
    }

    it("drops an unlisted property and keeps the listed ones", async () => {
      const client = fakeClient()
      const analytics = await ready(client)

      analytics.capture("download_completed", {
        platform: "youtube",
        media_type: "video",
        url: "https://youtube.com/watch?v=secret",
        video_title: "my private video",
        filename: "/Users/someone/Movies/x.mp4"
      })

      const { properties } = client.captured[0]
      expect(properties.platform).toBe("youtube")
      expect(properties.media_type).toBe("video")
      expect(properties).not.toHaveProperty("url")
      expect(properties).not.toHaveProperty("video_title")
      expect(properties).not.toHaveProperty("filename")
    })

    it("sends nothing at all for an event that is not on the list", async () => {
      const client = fakeClient()
      const analytics = await ready(client)

      analytics.capture("user_typed_a_password", { anything: "at all" })

      expect(client.captured).toHaveLength(0)
    })

    it("keeps the super properties it adds itself", async () => {
      const client = fakeClient()
      const analytics = await ready(client)

      analytics.capture("download_completed", { platform: "youtube" })

      const { properties } = client.captured[0]
      expect(properties.app_version).toBeDefined()
      expect(properties.os).toBe(process.platform)
      expect(properties.arch).toBe(process.arch)
      expect(properties.platform).toBe("youtube")
    })

    it("does not let a caller shadow a super property", async () => {
      const client = fakeClient()
      const analytics = await ready(client)

      // "os" is not listed for this event, but the collision is what matters:
      // the module's own value has to win either way
      analytics.capture("download_completed", {
        platform: "youtube",
        os: "spoofed",
        app_version: "9.9.9"
      })

      const { properties } = client.captured[0]
      expect(properties.os).toBe(process.platform)
      expect(properties.app_version).not.toBe("9.9.9")
    })

    it("still redacts an allowed free-text property", async () => {
      const client = fakeClient()
      const analytics = await ready(client)

      analytics.capture("download_failed", {
        platform: "youtube",
        error_message: `ERROR: unable to open ${require("os").homedir()}/Movies/x.mp4`
      })

      expect(client.captured[0].properties.error_message).not.toContain(
        require("os").homedir()
      )
    })

    it("covers every event the taxonomy defines", async () => {
      const client = fakeClient()
      const analytics = await ready(client)

      // a typo in an event name is otherwise invisible: the event simply
      // stops arriving, and nothing fails
      const expected = [
        "app_launched",
        "url_submitted",
        "media_info_loaded",
        "media_info_failed",
        "download_started",
        "download_completed",
        "download_failed",
        "download_cancelled",
        "engine_seeded",
        "engine_updated",
        "engine_update_failed",
        "cookies_imported"
      ]

      for (const event of expected) {
        analytics.capture(event)
      }

      expect(client.captured.map((message) => message.event)).toEqual(expected)
    })
  })

  describe("never throwing into a caller", () => {
    async function ready(overrides = {}) {
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        forceEnabled: true,
        createClient: () => ({
          capture() {},
          flush: jest.fn().mockResolvedValue(undefined),
          ...overrides
        })
      })
      await analytics.init()
      return analytics
    }

    it("survives a properties bag that explodes when enumerated", async () => {
      const analytics = await ready()
      const hostile = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("enumeration exploded")
          }
        }
      )

      expect(() =>
        analytics.capture("download_completed", hostile)
      ).not.toThrow()
    })

    it("survives an event name that cannot be printed", async () => {
      const analytics = await ready()

      // the catch path interpolates the event name to report the failure, so
      // an unprintable one used to throw a second time - out of telemetry
      expect(() => analytics.capture(Symbol("weird"))).not.toThrow()
      expect(() =>
        analytics.capture({
          toString() {
            throw new Error("not printable")
          }
        })
      ).not.toThrow()
    })

    it("survives an unprintable event and a hostile bag together", async () => {
      const analytics = await ready()
      const hostile = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("enumeration exploded")
          }
        }
      )

      // this is the pairing that bites: the bag throws, which lands in the
      // catch, and the catch then interpolates the event name to report it
      expect(() => analytics.capture(Symbol("weird"), hostile)).not.toThrow()
    })

    it("survives a client that throws a null", async () => {
      const analytics = await ready({
        capture() {
          throw null
        }
      })

      expect(() => analytics.capture("download_completed")).not.toThrow()
    })

    it("survives a client whose flush rejects", async () => {
      const analytics = await ready({
        flush: () => Promise.reject(new Error("network down"))
      })

      await expect(analytics.flush()).resolves.toBeUndefined()
    })

    it("survives a store that rejects during init", async () => {
      const analytics = new Analytics({
        settingsStore: fakeStore({
          isAnalyticsEnabled: async () => {
            throw new Error("settings unreadable")
          }
        }),
        createClient: () => fakeClient(),
        forceEnabled: true
      })

      await expect(analytics.init()).resolves.toBeUndefined()
      expect(analytics.isEnabled()).toBe(false)
      expect(() => analytics.capture("app_launched")).not.toThrow()
    })
  })

  describe("setEnabled", () => {
    it("reports a persistence failure instead of rejecting", async () => {
      const analytics = new Analytics({
        settingsStore: fakeStore({
          setAnalyticsEnabled: async () => {
            throw new Error("disk full")
          }
        }),
        createClient: () => fakeClient(),
        forceEnabled: true
      })
      await analytics.init()

      const result = await analytics.setEnabled(false)

      expect(result).toEqual({ success: false, error: "disk full" })
    })

    it("goes inert on opt-out even when the write fails", async () => {
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore({
          setAnalyticsEnabled: async () => {
            throw new Error("disk full")
          }
        }),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()

      // the preference may not have stuck, but the user's intent for this
      // session is honoured regardless
      await analytics.setEnabled(false)
      analytics.capture("download_completed", { platform: "youtube" })

      expect(analytics.isEnabled()).toBe(false)
      expect(client.captured).toHaveLength(0)
    })
  })

  describe("the client the app actually ships", () => {
    it("never constructs one when the user has opted out", async () => {
      let created = 0
      const analytics = new Analytics({
        settingsStore: fakeStore({ isAnalyticsEnabled: async () => false }),
        createClient: () => {
          created += 1
          return fakeClient()
        },
        forceEnabled: true
      })
      await analytics.init()

      expect(created).toBe(0)
    })

    it("sets disableGeoip false on the client it builds for itself", async () => {
      const { PostHog } = require("posthog-node")
      PostHog.mockClear()

      // no createClient injected: this exercises the factory the app really
      // uses, which is the only version of this assertion worth having
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        forceEnabled: true
      })
      await analytics.init()

      expect(PostHog).toHaveBeenCalledTimes(1)
      const [key, options] = PostHog.mock.calls[0]
      expect(key).toBe(APP_CONFIG.ANALYTICS_CONFIG.POSTHOG_KEY)
      expect(options.host).toBe(APP_CONFIG.ANALYTICS_CONFIG.POSTHOG_HOST)
      expect(options.disableGeoip).toBe(false)
    })

    it("would lose geoip if that option were dropped", () => {
      // the companion half: posthog's jsdoc claims disableGeoip defaults to
      // false, and the compiled source reads `options.disableGeoip ?? true`.
      // this is what makes deleting the line as "redundant" fail loudly
      // rather than silently dropping country/region/city.
      const { PostHog: RealPostHog } = jest.requireActual("posthog-node")
      const bare = new RealPostHog("phc_test", {
        host: "https://us.i.posthog.com"
      })

      expect(bare.disableGeoip).toBe(true)
    })
  })

  describe("property values", () => {
    async function captureOne(event, properties) {
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()
      analytics.capture(event, properties)
      return client.captured[0] ? client.captured[0].properties : null
    }

    it("gives every allowed property a kind", () => {
      // an allowed but unkinded property would sail through unvalidated.
      // this is the test that stops tasks 5-7 adding one.
      const unkinded = []

      for (const [event, keys] of Object.entries(ALLOWED_PROPERTIES)) {
        for (const key of keys) {
          if (!PROPERTY_KINDS[key]) unkinded.push(`${event}.${key}`)
        }
      }

      expect(unkinded).toEqual([])
    })

    describe("token", () => {
      it("keeps the bucket labels tasks 5-6 will produce", async () => {
        for (const value of [
          "1-5 min",
          "<1m",
          ">10m",
          "~5m",
          "10-50 MB",
          "1080p",
          "youtube",
          "NETWORK_ERROR",
          "fetch_info",
          "2026.08.19",
          "0.3.3"
        ]) {
          const properties = await captureOne("download_completed", {
            quality: value
          })
          expect(properties.quality).toBe(value)
        }
      })

      it("rejects anything that looks like a location or an identity", async () => {
        for (const value of [
          "https://private.example/video",
          "C:\\Users\\someone\\Movies",
          "/Users/someone/Movies/x.mp4",
          "someone@example.com",
          "café",
          "a".repeat(65),
          ""
        ]) {
          const properties = await captureOne("download_completed", {
            platform: value
          })
          expect(properties).not.toHaveProperty("platform")
        }
      })
    })

    describe("bool", () => {
      it("keeps a real boolean", async () => {
        const properties = await captureOne("app_launched", {
          is_first_launch: false
        })
        expect(properties.is_first_launch).toBe(false)
      })

      it("rejects a stringy or numeric stand-in", async () => {
        for (const value of ["true", 1, 0, null]) {
          const properties = await captureOne("app_launched", {
            is_first_launch: value
          })
          expect(properties).not.toHaveProperty("is_first_launch")
        }
      })
    })

    describe("number", () => {
      it("keeps a finite count, including zero", async () => {
        for (const value of [0, 42, 1e9]) {
          const properties = await captureOne("download_completed", {
            file_size_mb: value
          })
          expect(properties.file_size_mb).toBe(value)
        }
      })

      it("rejects NaN, infinities, negatives, overflow and numeric strings", async () => {
        for (const value of [NaN, Infinity, -Infinity, -1, 1e9 + 1, "5"]) {
          const properties = await captureOne("download_completed", {
            file_size_mb: value
          })
          expect(properties).not.toHaveProperty("file_size_mb")
        }
      })
    })

    describe("text", () => {
      it("redacts and then truncates", async () => {
        const home = require("os").homedir()
        const properties = await captureOne("download_failed", {
          error_message: `ERROR at ${home}/Movies/x.mp4 ` + "y".repeat(1000)
        })

        expect(properties.error_message).not.toContain(home)
        expect(properties.error_message.length).toBe(500)
      })

      it("rejects a non-string", async () => {
        const properties = await captureOne("download_failed", {
          error_message: { message: "an object" }
        })
        expect(properties).not.toHaveProperty("error_message")
      })
    })

    describe("absence", () => {
      async function captureQuietly(event, properties) {
        const client = fakeClient()
        const analytics = new Analytics({
          settingsStore: fakeStore(),
          createClient: () => client,
          forceEnabled: true
        })
        await analytics.init()
        console.warn.mockClear()
        analytics.capture(event, properties)
        return client.captured[0].properties
      }

      it("drops a null without a word", async () => {
        // first launch has no previous version. that is a legitimate state,
        // and a warning on every clean install would train people to stop
        // reading the channel that catches real privacy drops.
        const properties = await captureQuietly("app_launched", {
          is_first_launch: true,
          previous_version: null
        })

        expect(properties).not.toHaveProperty("previous_version")
        expect(properties.is_first_launch).toBe(true)
        expect(console.warn).not.toHaveBeenCalled()
      })

      it("drops an undefined without a word", async () => {
        const properties = await captureQuietly("download_failed", {
          platform: "youtube",
          progress_at_failure: undefined
        })

        expect(properties).not.toHaveProperty("progress_at_failure")
        expect(properties.platform).toBe("youtube")
        expect(console.warn).not.toHaveBeenCalled()
      })

      it("still keeps false and zero", async () => {
        // a truthiness check instead of a null check would eat both of these,
        // which is the whole reason this test sits next to the two above
        const flags = await captureQuietly("cookies_imported", {
          success: false,
          has_youtube_cookies: false
        })
        expect(flags.success).toBe(false)
        expect(flags.has_youtube_cookies).toBe(false)

        const counts = await captureQuietly("download_cancelled", {
          progress_at_cancel: 0
        })
        expect(counts.progress_at_cancel).toBe(0)

        expect(console.warn).not.toHaveBeenCalled()
      })

      it("still shouts about a wrong kind", async () => {
        const properties = await captureQuietly("download_completed", {
          platform: "https://private.example/v"
        })

        expect(properties).not.toHaveProperty("platform")
        expect(console.warn).toHaveBeenCalled()
      })
    })

    it("never writes the rejected value into the warning", async () => {
      const secret = "https://private.example/watch?v=abcdef"
      await captureOne("download_completed", { platform: secret })

      // the value is the suspected pii - logging it to report the drop would
      // write the leak into a log file the user might send us
      const logged = console.warn.mock.calls.flat().join(" ")
      expect(logged).toContain("platform")
      expect(logged).not.toContain(secret)
      expect(logged).not.toContain("private.example")
    })

    it("does not throw on a value that explodes when read", async () => {
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()

      const hostile = {}
      Object.defineProperty(hostile, "platform", {
        enumerable: true,
        get() {
          throw new Error("getter exploded")
        }
      })

      expect(() =>
        analytics.capture("download_completed", hostile)
      ).not.toThrow()
    })

    it("checks the event, then the key, then the kind", async () => {
      // an unlisted key on an unknown event must report the event, not the
      // key - the layers have to resolve in that order
      await captureOne("not_an_event", { platform: 42 })
      let logged = console.warn.mock.calls.flat().join(" ")
      expect(logged).toContain("not_an_event")
      expect(logged).not.toContain("platform")

      console.warn.mockClear()
      await captureOne("download_completed", { not_a_key: 42 })
      logged = console.warn.mock.calls.flat().join(" ")
      expect(logged).toContain("not_a_key")

      console.warn.mockClear()
      await captureOne("download_completed", { platform: 42 })
      logged = console.warn.mock.calls.flat().join(" ")
      expect(logged).toContain("platform")
      expect(logged).toContain("token")
    })
  })
})
