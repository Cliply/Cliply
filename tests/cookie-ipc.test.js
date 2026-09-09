// the seam between the cookie manager and the screen
//
// the manager works out a precise reason a file was refused - "none of them are
// YouTube's", "no cookies in it", "malformed" - and every one of them used to
// reach the user as "Failed to import cookie file". createError puts its second
// argument in `suggestion`, and cookiesApi.importFile throws `message`, so the
// reason went into the field nothing reads.
//
// the dialog's own suite could not catch this: it mocks cookiesApi and hands
// itself the detailed sentence that the real seam was dropping. So the check
// belongs here, on the response shape main actually returns.

const path = require("path")

jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  dialog: { showOpenDialog: jest.fn() },
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0") }
}))

const { dialog } = require("electron")
const IPCHandlers = require("../src/main/ipc-handlers")

function handlersWith(cookieManager) {
  return new IPCHandlers({
    cookieManager,
    ytdlpEngine: {},
    ytdlpUpdater: null,
    settingsStore: { ensureDownloadPath: jest.fn().mockResolvedValue("/tmp") },
    analytics: null
  })
}

const REFUSALS = [
  "there are no cookies in that file. export cookies.txt with the extension, then pick that one.",
  "that file has cookies, but none of them are youtube's. export cookies.txt while you're on youtube.com.",
  "that's json, not a netscape cookies.txt. export it as cookies.txt instead.",
  "that file is way too big to be a cookie export. pick the cookies.txt the extension saved."
]

describe("a refused import reaches the renderer with its reason intact", () => {
  beforeEach(() => {
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join("/tmp", "picked.txt")]
    })
  })

  test.each(REFUSALS)("%s", async (reason) => {
    const handlers = handlersWith({
      importCookieFile: jest.fn().mockRejectedValue(new Error(reason)),
      hasValidCookies: jest.fn(() => false),
      hasYouTubeCookies: jest.fn(() => false)
    })

    const response = await handlers.handleImportCookieFile(null)

    expect(response.success).toBe(false)
    // `message` is the field cookiesApi.importFile throws. anything the user is
    // meant to read has to be in it
    expect(response.error.message).toBe(reason)
  })

  // an import that landed but is not a login is a real state, not a failure -
  // it used to come back as imported:false, which the dialog read as the button
  // having done nothing
  test("a jar that imports without being a login still reports as imported", async () => {
    const handlers = handlersWith({
      importCookieFile: jest.fn().mockResolvedValue(false),
      hasValidCookies: jest.fn(() => false),
      hasYouTubeCookies: jest.fn(() => true)
    })

    const response = await handlers.handleImportCookieFile(null)

    // success is the import landing, which the ipc envelope already says. The
    // payload's job is only to answer whether what landed authenticates, and
    // it says no here without that being a failure
    expect(response.success).toBe(true)
    expect(response.data).toEqual({ hasValidCookies: false })
  })
})

// removing a login is the one operation whose failure must not read as success
describe("a clear that failed says so", () => {
  test("the jar is still there, and the response is an error", async () => {
    const handlers = handlersWith({
      clearCookies: jest
        .fn()
        .mockRejectedValue(new Error("EROFS: read-only file system")),
      hasValidCookies: jest.fn(() => true),
      hasYouTubeCookies: jest.fn(() => true)
    })

    const response = await handlers.handleClearCookies(null)

    expect(response.success).toBe(false)
    expect(response.error.message).toMatch(/still on this machine/)
  })
})

// the probe's verdict has to survive the trip, or the dialog cannot tell
// "loaded and accepted" from "loaded and turned down"
describe("a cookie test that youtube rejected", () => {
  test("comes back flagged rather than as a plain success", async () => {
    const handlers = handlersWith({
      refresh: jest.fn().mockResolvedValue(true),
      inspectCookieFile: jest.fn().mockResolvedValue({
        total: 2,
        youtube: 2,
        expired: 0,
        hasSid: true,
        signedIn: true,
        usable: true,
        loadError: null
      }),
      getCookieFilePath: jest.fn(() => "/tmp/jar.txt"),
      getStatus: jest.fn().mockResolvedValue({}),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      hasValidCookies: jest.fn(() => true),
      hasYouTubeCookies: jest.fn(() => true)
    })

    handlers.probeCookies = jest.fn().mockResolvedValue({
      extractionCheck: "rejected",
      note: "YouTube asked us to confirm we're not a bot while sending your cookies."
    })

    const response = await handlers.handleTestCookies(null)

    expect(response.data).toMatchObject({
      cookiesLoaded: true,
      extractionCheck: "rejected",
      rejected: true
    })
  })

  test("a probe that went through is not flagged", async () => {
    const handlers = handlersWith({
      refresh: jest.fn().mockResolvedValue(true),
      inspectCookieFile: jest.fn().mockResolvedValue({
        total: 2,
        youtube: 2,
        expired: 0,
        hasSid: true,
        signedIn: true,
        usable: true,
        loadError: null
      }),
      getCookieFilePath: jest.fn(() => "/tmp/jar.txt"),
      getStatus: jest.fn().mockResolvedValue({}),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      hasValidCookies: jest.fn(() => true),
      hasYouTubeCookies: jest.fn(() => true)
    })

    handlers.probeCookies = jest
      .fn()
      .mockResolvedValue({ extractionCheck: "passed", note: "Extraction worked." })

    const response = await handlers.handleTestCookies(null)

    expect(response.data.rejected).toBe(false)
  })
})

