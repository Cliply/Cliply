// what counts as a usable cookie jar
//
// "the file has some non-comment lines" used to be the whole test, which meant
// an expired jar - or one exported for an unrelated site - was reported as a
// working youtube login.

const fs = require("fs").promises
const os = require("os")
const path = require("path")

const CookieManager = require("../src/main/services/cookie-manager")

const HEADER = "# Netscape HTTP Cookie File\n# This is a generated file! Do not edit.\n\n"

// domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
function cookieLine(domain, name, expires) {
  return [domain, "TRUE", "/", "TRUE", String(expires), name, "value"].join("\t")
}

const HOUR = 3600
const nowSeconds = () => Math.floor(Date.now() / 1000)

async function managerWith(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-cookies-"))
  const cookieFile = path.join(dir, "youtube_cookies.txt")

  // write the fixture first: the constructor kicks off initialize(), which
  // creates an empty cookie file when it finds none, and would otherwise race
  // this write and clobber it
  await fs.writeFile(cookieFile, content, "utf8")

  const manager = new CookieManager()

  // reassigned synchronously, before initialize() gets past its first await
  manager.cookieDir = dir
  manager.cookieFile = cookieFile
  manager.statusFile = path.join(dir, "cookie_status.json")

  await manager.refresh()

  return manager
}

describe("inspectCookieFile", () => {
  test("counts a live youtube cookie as usable", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", nowSeconds() + HOUR) + "\n"
    )

    expect(await manager.inspectCookieFile()).toEqual({
      total: 1,
      youtube: 1,
      expired: 0,
      usable: true
    })
  })

  test("an empty jar is not usable", async () => {
    const manager = await managerWith(HEADER)

    expect(await manager.inspectCookieFile()).toEqual({
      total: 0,
      youtube: 0,
      expired: 0,
      usable: false
    })
  })

  // the old check accepted these: any non-comment line was "valid"
  test("expired youtube cookies are not usable", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", nowSeconds() - HOUR) + "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      youtube: 1,
      expired: 1,
      usable: false
    })
  })

  test("cookies for another site are not a youtube login", async () => {
    const manager = await managerWith(
      HEADER +
        cookieLine(".google.com", "SAPISID", nowSeconds() + HOUR) +
        "\n" +
        cookieLine(".example.com", "session", nowSeconds() + HOUR) +
        "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      total: 2,
      youtube: 0,
      usable: false
    })
  })

  test("one live cookie among expired ones is enough", async () => {
    const manager = await managerWith(
      HEADER +
        cookieLine(".youtube.com", "OLD", nowSeconds() - HOUR) +
        "\n" +
        cookieLine(".youtube.com", "SID", nowSeconds() + HOUR) +
        "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      youtube: 2,
      expired: 1,
      usable: true
    })
  })

  // expiry 0 is a session cookie, which has not expired
  test("session cookies count as live", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", 0) + "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({ usable: true })
  })

  // "#HttpOnly_" looks like a comment but marks a real cookie - dropping those
  // loses exactly the youtube auth cookies that matter
  test("http-only cookies are read, not skipped as comments", async () => {
    const manager = await managerWith(
      HEADER +
        "#HttpOnly_" +
        cookieLine(".youtube.com", "__Secure-1PSID", nowSeconds() + HOUR) +
        "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      total: 1,
      youtube: 1,
      usable: true
    })
  })

  test("comments and blank lines are ignored", async () => {
    const manager = await managerWith(
      HEADER + "# a note\n\n\t# indented note\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({ total: 0 })
  })

  test("truncated lines are skipped", async () => {
    const manager = await managerWith(HEADER + ".youtube.com\tTRUE\t/\n")

    expect(await manager.inspectCookieFile()).toMatchObject({ total: 0 })
  })

  // a nonnumeric or negative expiry is a malformed row, not a cookie that
  // never expires - reading it as a session cookie turns junk into a login
  test.each([
    ["nonnumeric", "not-a-number"],
    ["negative", "-1"],
    ["a float", "1.5"],
    ["empty", ""]
  ])("a %s expiry makes the row malformed, not live", async (_label, expiry) => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", expiry) + "\n"
    )

    expect(await manager.inspectCookieFile()).toEqual({
      total: 0,
      youtube: 0,
      expired: 0,
      usable: false
    })
  })

  test("a malformed row does not discard the good rows around it", async () => {
    const manager = await managerWith(
      HEADER +
        cookieLine(".youtube.com", "BAD", "whenever") +
        "\n" +
        cookieLine(".youtube.com", "SID", nowSeconds() + HOUR) +
        "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      total: 1,
      youtube: 1,
      usable: true
    })
  })

  test("a missing file reads as empty", async () => {
    const manager = await managerWith(HEADER)
    manager.cookieFile = path.join(manager.cookieDir, "not-there.txt")

    expect(await manager.inspectCookieFile()).toMatchObject({
      total: 0,
      usable: false
    })
  })

  test("subdomains of youtube.com count, lookalikes do not", async () => {
    const manager = await managerWith(
      HEADER +
        cookieLine("music.youtube.com", "SID", nowSeconds() + HOUR) +
        "\n" +
        cookieLine("notyoutube.com", "SID", nowSeconds() + HOUR) +
        "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      total: 2,
      youtube: 1,
      usable: true
    })
  })
})

