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
//
// the flag follows the leading dot. hardcoding TRUE wrote fixtures that
// http.cookiejar refuses outright - "music.youtube.com TRUE" is not a jar with
// an odd cookie in it, it is a jar yt-dlp will not open
function cookieLine(domain, name, expires, path = "/") {
  const flag = domain.startsWith(".") ? "TRUE" : "FALSE"

  return [domain, flag, path, "TRUE", String(expires), name, "value"].join("\t")
}

// the smallest jar yt-dlp calls a signed-in one: LOGIN_INFO alongside one of
// the SAPISID trio. any other pair of youtube cookies is what a signed-out
// visitor already carries, so it authenticates nothing
function loginPair(expires, domain = ".youtube.com") {
  return (
    cookieLine(domain, "LOGIN_INFO", expires) +
    "\n" +
    cookieLine(domain, "SAPISID", expires) +
    "\n"
  )
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

  return manager
}

describe("inspectCookieFile", () => {
  test("counts a live youtube login as usable", async () => {
    const manager = await managerWith(HEADER + loginPair(nowSeconds() + HOUR))

    expect(await manager.inspectCookieFile()).toEqual({
      total: 2,
      youtube: 2,
      expired: 0,
      hasSid: true,
      signedIn: true,
      usable: true,
      loadError: null
    })
  })

  // "there is a youtube cookie in here" was never the same question as "you
  // are signed in". PREF and SOCS are set for signed-out visitors too, so a
  // jar exported without logging in first used to report as a working login
  test("youtube cookies from a signed-out session are not a login", async () => {
    const manager = await managerWith(
      HEADER +
        cookieLine(".youtube.com", "PREF", nowSeconds() + HOUR) +
        "\n" +
        cookieLine(".youtube.com", "SOCS", nowSeconds() + HOUR) +
        "\n"
    )

    expect(await manager.inspectCookieFile()).toEqual({
      total: 2,
      youtube: 2,
      expired: 0,
      hasSid: false,
      signedIn: false,
      usable: false,
      loadError: null
    })
  })

  // youtube clears LOGIN_INFO when it rotates a session away but leaves the
  // SAPISID cookies behind. --cookies writes the jar back, so this is the
  // shape our own copy takes once the cookies stop working
  test("a rotated-out jar keeps its SAPISID and stops being a login", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SAPISID", nowSeconds() + HOUR) + "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      youtube: 1,
      expired: 0,
      // the tell: the session's remnant is still here, so this jar used to work
      hasSid: true,
      signedIn: false,
      usable: false
    })
  })

  test("an empty jar is not usable", async () => {
    const manager = await managerWith(HEADER)

    expect(await manager.inspectCookieFile()).toEqual({
      total: 0,
      youtube: 0,
      expired: 0,
      hasSid: false,
      signedIn: false,
      usable: false,
      loadError: null
    })
  })

  // the old check accepted these: any non-comment line was "valid"
  test("expired youtube cookies are not usable", async () => {
    const manager = await managerWith(HEADER + loginPair(nowSeconds() - HOUR))

    expect(await manager.inspectCookieFile()).toMatchObject({
      youtube: 2,
      expired: 2,
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

  test("a live login among expired cookies is enough", async () => {
    const manager = await managerWith(
      HEADER +
        cookieLine(".youtube.com", "OLD", nowSeconds() - HOUR) +
        "\n" +
        loginPair(nowSeconds() + HOUR)
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      youtube: 3,
      expired: 1,
      usable: true
    })
  })

  // expiry 0 is a session cookie, which has not expired
  test("session cookies count as live", async () => {
    const manager = await managerWith(HEADER + loginPair(0))

    expect(await manager.inspectCookieFile()).toMatchObject({ usable: true })
  })

  // "#HttpOnly_" looks like a comment but marks a real cookie - dropping those
  // loses exactly the youtube auth cookies that matter
  test("http-only cookies are read, not skipped as comments", async () => {
    // youtube marks its auth cookies http-only, so this is also the check
    // that the login test sees them at all
    const manager = await managerWith(
      HEADER +
        "#HttpOnly_" +
        cookieLine(".youtube.com", "LOGIN_INFO", nowSeconds() + HOUR) +
        "\n#HttpOnly_" +
        cookieLine(".youtube.com", "SAPISID", nowSeconds() + HOUR) +
        "\n"
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      total: 2,
      youtube: 2,
      signedIn: true,
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
    ["negative", "-1"]
  ])("a %s expiry makes the row malformed, not live", async (_label, expiry) => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", expiry) + "\n"
    )

    expect(await manager.inspectCookieFile()).toEqual({
      total: 0,
      youtube: 0,
      expired: 0,
      hasSid: false,
      signedIn: false,
      usable: false,
      loadError: null
    })
  })

  // a float and an empty column used to be lumped in with the junk above. they
  // are not junk to yt-dlp: its guard is /[0-9]+(?:\.[0-9]+)?/ and an absent
  // expiry is how a session cookie is written. calling them malformed dropped
  // rows the downloader would have used
  test("a float expiry is a real expiry, truncated", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "SID", "1.5") + "\n"
    )

    // 1 second past the epoch - read, and then long expired
    expect(await manager.inspectCookieFile()).toEqual({
      total: 1,
      youtube: 1,
      expired: 1,
      hasSid: false,
      signedIn: false,
      usable: false,
      loadError: null
    })
  })

  test("an empty expiry is a session cookie, which has not expired", async () => {
    const manager = await managerWith(HEADER + loginPair(""))

    expect(await manager.inspectCookieFile()).toEqual({
      total: 2,
      youtube: 2,
      expired: 0,
      hasSid: true,
      signedIn: true,
      usable: true,
      loadError: null
    })
  })

  test("a malformed row does not discard the good rows around it", async () => {
    const manager = await managerWith(
      HEADER +
        cookieLine(".youtube.com", "BAD", "whenever") +
        "\n" +
        loginPair(nowSeconds() + HOUR)
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      total: 2,
      youtube: 2,
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

  // two separate questions, and this fixture is exactly where they part. a
  // host-only music.youtube.com cookie is youtube's - it counts - but
  // _has_auth_cookies asks the jar about https://www.youtube.com, and a
  // host-only cookie for another subdomain is never sent there. Counting it as
  // a login reported a signed-in user to whom yt-dlp would send nothing.
  test("subdomains of youtube.com count, lookalikes do not", async () => {
    const manager = await managerWith(
      HEADER +
        loginPair(nowSeconds() + HOUR, "music.youtube.com") +
        loginPair(nowSeconds() + HOUR, "notyoutube.com")
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      total: 4,
      youtube: 2,
      usable: false
    })
  })

  test("the same login on .youtube.com is sent to www, and is a login", async () => {
    const manager = await managerWith(
      HEADER + loginPair(nowSeconds() + HOUR, ".youtube.com")
    )

    expect(await manager.inspectCookieFile()).toMatchObject({
      youtube: 2,
      usable: true
    })
  })
})