/**
 * the codes have to survive the trip, or the renderer is back to matching
 * english prose to work out what main just said
 *
 * main stays english on purpose - its sentences feed the logs and the issue
 * bodies - so a russian install says the same thing by looking the code up.
 * A code that main computes and then drops at the ipc boundary is a code the
 * dialog can never use.
 */
describe("the codes reach the renderer beside the sentences", () => {
  test("a refused import carries the code it was refused under", async () => {
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join("/tmp", "picked.txt")]
    })

    const refusal = Object.assign(
      new Error("that's json, not a netscape cookies.txt. export it as cookies.txt instead."),
      { code: "COOKIES_JSON" }
    )

    const handlers = handlersWith({
      importCookieFile: jest.fn().mockRejectedValue(refusal),
      hasValidCookies: jest.fn(() => false),
      hasYouTubeCookies: jest.fn(() => false)
    })

    const response = await handlers.handleImportCookieFile(null)

    expect(response.error.code).toBe("COOKIES_JSON")
    // and the english is still the message, which is the field the ui throws
    expect(response.error.message).toMatch(/json, not a netscape/)
  })

  // a failure with no code of its own - a full disk, a permission error - must
  // still come back, just without one to translate by
  test("a failure main has no code for keeps the placeholder", async () => {
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join("/tmp", "picked.txt")]
    })

    const handlers = handlersWith({
      importCookieFile: jest
        .fn()
        .mockRejectedValue(new Error("ENOSPC: no space left on device")),
      hasValidCookies: jest.fn(() => false),
      hasYouTubeCookies: jest.fn(() => false)
    })

    const response = await handlers.handleImportCookieFile(null)

    expect(response.error.code).toBe("GENERAL_ERROR")
  })

  // node puts its own code on filesystem errors. that is not a refusal and
  // must not cross as one, or the field means two things
  test("a node error code is not forwarded as a refusal code", async () => {
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join("/tmp", "picked.txt")]
    })

    const full = Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC"
    })

    const handlers = handlersWith({
      importCookieFile: jest.fn().mockRejectedValue(full),
      hasValidCookies: jest.fn(() => false),
      hasYouTubeCookies: jest.fn(() => false)
    })

    const response = await handlers.handleImportCookieFile(null)

    expect(response.error.code).toBe("GENERAL_ERROR")
    expect(response.error.message).toMatch(/no space left/)
  })

  test("the status reports a problem as both a sentence and a code", async () => {
    const handlers = handlersWith({
      getStatus: jest.fn().mockResolvedValue({}),
      getFileInfo: jest.fn().mockResolvedValue({
        cookieCount: 12,
        youtubeCookieCount: 12,
        expiredCookieCount: 0,
        hasSid: true,
        signedIn: false,
        loadError: null
      }),
      hasValidCookies: jest.fn(() => false),
      hasYouTubeCookies: jest.fn(() => true)
    })

    const response = await handlers.handleGetCookieStatus(null)

    expect(response.data.problemCode).toBe("JAR_SESSION_ENDED")
    expect(response.data.problem).toBe(
      "youtube ended this session, export your cookies again"
    )
  })

  // a working jar has neither, and the code must not outlive the sentence
  test("a jar that works reports no problem at all", async () => {
    const handlers = handlersWith({
      getStatus: jest.fn().mockResolvedValue({}),
      getFileInfo: jest.fn().mockResolvedValue({
        cookieCount: 22,
        youtubeCookieCount: 22,
        expiredCookieCount: 0,
        hasSid: true,
        signedIn: true,
        loadError: null
      }),
      hasValidCookies: jest.fn(() => true),
      hasYouTubeCookies: jest.fn(() => true)
    })

    const response = await handlers.handleGetCookieStatus(null)

    expect(response.data.problem).toBeNull()
    expect(response.data.problemCode).toBeNull()
  })

  test("a jar too broken to test reports the code with its note", async () => {
    const handlers = handlersWith({
      inspectCookieFile: jest.fn().mockResolvedValue({
        total: 0,
        youtube: 0,
        expired: 0,
        hasSid: false,
        signedIn: false,
        usable: false,
        loadError: "domain-flag-mismatch"
      }),
      getStatus: jest.fn().mockResolvedValue({}),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      hasValidCookies: jest.fn(() => false),
      hasYouTubeCookies: jest.fn(() => false)
    })

    const response = await handlers.handleTestCookies(null)

    expect(response.data.noteCode).toBe("JAR_MALFORMED")
    expect(response.data.note).toMatch(/malformed/)
  })

  test("and a probe's verdict carries its own code across", async () => {
    const handlers = handlersWith({
      inspectCookieFile: jest.fn().mockResolvedValue({
        total: 2,
        youtube: 2,
        expired: 0,
        hasSid: true,
        signedIn: true,
        usable: true,
        loadError: null
      }),
      getCookieFilePath: jest.fn(() => "/tmp/jar.txt"),
      getStatus: jest.fn().mockResolvedValue({}),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      hasValidCookies: jest.fn(() => true),
      hasYouTubeCookies: jest.fn(() => true)
    })

    handlers.probeCookies = jest.fn().mockResolvedValue({
      extractionCheck: "rejected",
      noteCode: "PROBE_REJECTED",
      note: "youtube still asked us to prove we're not a bot while sending your cookies."
    })

    const response = await handlers.handleTestCookies(null)

    expect(response.data.noteCode).toBe("PROBE_REJECTED")
  })
})
