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
  "That file has no cookies in it. Export cookies.txt with the extension, then pick that file.",
  "That file has cookies, but none of them are YouTube's. Export cookies.txt while you're on youtube.com.",
  "Cookies file must be Netscape formatted, not JSON. Export it as cookies.txt.",
  "That file is far too big to be a cookie export. Pick the cookies.txt the extension saved."
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

  test("the text-paste route carries its reason the same way", async () => {
    const reason = REFUSALS[1]
    const handlers = handlersWith({
      importCookies: jest.fn().mockRejectedValue(new Error(reason)),
      hasValidCookies: jest.fn(() => false),
      hasYouTubeCookies: jest.fn(() => false)
    })

    const response = await handlers.handleImportCookies(null, { cookies: "x" })

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

    expect(response.success).toBe(true)
    expect(response.data).toMatchObject({ imported: true, signedIn: false })
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
