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
})