describe("validateCookieFile", () => {
  test("follows the inspection", async () => {
    const live = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", nowSeconds() + HOUR) + "\n"
    )
    const stale = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", nowSeconds() - HOUR) + "\n"
    )

    expect(await live.validateCookieFile()).toBe(true)
    expect(await stale.validateCookieFile()).toBe(false)
  })

  test("refresh updates hasValidCookies and the cookie path", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", nowSeconds() - HOUR) + "\n"
    )

    await manager.refresh()
    expect(manager.hasValidCookies()).toBe(false)
    expect(manager.getCookieFilePath()).toBeNull()

    await fs.writeFile(
      manager.cookieFile,
      HEADER + cookieLine(".youtube.com", "SID", nowSeconds() + HOUR) + "\n",
      "utf8"
    )

    await manager.refresh()
    expect(manager.hasValidCookies()).toBe(true)
    expect(manager.getCookieFilePath()).toBe(manager.cookieFile)
  })
})

describe("the retired 'working' key", () => {
  // older builds wrote working:true when all they knew was that a file existed
  test("is stripped from a status file written by an older build", async () => {
    const manager = await managerWith(HEADER)

    await fs.writeFile(
      manager.statusFile,
      JSON.stringify({ working: true, lastImport: "2026-01-01T00:00:00.000Z" }),
      "utf8"
    )

    const status = await manager.getStatus()

    expect(status).not.toHaveProperty("working")
    expect(status.lastImport).toBe("2026-01-01T00:00:00.000Z")
    expect(status.cookiesLoaded).toBe(false)
  })

  test("cannot be written back by a caller", async () => {
    const manager = await managerWith(HEADER)

    await manager.updateStatus({ working: true, note: "hello" })

    const onDisk = JSON.parse(await fs.readFile(manager.statusFile, "utf8"))
    expect(onDisk).not.toHaveProperty("working")
    expect(onDisk.note).toBe("hello")
  })

  test("clearing cookies records the new fields instead", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", nowSeconds() + HOUR) + "\n"
    )

    await manager.clearCookies()

    const onDisk = JSON.parse(await fs.readFile(manager.statusFile, "utf8"))
    expect(onDisk).not.toHaveProperty("working")
    expect(onDisk).toMatchObject({
      cookiesLoaded: false,
      extractionCheck: "skipped"
    })
    expect(manager.hasValidCookies()).toBe(false)
  })
})

describe("getFileInfo", () => {
  test("reports the youtube and expired counts", async () => {
    const manager = await managerWith(
      HEADER +
        cookieLine(".youtube.com", "SID", nowSeconds() + HOUR) +
        "\n" +
        cookieLine(".youtube.com", "OLD", nowSeconds() - HOUR) +
        "\n" +
        cookieLine(".example.com", "session", nowSeconds() + HOUR) +
        "\n"
    )

    expect(await manager.getFileInfo()).toMatchObject({
      exists: true,
      cookieCount: 3,
      youtubeCookieCount: 2,
      expiredCookieCount: 1
    })
  })
})
