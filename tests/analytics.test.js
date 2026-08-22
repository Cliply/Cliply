const {
  Analytics,
  defaultCreateClient
} = require("../src/main/services/analytics")

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

    it("sets disableGeoip to false on the real client", () => {
      const client = defaultCreateClient("phc_test", "https://us.i.posthog.com")

      // pinned against the real sdk, not against our call site. posthog's own
      // jsdoc claims this defaults to false; the compiled source reads
      // `options.disableGeoip ?? true`. the second assertion is what makes
      // deleting the line as "redundant" fail loudly instead of silently
      // dropping country/region/city.
      expect(client.disableGeoip).toBe(false)

      const { PostHog } = require("posthog-node")
      const withoutTheOption = new PostHog("phc_test", {
        host: "https://us.i.posthog.com"
      })
      expect(withoutTheOption.disableGeoip).toBe(true)
    })
  })
})