describe("validateCookieFile", () => {
  test("follows the inspection", async () => {
    const live = await managerWith(HEADER + loginPair(nowSeconds() + HOUR))
    const stale = await managerWith(HEADER + loginPair(nowSeconds() - HOUR))

    expect(await live.validateCookieFile()).toBe(true)
    expect(await stale.validateCookieFile()).toBe(false)
  })

  // this used to call refresh() either side and was named for it, which made
  // refresh look load-bearing. It never was: hasValidCookies re-reads the file
  // itself, so gutting refresh entirely left the test green. What is worth
  // pinning is the re-read, because a jar rotates out from under a running app
  test("hasValidCookies re-reads, so a jar that stopped being a login shows it", async () => {
    const manager = await managerWith(HEADER + loginPair(nowSeconds() - HOUR))

    expect(manager.hasValidCookies()).toBe(false)

    await fs.writeFile(
      manager.cookieFile,
      HEADER + loginPair(nowSeconds() + HOUR),
      "utf8"
    )

    expect(manager.hasValidCookies()).toBe(true)
  })
})

/**
 * the two questions the manager answers, which are not the same question
 *
 * gating --cookies on our own authentication test meant a jar yt-dlp would
 * happily load and send - a partial export, a session part way through
 * rotating - was silently withheld from the download. That call belongs to
 * yt-dlp. What we do withhold is a jar it cannot open at all, because
 * --cookies on one of those aborts the run rather than downloading without it.
 */
