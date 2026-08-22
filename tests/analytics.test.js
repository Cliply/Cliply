const { Analytics } = require("../src/main/services/analytics")

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
})
