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

    it("stops sending before the preference write, not after it", async () => {
      // the drain was only half of it: a settings write that hangs is just as
      // able to keep the service alive past the click. an opt-out takes effect
      // synchronously, before this method awaits anything at all.
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore({
          setAnalyticsEnabled: () => new Promise(() => {})
        }),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()

      // deliberately not awaited - the write never settles, which is the point
      analytics.setEnabled(false)

      expect(analytics.isEnabled()).toBe(false)
      analytics.capture("download_completed", { platform: "youtube" })
      expect(client.captured).toHaveLength(0)
    })

    /**
     * a store that cannot be written but reads as enabled
     *
     * the shape of an unwritable or unreadable settings file: the read fails
     * open, because a file we cannot parse is not an opt-out, while nothing can
     * be persisted. it matters because it is the one case where init()'s own
     * re-read of the preference does NOT quietly cover for setEnabled getting
     * the decision wrong - the read agrees with the caller, and only the write
     * knows better.
     *
     * @param {Function} setAnalyticsEnabled - the failing write
     * @returns {Object} a settings store stub
     */
    function unwritableStore(setAnalyticsEnabled) {
      return fakeStore({ isAnalyticsEnabled: async () => true, setAnalyticsEnabled })
    }

    it("does not enable itself when the write threw", async () => {
      // the menu reverts the tick to off when the write fails. a service that
      // enabled itself anyway would be sending behind a switch the user can
      // see is off, which is the worst split there is between ui and behaviour.
      //
      // no init() first: that is the state a previous opt-out leaves behind -
      // init() returned early, so there is no client to reuse.
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: unwritableStore(async () => {
          throw new Error("disk full")
        }),
        createClient: () => client,
        forceEnabled: true
      })

      const result = await analytics.setEnabled(true)

      expect(result).toEqual({ success: false, error: "disk full" })
      expect(analytics.isEnabled()).toBe(false)
      analytics.capture("download_completed", { platform: "youtube" })
      expect(client.captured).toHaveLength(0)
    })

    it("does not enable itself when the store says the write did not stick", async () => {
      // the live path: the store catches its own failures and reports them,
      // so this is the shape a real disk error arrives in - not the throw
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: unwritableStore(async () => ({
          success: false,
          error: "EACCES"
        })),
        createClient: () => client,
        forceEnabled: true
      })

      await analytics.setEnabled(true)

      expect(analytics.isEnabled()).toBe(false)
      analytics.capture("download_completed", { platform: "youtube" })
      expect(client.captured).toHaveLength(0)
    })

    it("enables itself once the write has stuck", async () => {
      // gated on the same predicate the menu uses to decide whether to revert,
      // so the service's state and the tick cannot disagree
      const client = fakeClient()
      const analytics = new Analytics({
        settingsStore: fakeStore({
          isAnalyticsEnabled: async () => true,
          setAnalyticsEnabled: async () => ({ success: true })
        }),
        createClient: () => client,
        forceEnabled: true
      })

      await analytics.setEnabled(true)
      analytics.capture("download_completed", { platform: "youtube" })

      expect(analytics.isEnabled()).toBe(true)
      expect(client.captured).toHaveLength(1)
    })

    it("returns without waiting on the drain at all", async () => {
      // a menu click must never wait on telemetry, least of all the telemetry
      // it just asked to stop. the drain still runs - those events were
      // captured under consent - but in the background, where a network that
      // has stopped answering costs the user nothing.
      const client = fakeClient()
      client.flush = jest.fn(() => new Promise(() => {}))

      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()

      // a macrotask sentinel: setEnabled's own awaits are microtasks, so a
      // version that waited on the drain - or on a cap around it - is still
      // pending when this resolves, and "pending" wins the race
      const sentinel = new Promise((resolve) => setImmediate(resolve))
      const opting = analytics.setEnabled(false)

      await expect(
        Promise.race([
          opting.then(() => "returned"),
          sentinel.then(() => "pending")
        ])
      ).resolves.toBe("returned")

      // and it is inert, with the drain it started still hanging
      expect(client.flush).toHaveBeenCalledTimes(1)
      expect(analytics.isEnabled()).toBe(false)

      analytics.capture("download_completed", { platform: "youtube" })
      expect(client.captured).toHaveLength(0)
    })

    it("retires the detached client rather than only flushing it", async () => {
      // flush() leaves the sdk's flushInterval timer armed, so a
      // flushed-and-forgotten client keeps waking for the life of the process.
      // shutdown() clears it, drains the queue, and bounds itself with the
      // timeout it is handed - which is the whole cap, now that nobody waits.
      const client = fakeClient()
      client.shutdown = jest.fn().mockResolvedValue(undefined)

      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()

      await analytics.setEnabled(false)
      await new Promise((resolve) => setImmediate(resolve))

      expect(client.shutdown).toHaveBeenCalledWith(2000)
      expect(client.flush).not.toHaveBeenCalled()
    })

    it("keeps its never-throws promise when the drain rejects", async () => {
      // nothing observes the drain now, so a rejection there would surface as
      // an unhandled rejection rather than as a return value
      const client = fakeClient()
      client.shutdown = jest.fn().mockRejectedValue(new Error("no route"))

      const analytics = new Analytics({
        settingsStore: fakeStore(),
        createClient: () => client,
        forceEnabled: true
      })
      await analytics.init()

      const unhandled = jest.fn()
      process.on("unhandledRejection", unhandled)

      try {
        await expect(analytics.setEnabled(false)).resolves.toBeUndefined()
        await new Promise((resolve) => setImmediate(resolve))
        await new Promise((resolve) => setImmediate(resolve))

        expect(unhandled).not.toHaveBeenCalled()
        expect(analytics.isEnabled()).toBe(false)
      } finally {
        process.off("unhandledRejection", unhandled)
      }
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

    it("sets disableGeoip and isServer false on the client it builds for itself", async () => {
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
      expect(options.isServer).toBe(false)
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

    /**
     * the same companion for isServer, and it is asserted on behaviour rather
     * than on the stored option because that is where the surprise lives:
     * `isServer ?? true` means the *absence* of the option adds a property.
     *
     * this is the disableGeoip trap one option over. the difference is which
     * direction it fails in - dropping disableGeoip silently loses data we
     * want, while dropping this one silently adds a property we never declared
     * and labels every event in the project as server-side.
     */
    it("would attach $is_server to every event if that option were dropped", () => {
      const { PostHog: RealPostHog } = jest.requireActual("posthog-node")
      const options = { host: "https://us.i.posthog.com" }

      const bare = new RealPostHog("phc_test", options)
      const ours = new RealPostHog("phc_test", { ...options, isServer: false })

      expect(bare.getCommonEventProperties().$is_server).toBe(true)

      // omitted, not sent as false - so with the option set there is no
      // $is_server on the wire at all, which is what PRIVACY.md's list of
      // what posthog adds depends on
      expect(ours.getCommonEventProperties()).not.toHaveProperty("$is_server")
    })

    /**
     * and the whole of what the sdk attaches, so PRIVACY.md's "that's the whole
     * list of what we send, and here is what posthog adds" is derived from the
     * client rather than from whatever we happened to notice.
     *
     * a version bump that starts attaching a fourth property fails here, which
     * is the only way that document stays true without somebody re-reading
     * node_modules every release.
     */
    it("attaches exactly the properties PRIVACY.md says posthog adds", () => {
      const { PostHog: RealPostHog } = jest.requireActual("posthog-node")
      const client = new RealPostHog("phc_test", {
        host: "https://us.i.posthog.com",
        disableGeoip: false,
        isServer: false
      })

      // $geoip_disable is the fourth candidate and is deliberately absent:
      // prepareMessage only adds it when disableGeoip is truthy, and ours is
      // false precisely so posthog does resolve the location
      expect(Object.keys(client.getCommonEventProperties()).sort()).toEqual([
        "$lib",
        "$lib_version"
      ])
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
          if (!Object.hasOwn(PROPERTY_KINDS, key)) {
            unkinded.push(`${event}.${key}`)
          }
        }
      }

      expect(unkinded).toEqual([])
    })

    it("does not count an inherited name as a declared kind", () => {
      // a bracket lookup would find Object.prototype.toString and read it as
      // a declared kind, so the walk above has to ask hasOwn
      expect(PROPERTY_KINDS.toString).toBeDefined()
      expect(Object.hasOwn(PROPERTY_KINDS, "toString")).toBe(false)
    })

    describe("the values that defeated the token charset", () => {
      it("does not ship a video title in platform", async () => {
        // "My Holiday Video" matched the old token grammar and shipped.
        // platform normalizes now rather than dropping, so the assertion is
        // that the title is gone - not that the property is
        const properties = await captureOne("download_completed", {
          platform: "My Holiday Video",
          media_type: "video"
        })

        expect(properties.platform).toBe("unsupported")
        expect(properties.media_type).toBe("video")
      })

      it("drops a bare filename in quality", async () => {
        // "vacation.mp4" matched too - dots were admitted for version strings
        const properties = await captureOne("download_completed", {
          quality: "vacation.mp4",
          media_type: "video"
        })

        expect(properties).not.toHaveProperty("quality")
        expect(properties.media_type).toBe("video")
      })

      it("drops them from every kind that takes a string", async () => {
        for (const value of ["My Holiday Video", "vacation.mp4"]) {
          const slug = await captureOne("download_completed", {
            quality: value
          })
          expect(slug).not.toHaveProperty("quality")

          // platform is the exception: it normalizes, so the check is that
          // the value did not survive rather than that the key did not
          const platform = await captureOne("url_submitted", {
            platform: value
          })
          expect(platform.platform).toBe("unsupported")

          const version = await captureOne("engine_updated", {
            to_version: value
          })
          expect(version).not.toHaveProperty("to_version")

          const bucket = await captureOne("download_completed", {
            elapsed_bucket: value
          })
          expect(bucket).not.toHaveProperty("elapsed_bucket")
        }
      })
    })

    describe("the values that defeated the four grammars", () => {
      it("does not ship a one-word title as a platform", async () => {
        // "holiday" passed SLUG_PATTERN - a plausible one-word title
        const properties = await captureOne("url_submitted", {
          platform: "holiday"
        })
        expect(properties.platform).toBe("unsupported")
      })

      it("does not ship a slugified basename as a platform", async () => {
        // "my_video" passed too, for the same reason
        const properties = await captureOne("url_submitted", {
          platform: "my_video"
        })
        expect(properties.platform).toBe("unsupported")
      })

      it("does not ship a digit-leading filename as a version", async () => {
        // "2024.mp4" passed VERSION_PATTERN: it starts with a digit
        const properties = await captureOne("engine_updated", {
          to_version: "2024.mp4"
        })
        expect(properties).not.toHaveProperty("to_version")
      })

      it("does not ship a bare year as a bucket", async () => {
        // "2024" passed BUCKET_PATTERN because the unit was optional
        const properties = await captureOne("download_completed", {
          elapsed_bucket: "2024"
        })
        expect(properties).not.toHaveProperty("elapsed_bucket")
      })
    })

    describe("the values that defeated the grammars, round 7", () => {
      it("does not ship a one-word title as a quality", async () => {
        // "holiday" passed SLUG_PATTERN, and was equally reachable through
        // url_kind, media_type, audio_format, reason and update_reason.
        // no character grammar can exclude it - which is why slug is gone
        const properties = await captureOne("download_completed", {
          quality: "holiday"
        })
        expect(properties).not.toHaveProperty("quality")
      })

      it("does not ship a filename hidden in a prerelease tail", async () => {
        // "1-holiday.mp4": "1" satisfied the numeric head and "holiday.mp4"
        // satisfied a prerelease tail that admitted dots
        const properties = await captureOne("engine_updated", {
          to_version: "1-holiday.mp4"
        })
        expect(properties).not.toHaveProperty("to_version")
      })

      it("has no slug kind left to reach", () => {
        // the convergence test. every string property is now a vocabulary, a
        // numerically anchored grammar, or redacted text - so there is no
        // kind left that an arbitrary word can satisfy
        expect(Object.values(PROPERTY_KINDS)).not.toContain("slug")
      })
    })

    describe("vocabularies", () => {
      it("keeps the two media types the taxonomy answers with", async () => {
        for (const value of ["video", "audio"]) {
          const properties = await captureOne("download_started", {
            media_type: value
          })
          expect(properties.media_type).toBe(value)
        }
      })

      it("rejects the engine's own word for a merged download", async () => {
        // the runner says "combined" - an ffmpeg detail meaning two streams
        // were merged. analytics answers whether people take video or audio,
        // so task 6 normalizes it and this vocabulary refuses the raw term
        const properties = await captureOne("download_started", {
          media_type: "combined"
        })
        expect(properties).not.toHaveProperty("media_type")
      })

      it("keeps every audio format normalizeAudioMode can return", async () => {
        for (const value of ["mp3", "m4a", "original"]) {
          const properties = await captureOne("download_started", {
            audio_format: value
          })
          expect(properties.audio_format).toBe(value)
        }
      })

      it("keeps every reason the updater can report", async () => {
        for (const value of [
          "asset-layout-unexpected", "busy", "cancelled", "check-failed",
          "checksum-mismatch", "checksum-missing", "completed", "copy-failed",
          "corrupt-and-no-bundle", "engine-dir-failed", "no-binary-available",
          "probe-failed", "repaired", "swap-failed", "swap-stranded",
          "unsupported-platform", "up-to-date", "version-mismatch",
          "missing", "corrupt", "bundled-newer",
          // written as a ternary arm rather than a `reason:` literal
          // (ytdlp-updater.js:567), so a grep for the keyword walks past it
          "download-failed"
        ]) {
          const properties = await captureOne("engine_seeded", { reason: value })
          expect(properties.reason).toBe(value)
        }
      })

      it("keeps every reason an engine update can fail for", async () => {
        // what checkForUpdate() returns, minus "up-to-date" and "completed":
        // those two mean the engine is current, and index.js sends no failure
        // event for them at all
        for (const value of [
          "asset-layout-unexpected", "busy", "cancelled", "check-failed",
          "checksum-mismatch", "checksum-missing", "download-failed",
          "no-binary-available", "probe-failed", "repaired", "swap-failed",
          "swap-stranded", "unsupported-platform", "version-mismatch",
          // the one value the updater does not produce: index.js's word for a
          // check that rejected instead of reporting
          "check-rejected"
        ]) {
          const properties = await captureOne("engine_update_failed", {
            update_reason: value
          })
          expect(properties.update_reason).toBe(value)
        }
      })

      it("rejects a word that is merely well-formed", async () => {
        for (const [event, key] of [
          ["download_started", "media_type"],
          ["download_started", "audio_format"],
          ["engine_seeded", "reason"],
          ["engine_update_failed", "update_reason"]
        ]) {
          const properties = await captureOne(event, { [key]: "holiday" })
          expect(properties).not.toHaveProperty(key)
        }
      })

      it("keeps every link shape the renderer can name", async () => {
        // this vocabulary shipped empty on purpose - the values did not exist
        // until the renderer invented them, and an empty set fails loudly here
        // rather than dropping silently in production. these are urlKind()'s
        // whole range (renderer's lib/analytics.ts), and the renderer suite is
        // what proves the list is still that
        for (const value of [
          "video",
          "shorts",
          "playlist",
          "short-link",
          "embed"
        ]) {
          const properties = await captureOne("url_submitted", {
            url_kind: value
          })
          expect(properties.url_kind).toBe(value)
        }
      })

      it("rejects a link shape nobody declared", async () => {
        const properties = await captureOne("url_submitted", {
          url_kind: "playlist-link"
        })
        expect(properties).not.toHaveProperty("url_kind")
      })
    })

    describe("platform normalizes rather than drops", () => {
      it("keeps every platform the app actually supports", async () => {
        const {
          SUPPORTED_PLATFORMS
        } = require("../src/main/utils/constants")

        const supported = [
          ...Object.keys(SUPPORTED_PLATFORMS).map((k) => k.toLowerCase()),
          // ipc-handlers.js:43 - the engine's own download list, which is not
          // the same set. pinterest lives only here
          "youtube",
          "pinterest",
          "tiktok"
        ]

        for (const value of [...new Set(supported)]) {
          const properties = await captureOne("url_submitted", {
            platform: value
          })
          expect(properties.platform).toBe(value)
        }
      })

      it("keeps the reserved values", async () => {
        for (const value of ["unknown", "unsupported"]) {
          const properties = await captureOne("url_submitted", {
            platform: value
          })
          expect(properties.platform).toBe(value)
        }
      })

      it("still sends the event when it normalizes", async () => {
        // the whole point: which unsupported sites people try is data we want,
        // so an unrecognised platform must not take the event down with it
        const client = fakeClient()
        const analytics = new Analytics({
          settingsStore: fakeStore(),
          createClient: () => client,
          forceEnabled: true
        })
        await analytics.init()
        analytics.capture("url_submitted", { platform: "vimeo" })

        expect(client.captured).toHaveLength(1)
        expect(client.captured[0].properties.platform).toBe("unsupported")
        // and the super properties still ride along, so the event is usable
        expect(client.captured[0].properties.app_version).toBeDefined()
      })

      it("normalizes a url instead of shipping it", async () => {
        const secret = "https://private.example/watch?v=abcdef"
        const properties = await captureOne("url_submitted", {
          platform: secret
        })

        expect(properties.platform).toBe("unsupported")

        const logged = console.warn.mock.calls.flat().join(" ")
        expect(logged).not.toContain(secret)
        expect(logged).not.toContain("private.example")
      })

      it("drops a non-string rather than normalizing it", async () => {
        // a wrong type is a caller bug, not an unrecognised site
        for (const value of [42, true, { name: "youtube" }]) {
          const properties = await captureOne("url_submitted", {
            platform: value
          })
          expect(properties).not.toHaveProperty("platform")
        }
      })
    })

    describe("quality — grammar for what grows, vocabulary for what does not", () => {
      it("keeps heights the format list has not offered yet", async () => {
        // task 6 sends whatever the real format list offers, so heights are
        // open-ended - but numerically anchored, which is what lets a grammar
        // cover exactly the part that grows
        for (const value of ["1440p", "2160p", "4320p", "90p"]) {
          const properties = await captureOne("download_completed", {
            quality: value
          })
          expect(properties.quality).toBe(value)
        }
      })

      it("keeps arbitrary bitrates", async () => {
        for (const value of ["1kbps", "96kbps", "1411kbps"]) {
          const properties = await captureOne("download_completed", {
            quality: value
          })
          expect(properties.quality).toBe(value)
        }
      })

      it("rejects a word that is neither a height nor a bitrate", async () => {
        for (const value of ["holiday", "p", "kbps", "1080", "1080px", "abcp"]) {
          const properties = await captureOne("download_completed", {
            quality: value
          })
          expect(properties).not.toHaveProperty("quality")
        }
      })

      it("keeps every quality extractQuality can produce", async () => {
        const { extractQuality } = require("../src/main/utils/analytics-helpers")
        const produced = [
          ...new Set(
            [
              "1080p", "720p", "480p", "360p", "240p", "144p", "mp3", "m4a",
              "original", "pinterest", "tiktok", "137", "22", "140", "251",
              "bestaudio", "bestaudio[abr<=70]", "worstaudio", "[quality<=low]",
              // reaches the bare "audio" fallback, which no other input does
              "someaudiothing",
              "garbage", ""
            ].map(extractQuality)
          )
        ]

        for (const value of produced) {
          const properties = await captureOne("download_completed", {
            quality: value
          })
          expect(properties.quality).toBe(value)
        }
      })

      it("keeps the platform and reason vocabularies", async () => {
        for (const value of ["youtube", "pinterest", "tiktok", "unknown"]) {
          const properties = await captureOne("url_submitted", {
            platform: value
          })
          expect(properties.platform).toBe(value)
        }

        for (const value of [
          "up-to-date",
          "version-mismatch",
          "swap-failed",
          "asset-layout-unexpected",
          "corrupt-and-no-bundle"
        ]) {
          const properties = await captureOne("engine_seeded", { reason: value })
          expect(properties.reason).toBe(value)
        }
      })

      it("rejects uppercase, spaces, dots and a leading dash", async () => {
        // checked on quality, a pure slug - platform normalizes instead of
        // dropping and has its own block below
        for (const value of [
          "MP3",
          "my video",
          "clip.mp4",
          "-leading",
          "_leading",
          "a".repeat(33)
        ]) {
          const properties = await captureOne("download_completed", {
            quality: value
          })
          expect(properties).not.toHaveProperty("quality")
        }
      })
    })

    describe("version", () => {
      it("keeps real app and engine versions", async () => {
        for (const value of [
          "0.3.2",
          "0.3.3",
          "2026.08.19",
          "1.2.3-beta.1",
          "10.0.0-rc.1"
        ]) {
          const properties = await captureOne("engine_updated", {
            to_version: value
          })
          expect(properties.to_version).toBe(value)
        }
      })

      it("keeps a yt-dlp nightly, which carries a timestamp segment", async () => {
        for (const value of ["2025.01.12.232805", "2023.12.30", "2024.04.09"]) {
          const properties = await captureOne("engine_updated", {
            to_version: value
          })
          expect(properties.to_version).toBe(value)
        }
      })

      it("rejects anything carrying letters outside a prerelease", async () => {
        for (const value of [
          "vacation.mp4",
          "2024.mp4",
          "2024.mp4.exe",
          "v1.2.3",
          "unknown",
          "beta",
          "holiday2024",
          "1.2.3 beta"
        ]) {
          const properties = await captureOne("engine_updated", {
            to_version: value
          })
          expect(properties).not.toHaveProperty("to_version")
        }
      })
    })

    describe("setEngineVersion", () => {
      it("validates before stamping it on every event", async () => {
        // this is the one caller-supplied value that reaches superProperties,
        // which capture() spreads last - so an unchecked one would ride every
        // event and outrank a validated caller value
        const client = fakeClient()
        const analytics = new Analytics({
          settingsStore: fakeStore(),
          createClient: () => client,
          forceEnabled: true
        })
        await analytics.init()

        analytics.setEngineVersion("/Users/someone/Movies/x.mp4")
        analytics.capture("download_completed", { media_type: "video" })

        expect(client.captured[0].properties).not.toHaveProperty(
          "engine_version"
        )
      })

      it("still accepts a real engine version", async () => {
        const client = fakeClient()
        const analytics = new Analytics({
          settingsStore: fakeStore(),
          createClient: () => client,
          forceEnabled: true
        })
        await analytics.init()

        analytics.setEngineVersion("2026.08.19")
        analytics.capture("download_completed", { media_type: "video" })

        expect(client.captured[0].properties.engine_version).toBe("2026.08.19")
      })
    })

    describe("bucket", () => {
      it("keeps an open-ended top bucket written with a plus", async () => {
        // the commonest idiom there is, so task 6 reaches for it by reflex.
        // ">60 min" says the same thing, but a reflex does not consult a brief
        for (const value of ["60+ min", "100+ MB", "10+s"]) {
          const properties = await captureOne("download_completed", {
            elapsed_bucket: value
          })
          expect(properties.elapsed_bucket).toBe(value)
        }
      })

      it("requires a unit, so a bare number is not a bucket", async () => {
        // "1000+" was accepted before the unit became mandatory. a unitless
        // label is unreadable in a chart anyway, so this costs nothing
        for (const value of ["2024", "1000+", "0", "1-5", "<1"]) {
          const properties = await captureOne("download_completed", {
            elapsed_bucket: value
          })
          expect(properties).not.toHaveProperty("elapsed_bucket")
        }
      })

      it("keeps the labels the taxonomy anticipates", async () => {
        for (const value of [
          "1-5 min",
          "<1m",
          ">10m",
          "10-50 MB",
          "30s",
          "<1 min",
          ">1 hour",
          "0-1s"
        ]) {
          const properties = await captureOne("download_completed", {
            elapsed_bucket: value
          })
          expect(properties.elapsed_bucket).toBe(value)
        }
      })

      it("rejects prose and filenames", async () => {
        for (const value of [
          "My Holiday Video",
          "vacation.mp4",
          "unknown",
          "a while"
        ]) {
          const properties = await captureOne("download_completed", {
            elapsed_bucket: value
          })
          expect(properties).not.toHaveProperty("elapsed_bucket")
        }
      })
    })

    describe("the imported error vocabularies", () => {
      const {
        ERROR_CATEGORIES,
        ERROR_STAGES
      } = require("../src/main/utils/error-taxonomy")

      it("accepts every category the taxonomy defines", async () => {
        for (const value of Object.values(ERROR_CATEGORIES)) {
          const properties = await captureOne("download_failed", {
            error_category: value
          })
          expect(properties.error_category).toBe(value)
        }
      })

      it("accepts every stage the taxonomy defines", async () => {
        for (const value of Object.values(ERROR_STAGES)) {
          const properties = await captureOne("download_failed", {
            error_stage: value
          })
          expect(properties.error_stage).toBe(value)
        }
      })

      it("turns a typo into a loud drop rather than a bad segment", async () => {
        for (const value of [
          "NETWORK_ERORR",
          "network_error",
          "MADE_UP_CATEGORY"
        ]) {
          const properties = await captureOne("download_failed", {
            error_category: value
          })
          expect(properties).not.toHaveProperty("error_category")
        }

        const stage = await captureOne("download_failed", {
          error_stage: "downloading"
        })
        expect(stage).not.toHaveProperty("error_stage")
      })
    })

    describe("locations and identities, whatever the kind", () => {
      // the per-kind blocks above cover each grammar's own vocabulary. this
      // one keeps the original privacy assertion in one place: none of the
      // shapes a url, a path or an address needs can survive anywhere.
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
            quality: value
          })
          expect(properties).not.toHaveProperty("quality")
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

    /**
     * error_message is the one property whose values cannot be enumerated, so
     * every other kind's defence - a vocabulary, a numeric anchor - is
     * unavailable to it. these fixtures are deliberately hostile: the module's
     * own wording is safe, and a privacy test built only from strings we write
     * ourselves proves nothing about the strings we do not.
     *
     * the assertion is always that the sensitive substring is absent from what
     * the client received. whether a warning fired is a different question.
     */
    describe("error_message against text nobody vouched for", () => {
      const home = require("os").homedir()

      async function sent(text) {
        const properties = await captureOne("download_failed", {
          error_message: text
        })
        return properties.error_message
      }

      it("takes the video id out of a watch url", async () => {
        const message = await sent(
          "Failed on https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        )

        expect(message).not.toContain("dQw4w9WgXcQ")
        expect(message).not.toContain("youtube.com")
        expect(message).toContain("[url]")
      })

      it("takes the video id out of a url that carries it in the path", async () => {
        // the existing redaction only strips a query string, so this one
        // walked straight through it
        const message = await sent("https://youtu.be/dQw4w9WgXcQ")

        expect(message).not.toContain("dQw4w9WgXcQ")
        expect(message).toBe("[url]")
      })

      it("takes the username and the title out of a windows path", async () => {
        const message = await sent(
          "Can't write to C:\\Users\\devansh\\Videos\\My Holiday Video.mp4"
        )

        expect(message).not.toContain("devansh")
        expect(message).not.toContain("Holiday")
        expect(message).not.toContain(".mp4")
        expect(message).toContain("[path]")
      })

      it("takes the title out of a home path", async () => {
        const message = await sent(
          `ERROR: unable to open ${home}/Movies/My Holiday Video.mp4`
        )

        expect(message).not.toContain(home)
        expect(message).not.toContain("Holiday")
      })

      it("takes the title out of a path that is not under home", async () => {
        // /Volumes and /mnt are nobody's home directory, so the existing
        // redaction had nothing to say about them
        const message = await sent(
          "/Volumes/Media/My Holiday Video.mp4 could not be read"
        )

        expect(message).not.toContain("Holiday")
        expect(message).toContain("[path]")
      })

      it("takes out a bare filename", async () => {
        const message = await sent("could not write video.mp4")

        expect(message).not.toContain("video.mp4")
        expect(message).toBe("could not write [file]")
      })

      it("takes out a quoted title", async () => {
        // a quoted span is where a message puts the thing it is talking about
        const message = await sent('Failed to process "My Holiday Video"')

        expect(message).not.toContain("Holiday")
        expect(message).toBe("Failed to process [text]")
      })

      it("keeps a quoted span that holds nothing but a marker", async () => {
        // node writes its file errors this way, and "open '[path]'" is worth
        // more than "open [text]" - the quote rule must not eat what the
        // scrub above it has already cleaned
        const message = await sent(
          `ENOENT: no such file or directory, open '${home}/Movies/x.mp4'`
        )

        expect(message).not.toContain(home)
        expect(message).toBe(
          "ENOENT: no such file or directory, open '[path]'"
        )
      })

      it("takes out an email address", async () => {
        const message = await sent("mail someone@example.com about it")

        expect(message).not.toContain("someone@example.com")
        expect(message).toContain("[email]")
      })

      it("takes out an ip address", async () => {
        // an ipv4 carries no letters, so the filename rule reads it as
        // harmless prose - this is the shape that walks past every other
        // check here, and the updater names one on every connect failure
        expect(
          await sent("could not connect to 140.82.121.4 for the release")
        ).toBe("could not connect to [address] for the release")

        expect(
          await sent("could not connect to 2606:2800:220:1:248:1893:25c8:1946")
        ).toBe("could not connect to [address]")
      })

      it("takes out an ipv6 in every spelling it compresses to", async () => {
        // the first version of this rule required each group after a colon to
        // be non-empty, so every compressed form - which is to say every ipv6
        // anyone actually writes - walked straight through it
        const cases = [
          ["could not connect to 2001:db8::1", "2001:db8"],
          ["could not connect to ::1", "::1"],
          ["could not connect to [::1]:443", "::1"],
          ["could not connect to [2001:db8::1]:443", "2001:db8"],
          ["could not connect to fe80::a%en0", "fe80"],
          ["could not connect to fe80::a%en0", "en0"]
        ]

        for (const [text, secret] of cases) {
          const message = await sent(text)

          expect(message).not.toContain(secret)
          expect(message).toContain("[address]")
        }
      })

      it("refuses a colon-separated address it did not recognise", async () => {
        // the backstop for whatever address shape neither of us thought of:
        // two colons with nothing but hex between them, which no wording of
        // ours produces. a mac address is the one that matters here - it is
        // an identity, and no rule above this one would have caught it
        for (const text of [
          "hardware id 00:1b:44:11:3a:b7 refused",
          "at 10:30:45 the transfer stopped"
        ]) {
          expect(await sent(text)).toBe("[redacted]")
        }
      })

      it("leaves the colons our own messages carry", async () => {
        // what the rule above must not cost: a key, a label, an exit code, a
        // clock time with one separator, and a version, which is dots
        for (const text of [
          "yt-dlp exited with code 137: Killed",
          "ERROR: [youtube] abc: Video unavailable",
          "engine reports 2026.08.19",
          "gave up at 10:30",
          "reason: the connection was reset"
        ]) {
          expect(await sent(text)).toBe(text)
        }
      })

      it("takes out a filename that is not written in latin script", async () => {
        // a title in another script is still a title, so the patterns match
        // unicode letters rather than [A-Za-z]
        const message = await sent("read of видео.mp4 failed")

        expect(message).not.toContain("видео")
        expect(message).toBe("read of [file] failed")
      })

      it("sends a placeholder when it cannot clean the text", async () => {
        // a relative path is indistinguishable from prose, so no pattern
        // could have cleaned these. failing closed costs the message; failing
        // open would cost the title
        for (const text of [
          "Movies/My Holiday Video.mp4 failed",
          "Videos\\My Holiday Video.mp4 failed"
        ]) {
          const message = await sent(text)

          expect(message).toBe("[redacted]")
          expect(message).not.toContain("Holiday")
        }
      })

      it("keeps the words that follow a path instead of eating them", async () => {
        // a path holds spaces, so it cannot end at the first one - but a tail
        // that runs to the end of the line takes the diagnosis with it
        const message = await sent(
          `unable to open ${home}/Movies/My Holiday Video.mp4 (permission denied)`
        )

        expect(message).not.toContain("Holiday")
        expect(message).toBe("unable to open [path] (permission denied)")
      })

      it("never writes the text it refused into the warning", async () => {
        console.warn.mockClear()
        await sent("Movies/My Holiday Video.mp4 failed")

        const logged = console.warn.mock.calls.flat().join(" ")
        expect(logged).toContain("error_message")
        expect(logged).not.toContain("Holiday")
        expect(logged).not.toContain("Movies")
      })

      it("leaves the engine's own wording exactly as it is", async () => {
        // ERROR_METADATA and TERMINAL_ERRORS in ytdlp-engine.js. a sample
        // rather than the whole table, chosen for the shapes that could trip
        // a pattern: an apostrophe, sentence periods, a bare hyphenated word
        for (const wording of [
          "YouTube asked us to confirm you're not a bot.",
          "This video isn't available for download.",
          "Your antivirus stopped the video processor.",
          "Not enough disk space to save this download.",
          "The download stopped responding."
        ]) {
          expect(await sent(wording)).toBe(wording)
        }
      })

      it("leaves a version string alone", async () => {
        // the updater reports these, and a dotted token of digits is not a
        // filename however much it looks like one
        const wording = "staged engine reports 2026.08.19, expected 2026.08.20"
        expect(await sent(wording)).toBe(wording)
      })

      it("scrubs before it truncates, not after", async () => {
        // truncating first would cut a path in half and leave the front of it
        // behind, which no pattern then matches
        const prose = "y".repeat(440)
        const message = await sent(`${prose} ${home}/Movies/x.mp4`)

        expect(message).not.toContain(home)
        expect(message).toBe(`${prose} [path]`)
        expect(message.length).toBeLessThanOrEqual(500)
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
          quality: "https://private.example/v"
        })

        expect(properties).not.toHaveProperty("quality")
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
      await captureOne("download_completed", { media_type: 42 })
      logged = console.warn.mock.calls.flat().join(" ")
      expect(logged).toContain("media_type")
      expect(logged).toContain("vocabulary")
    })
  })
})