describe("what gets passed to --cookies, versus what counts as a login", () => {
  test("a signed-in jar is both", async () => {
    const manager = await managerWith(HEADER + loginPair(nowSeconds() + HOUR))

    expect(manager.hasValidCookies()).toBe(true)
    expect(manager.getCookieFilePath()).toBe(manager.cookieFile)
  })

  test("an expired jar is still worth sending, and is not a login", async () => {
    const manager = await managerWith(HEADER + loginPair(nowSeconds() - HOUR))

    expect(manager.hasValidCookies()).toBe(false)
    expect(manager.getCookieFilePath()).toBe(manager.cookieFile)
  })

  test("a signed-out visitor jar is sent too", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".youtube.com", "PREF", nowSeconds() + HOUR) + "\n"
    )

    expect(manager.hasValidCookies()).toBe(false)
    expect(manager.getCookieFilePath()).toBe(manager.cookieFile)
  })

  test("a jar with nothing of youtube's in it is not worth sending", async () => {
    const manager = await managerWith(
      HEADER + cookieLine(".example.com", "session", nowSeconds() + HOUR) + "\n"
    )

    expect(manager.getCookieFilePath()).toBeNull()
  })

  test("an empty jar is not worth sending", async () => {
    const manager = await managerWith(HEADER)

    expect(manager.getCookieFilePath()).toBeNull()
  })

  // the one that would take the whole download down with it
  test("a jar yt-dlp would refuse to open is never sent", async () => {
    const manager = await managerWith(
      HEADER + ".youtube.com\tFALSE\t/\tTRUE\t1999999999\tLOGIN_INFO\tv\n"
    )

    expect(manager.getCookieFilePath()).toBeNull()
    expect(manager.hasValidCookies()).toBe(false)
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

// what an import accepts, and what it writes
//
// the picker used to demand the long "# Netscape HTTP Cookie File" spelling
// appear somewhere in the file. yt-dlp accepts the short form too and wants the
// magic on line one, so a real export could be refused while a file that only
// mentioned the header in a comment was let through.
describe("importing", () => {
  const live = () => String(nowSeconds() + HOUR)

  async function emptyManager() {
    const manager = await managerWith(HEADER)
    await manager.clearCookies()

    return manager
  }

  test("accepts the short header yt-dlp accepts", async () => {
    const manager = await emptyManager()
    const file = path.join(manager.cookieDir, "export.txt")

    await fs.writeFile(file, `# HTTP Cookie File\n${loginPair(live())}`, "utf8")

    expect(await manager.importCookieFile(file)).toBe(true)

    // left as it was rather than given a second header, which is the only
    // observable difference between recognising the short form and repairing
    // a file we failed to recognise
    const written = await fs.readFile(manager.cookieFile, "utf8")
    expect(written.split("\n")[0]).toBe("# HTTP Cookie File")
  })

  test("adds the magic line when the export has none", async () => {
    const manager = await emptyManager()

    expect(await manager.importCookies(loginPair(live()))).toBe(true)

    // without it MozillaCookieJar raises for the whole file, so this is the
    // difference between a jar and a jar yt-dlp will read
    const written = await fs.readFile(manager.cookieFile, "utf8")
    expect(written.split("\n")[0]).toBe("# Netscape HTTP Cookie File")
  })

  test("writes \\n line endings, whatever came in", async () => {
    const manager = await emptyManager()
    const crlf = (HEADER + loginPair(live())).replace(/\n/g, "\r\n")

    expect(await manager.importCookies(crlf)).toBe(true)
    expect(await fs.readFile(manager.cookieFile, "utf8")).not.toContain("\r")
  })

  // giving json a netscape header would import "successfully" and hold nothing
  test("refuses a json export the way yt-dlp names it", async () => {
    const manager = await emptyManager()
    const file = path.join(manager.cookieDir, "cookies.json")

    await fs.writeFile(file, '[{"name": "SID", "domain": ".youtube.com"}]', "utf8")

    await expect(manager.importCookieFile(file)).rejects.toThrow(
      /json, not a netscape/i
    )
  })

  // a cookie whose value is empty legitimately ends its row with a tab.
  // Trimming the whole file ate that tab on the last line, turning a seven
  // column row into six and dropping the cookie without a word.
  //
  // the real binary was the arbiter: given this exact file it loads the row and
  // writes it back with the tab still there, so the loss was ours, not
  // something the format required.
  test("keeps a trailing tab on the last row, which is an empty value", async () => {
    const manager = await emptyManager()
    const emptyValue = [
      ".youtube.com",
      "TRUE",
      "/",
      "TRUE",
      live(),
      "EMPTYVAL",
      ""
    ].join("\t")

    expect(
      await manager.importCookies(HEADER + loginPair(live()) + emptyValue + "\n")
    ).toBe(true)

    const written = await fs.readFile(manager.cookieFile, "utf8")
    expect(written).toContain("EMPTYVAL\t")
  })

  test("still ends the file in exactly one newline", async () => {
    const manager = await emptyManager()

    expect(await manager.importCookies(HEADER + loginPair(live()) + "\n\n")).toBe(
      true
    )

    const written = await fs.readFile(manager.cookieFile, "utf8")
    expect(written.endsWith("\n")).toBe(true)
    expect(written.endsWith("\n\n")).toBe(false)
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

// an import that holds nothing must not land
//
// picking the wrong .txt used to overwrite a working jar with it and then
// report "No cookies imported" - which is what a user sees whether they
// imported junk or never imported at all. So the failure looked like nothing
// happening, while it had actually destroyed a working login.
describe("refusing a file that is not a cookie jar", () => {
  const live = () => String(nowSeconds() + HOUR)

  async function withLogin() {
    const manager = await managerWith(HEADER + loginPair(live()))
    expect(await manager.validateCookieFile()).toBe(true)
    return manager
  }

  test("says what is wrong instead of returning quietly", async () => {
    const manager = await withLogin()

    await expect(manager.importCookies("milk\neggs\nbread\n")).rejects.toThrow(
      /no cookies in that file/i
    )
  })

  test("leaves the working jar exactly as it was", async () => {
    const manager = await withLogin()
    const before = await fs.readFile(manager.cookieFile, "utf8")

    await expect(manager.importCookies("milk\neggs\nbread\n")).rejects.toThrow()

    expect(await fs.readFile(manager.cookieFile, "utf8")).toBe(before)
    expect(await manager.validateCookieFile()).toBe(true)
  })

  test("a jar with cookies but no login still imports - that is a real jar", async () => {
    const manager = await withLogin()

    // reports as "not a signed-in session", which is a state worth being in
    await expect(
      manager.importCookies(
        HEADER + cookieLine(".youtube.com", "PREF", live()) + "\n"
      )
    ).resolves.toBe(false)
    expect(await manager.inspectCookieFile()).toMatchObject({ youtube: 1, usable: false })
  })
})

/**
 * the guard is about protecting the jar that is already there
 *
 * "has at least one cookie in it" was too low a bar. The likeliest wrong pick
 * is not a shopping list - it is a perfectly valid cookies.txt exported while
 * the user was on some other site, and that sailed through the check and
 * replaced a working youtube login with cookies for example.com.
 */
describe("an import that cannot help must not replace one that can", () => {
  const live = () => String(nowSeconds() + HOUR)

  async function withLogin() {
    const manager = await managerWith(HEADER + loginPair(live()))
    expect(await manager.validateCookieFile()).toBe(true)
    return manager
  }

  test("a valid jar for another site is refused by name", async () => {
    const manager = await withLogin()

    await expect(
      manager.importCookies(
        HEADER + cookieLine(".example.com", "session", live()) + "\n"
      )
    ).rejects.toThrow(/none of them are YouTube's/i)
  })

  test("and the youtube login it would have replaced is untouched", async () => {
    const manager = await withLogin()
    const before = await fs.readFile(manager.cookieFile, "utf8")

    await expect(
      manager.importCookies(
        HEADER + cookieLine(".example.com", "session", live()) + "\n"
      )
    ).rejects.toThrow()

    expect(await fs.readFile(manager.cookieFile, "utf8")).toBe(before)
    expect(await manager.validateCookieFile()).toBe(true)
  })

  // this one would have imported "successfully" and then aborted every
  // download, which is worse than being refused
  test("a jar yt-dlp would refuse to open is refused here first", async () => {
    const manager = await withLogin()
    const before = await fs.readFile(manager.cookieFile, "utf8")

    await expect(
      manager.importCookies(
        HEADER + ".youtube.com\tFALSE\t/\tTRUE\t1999999999\tLOGIN_INFO\tv\n"
      )
    ).rejects.toThrow(/malformed/i)

    expect(await fs.readFile(manager.cookieFile, "utf8")).toBe(before)
  })

  test("a file too large to be a cookie export never reaches the jar", async () => {
    const manager = await withLogin()
    const before = await fs.readFile(manager.cookieFile, "utf8")
    const huge = path.join(manager.cookieDir, "huge.txt")

    await fs.writeFile(huge, "x".repeat(1024 * 1024 + 1), "utf8")

    await expect(manager.importCookieFile(huge)).rejects.toThrow(/too big/i)
    expect(await fs.readFile(manager.cookieFile, "utf8")).toBe(before)
  })
})

/**
 * a plain writeFile opens with O_TRUNC, so a failure part way through destroys
 * the jar it was replacing. Writing beside it and renaming means the old jar
 * survives anything that goes wrong.
 */
describe("replacing the jar is all-or-nothing", () => {
  const live = () => String(nowSeconds() + HOUR)

  test("a write that fails leaves the previous login in place", async () => {
    const manager = await managerWith(HEADER + loginPair(live()))
    const before = await fs.readFile(manager.cookieFile, "utf8")

    // the rename is the moment of replacement; failing it stands in for every
    // way the write can die after the old file would already have been truncated
    const rename = jest
      .spyOn(require("fs").promises, "rename")
      .mockRejectedValueOnce(new Error("ENOSPC: no space left on device"))

    await expect(
      manager.importCookies(HEADER + loginPair(live(), ".youtube.com"))
    ).rejects.toThrow(/ENOSPC/)

    expect(await fs.readFile(manager.cookieFile, "utf8")).toBe(before)
    expect(await manager.validateCookieFile()).toBe(true)

    rename.mockRestore()
  })

  test("and it does not leave its scratch file behind", async () => {
    const manager = await managerWith(HEADER + loginPair(live()))

    const rename = jest
      .spyOn(require("fs").promises, "rename")
      .mockRejectedValueOnce(new Error("ENOSPC"))

    await expect(manager.importCookies(HEADER + loginPair(live()))).rejects.toThrow()

    const left = await fs.readdir(manager.cookieDir)
    expect(left.filter((name) => name.endsWith(".tmp"))).toEqual([])

    rename.mockRestore()
  })

  // an import that lands but cannot be written to disk used to resolve as
  // "imported, just not a login", which is a sentence about a file that is not
  // there
  test("an i/o failure is not reported as a successful import", async () => {
    const manager = await managerWith(HEADER)

    const write = jest
      .spyOn(require("fs").promises, "writeFile")
      .mockRejectedValueOnce(new Error("EACCES: permission denied"))

    await expect(manager.importCookies(HEADER + loginPair(live()))).rejects.toThrow(
      /EACCES/
    )

    write.mockRestore()
  })
})

// a cookie jar is a youtube login in a text file, so it is written the way a
// private key is. these were 0644 on an 0755 directory
describe("the jar is not readable by anyone else", () => {
  const mode = async (target) => (await fs.stat(target)).mode & 0o777

  test("an imported jar is owner-only", async () => {
    const manager = await managerWith(HEADER)

    await manager.importCookies(HEADER + loginPair(String(nowSeconds() + HOUR)))

    expect(await mode(manager.cookieFile)).toBe(0o600)
  })

  test("clearing it does not loosen it again", async () => {
    const manager = await managerWith(HEADER)

    await manager.importCookies(HEADER + loginPair(String(nowSeconds() + HOUR)))
    await manager.clearCookies()

    expect(await mode(manager.cookieFile)).toBe(0o600)
  })

  test("an existing jar from an older build is tightened on startup", async () => {
    const manager = await managerWith(HEADER + loginPair(String(nowSeconds() + HOUR)))

    await fs.chmod(manager.cookieFile, 0o644)
    await manager.ensureCookieFile()

    expect(await mode(manager.cookieFile)).toBe(0o600)
  })
})

// removing a login is the one operation whose failure must not be reported as
// success - the credentials stay on disk behind a screen saying they are gone
describe("clearing", () => {
  test("empties the jar", async () => {
    const manager = await managerWith(HEADER + loginPair(String(nowSeconds() + HOUR)))

    await expect(manager.clearCookies()).resolves.toBe(true)
    expect(await manager.validateCookieFile()).toBe(false)
  })

  test("a write that fails is raised, not swallowed", async () => {
    const manager = await managerWith(HEADER + loginPair(String(nowSeconds() + HOUR)))

    const write = jest
      .spyOn(require("fs").promises, "writeFile")
      .mockRejectedValueOnce(new Error("EROFS: read-only file system"))

    await expect(manager.clearCookies()).rejects.toThrow(/EROFS/)
    // and the jar really is still there, which is what the caller now hears
    expect(await manager.validateCookieFile()).toBe(true)

    write.mockRestore()
  })
})
