// @vitest-environment jsdom
//
// what the dialog says about a jar
//
// the sentence for a broken jar is main's, not ours - cookieJarProblem already
// knows which way it is broken, and a second copy of that table here is exactly
// the drift the shared parser was written to stop. So these check that the
// dialog renders what it is told rather than deciding for itself.

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useCookieStore } from "@/lib/cookieStore"
import { useLocale } from "@/lib/i18n"

const getStatus = vi.fn()

const importFile = vi.fn()
const testCookies = vi.fn()
const clearCookies = vi.fn()

const openExternal = vi.fn(async () => true)

vi.mock("@/lib/api", () => ({
  cookiesApi: {
    getStatus: () => getStatus(),
    importFile: () => importFile(),
    test: () => testCookies(),
    clear: () => clearCookies()
  },
  systemApi: { openExternal: (...a: unknown[]) => openExternal(...(a as [])) },
  // the dialog asks whether a refusal carried one of main's codes
  CookieError: class CookieError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.code = code
    }
  }
}))
const toastPlain = vi.fn()
const toastWarning = vi.fn()
const toastError = vi.fn()
vi.mock("sonner", () => ({
  toast: Object.assign((...a: unknown[]) => toastPlain(...a), {
    success: vi.fn(),
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a)
  })
}))

function status(overrides = {}) {
  return {
    status: { lastImport: null, lastTest: null },
    hasValidCookies: false,
    problem: null,
    fileInfo: {
      exists: true,
      size: 0,
      modified: null,
      cookieCount: 0,
      youtubeCookieCount: 0,
      expiredCookieCount: 0,
      hasSid: false,
      signedIn: false,
      valid: false
    },
    ...overrides
  }
}

async function open() {
  const { CookieDialog } = await import("./CookieDialog")
  render(<CookieDialog />)
  useCookieStore.getState().open()
}

beforeEach(() => {
  useCookieStore.setState({ isOpen: false })
  getStatus.mockReset()
  importFile.mockReset()
  testCookies.mockReset()
  clearCookies.mockReset()
  toastPlain.mockClear()
  toastWarning.mockClear()
  toastError.mockClear()
  openExternal.mockClear()
})

afterEach(() => {
  cleanup()
  // every other test in this file asserts on english
  useLocale.setState({ locale: "en" })
})

describe("CookieDialog", () => {
  test("a signed-in jar reports the count and drops the instructions", async () => {
    getStatus.mockResolvedValue(
      status({
        hasValidCookies: true,
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 22,
          youtubeCookieCount: 22,
          signedIn: true,
          valid: true
        }
      })
    )

    await open()

    await waitFor(() =>
      expect(screen.getByText(/signed in · 22 cookies/)).toBeTruthy()
    )
    // the recipe is the empty state, not permanent furniture
    expect(screen.queryByText(/close that youtube tab/i)).toBeNull()
    expect(screen.getByText(/replace/)).toBeTruthy()
  })

  test("an empty jar teaches the export, and warns about the account", async () => {
    getStatus.mockResolvedValue(status())

    await open()

    await waitFor(() =>
      expect(screen.getByText("here's how to import them")).toBeTruthy()
    )
    expect(screen.getByText(/close that youtube tab/i)).toBeTruthy()
    // the account warning moved onto the step it is about, rather than sitting
    // apart with an amber bar down its side
    expect(screen.getByText(/spare account/i)).toBeTruthy()
    expect(screen.getByText("import cookies…")).toBeTruthy()
    // nothing on disk, so nothing to reassure anyone about
    expect(screen.queryByText(/nothing got deleted/)).toBeNull()
  })

  // a jar that stopped working used to render exactly like one that never
  // existed: same layout, same button label, no timestamp, no count. The only
  // reasonable reading of that is "pressing Test deleted my cookies"
  test("a jar that stopped working still shows that it was imported", async () => {
    getStatus.mockResolvedValue(
      status({
        problem: "youtube ended this session, export your cookies again",
        status: {
          lastImport: new Date(Date.now() - 2 * 86400000).toISOString()
        },
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 12,
          youtubeCookieCount: 12,
          hasSid: true
        }
      })
    )

    await open()

    await waitFor(() =>
      expect(screen.getByText(/youtube ended this session/)).toBeTruthy()
    )
    // the three things that say "your file is still there"
    expect(screen.getByText(/nothing got deleted/)).toBeTruthy()
    expect(screen.getByText(/12 cookies/)).toBeTruthy()
    expect(screen.getByText("imported 2 days ago")).toBeTruthy()
    // and a button that reads as a redo rather than a first run
    expect(screen.getByText("try again…")).toBeTruthy()
  })

  // the two failures that look identical to a user and mean different things.
  // both come from main word for word
  test.each([
    [
      "these cookies aren't from a signed-in session, sign in first then export"
    ],
    ["your cookies expired, grab a fresh export"]
  ])("renders main's sentence: %s", async (problem) => {
    getStatus.mockResolvedValue(
      status({
        problem,
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 8,
          youtubeCookieCount: 8
        }
      })
    )

    await open()

    await waitFor(() => expect(screen.getByText(problem)).toBeTruthy())
    // still unusable, so the instructions stay up
    expect(screen.getByText(/close that youtube tab/i)).toBeTruthy()
  })
})

// picking the wrong file used to do nothing visible: no toast on the way in,
// and a status line reading "No cookies imported" - the same words as an
// untouched install. The button looked broken and the jar was gone.
describe("a file that isn't a cookie jar", () => {
  test("says so, with main's reason", async () => {
    importFile.mockRejectedValue(
      new Error(
        "there are no cookies in that file. export cookies.txt with the extension, then pick that one."
      )
    )
    getStatus.mockResolvedValue(status())

    await open()
    await waitFor(() =>
      expect(screen.getByText("here's how to import them")).toBeTruthy()
    )
    screen.getByText("import cookies…").click()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][1].description).toMatch(
      /no cookies in that file/
    )
  })

  test("a jar that imports but isn't a login is not silent either", async () => {
    importFile.mockResolvedValue({ imported: false, hasValidCookies: false })
    getStatus.mockResolvedValueOnce(status()).mockResolvedValue(
      status({
        problem:
          "these cookies aren't from a signed-in session, sign in first then export",
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 4,
          youtubeCookieCount: 4
        }
      })
    )

    await open()
    await waitFor(() =>
      expect(screen.getByText("here's how to import them")).toBeTruthy()
    )
    screen.getByText("import cookies…").click()

    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastWarning.mock.calls[0][1].description).toMatch(
      /signed-in session/
    )
  })
})

/**
 * Test used to title its toast off cookiesLoaded alone, which main sets to true
 * for any jar that loaded. So a probe that came back rejected - YouTube turning
 * the cookies down while they were being sent, the one strong negative there is
 * - announced "Cookies look fine" above a description saying the opposite.
 */
describe("testing the cookies", () => {
  const signedInStatus = () =>
    status({
      hasValidCookies: true,
      fileInfo: {
        ...status().fileInfo,
        cookieCount: 22,
        youtubeCookieCount: 22,
        signedIn: true,
        valid: true
      }
    })

  test("a rejection is not called fine", async () => {
    getStatus.mockResolvedValue(signedInStatus())
    testCookies.mockResolvedValue({
      cookiesLoaded: true,
      extractionCheck: "rejected",
      rejected: true,
      note: "YouTube asked us to confirm we're not a bot while sending your cookies."
    })

    await open()
    await waitFor(() => expect(screen.getByText("test")).toBeTruthy())
    screen.getByText("test").click()

    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastWarning.mock.calls[0][0]).toMatch(/turned these down/i)
    expect(toastPlain).not.toHaveBeenCalled()
  })

  test("a probe that went through still reads as fine", async () => {
    getStatus.mockResolvedValue(signedInStatus())
    testCookies.mockResolvedValue({
      cookiesLoaded: true,
      extractionCheck: "passed",
      rejected: false,
      note: "Extraction worked with your cookies attached."
    })

    await open()
    await waitFor(() => expect(screen.getByText("test")).toBeTruthy())
    screen.getByText("test").click()

    await waitFor(() => expect(toastPlain).toHaveBeenCalled())
    expect(toastPlain.mock.calls[0][0]).toBe("cookies look fine")
  })
})

// handleClear had no catch and no finally: a rejection left the button spinning
// for the rest of the session, and said nothing about the login still being on
// disk
describe("removing the cookies", () => {
  test("a failure is surfaced and the button recovers", async () => {
    getStatus.mockResolvedValue(
      status({
        hasValidCookies: true,
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 22,
          youtubeCookieCount: 22,
          signedIn: true,
          valid: true
        }
      })
    )
    clearCookies.mockRejectedValue(
      new Error("couldn't remove the cookies, they're still on this machine")
    )

    await open()
    await waitFor(() => expect(screen.getByText("remove")).toBeTruthy())
    screen.getByText("remove").click()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][1].description).toMatch(
      /still on this machine/
    )
    // and it is a button again rather than a permanent spinner
    await waitFor(() =>
      expect(screen.getByText("remove").closest("button")?.disabled).toBe(false)
    )
  })
})

/**
 * the reassurance is the feature, not decoration
 *
 * "sign in to a youtube downloader" is a sentence people are right to hesitate
 * over, and the answer to it - you are signing in to youtube, in your browser,
 * and the file never leaves the machine - has to be on screen before the ask.
 */
describe("what the dialog promises about the file", () => {
  test.each([
    [/never to cliply/i],
    [/stays on this device/i],
    [/delete it whenever you want/i]
  ])("says %s whether or not cookies are imported", async (phrase) => {
    getStatus.mockResolvedValue(status())

    await open()

    await waitFor(() => expect(screen.getByText(phrase)).toBeTruthy())
  })

  // it would be a strange kind of reassurance that disappeared the moment
  // somebody acted on it
  test("and keeps saying it once a jar is imported", async () => {
    getStatus.mockResolvedValue(
      status({
        hasValidCookies: true,
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 22,
          youtubeCookieCount: 22,
          signedIn: true,
          valid: true
        }
      })
    )

    await open()

    await waitFor(() =>
      expect(screen.getByText(/stays on this device/i)).toBeTruthy()
    )
    expect(screen.getByText(/never to cliply/i)).toBeTruthy()
  })
})

/**
 * robots.txt is copied, never opened
 *
 * openExternal hands a url to the *default* browser, which opens a normal
 * window - undoing step 2, which just spent a sentence explaining why the
 * private window is the thing keeping these cookies alive. So the address goes
 * to the clipboard, to be pasted into the window they already have open.
 */
describe("the robots.txt address", () => {
  test("goes to the clipboard rather than to a browser", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    getStatus.mockResolvedValue(status())

    await open()
    await waitFor(() =>
      expect(screen.getByText("youtube.com/robots.txt")).toBeTruthy()
    )
    screen.getByText("youtube.com/robots.txt").click()

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "https://www.youtube.com/robots.txt"
      )
    )
    // the whole point: no browser was opened
    expect(openExternal).not.toHaveBeenCalled()
  })

  test("and says so, so the click does not look like it did nothing", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => undefined) }
    })
    getStatus.mockResolvedValue(status())

    await open()
    await waitFor(() => expect(screen.getByText("click to copy")).toBeTruthy())
    screen.getByText("youtube.com/robots.txt").click()

    await waitFor(() =>
      expect(screen.getByText(/copied, paste it there/)).toBeTruthy()
    )
  })

  // the extension links are the opposite case, and must still open a browser
  test("the extension links still open a browser", async () => {
    getStatus.mockResolvedValue(status())

    await open()
    await waitFor(() =>
      expect(screen.getByText("get cookies.txt LOCALLY")).toBeTruthy()
    )
    screen.getByText("get cookies.txt LOCALLY").click()

    await waitFor(() => expect(openExternal).toHaveBeenCalled())
  })
})

/**
 * a fresh install is not a fault, and used to be told it was
 *
 * the status row reported "nothing imported yet" before showing anybody how to
 * import anything, which is a strange way to open: here is what you are
 * missing, and now the instructions. It reads as a heading for the steps
 * instead. The distinction it has to get right is that a jar yt-dlp refuses
 * whole also inspects as zero cookies, and "here's how to import them" is the
 * wrong thing to say about a file that is already sitting on disk, broken.
 */
describe("the row above the steps", () => {
  test("introduces the steps when nothing has ever been imported", async () => {
    getStatus.mockResolvedValue(status({ problem: "nothing imported yet" }))

    await open()

    await waitFor(() =>
      expect(screen.getByText("here's how to import them")).toBeTruthy()
    )
    expect(screen.queryByText("nothing imported yet")).toBeNull()
  })

  test("but reports the problem when a file is there and unreadable", async () => {
    getStatus.mockResolvedValue(
      status({
        problem:
          "that file is malformed, export a fresh one instead of editing it",
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 0,
          loadError: "domain-flag-mismatch"
        }
      })
    )

    await open()

    await waitFor(() => expect(screen.getByText(/malformed/)).toBeTruthy())
    // the one that would be actively misleading
    expect(screen.queryByText("here's how to import them")).toBeNull()
  })

  test("and reports the count once a login is in", async () => {
    getStatus.mockResolvedValue(
      status({
        hasValidCookies: true,
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 22,
          youtubeCookieCount: 22,
          signedIn: true,
          valid: true
        }
      })
    )

    await open()

    await waitFor(() =>
      expect(screen.getByText(/signed in · 22 cookies/)).toBeTruthy()
    )
    expect(screen.queryByText("here's how to import them")).toBeNull()
  })
})

/**
 * this dialog is the reason the translation exists: a blocked russian user who
 * cannot read the six steps has no way out of the block at all.
 *
 * main's own sentences are the interesting half. They stay english on the wire
 * - the logs and issue bodies read them - and arrive with a code beside them,
 * so the row below is translated without anyone matching english prose.
 */
describe("in russian", () => {
  beforeEach(() => useLocale.setState({ locale: "ru" }))

  test("the steps and the import button are readable", async () => {
    getStatus.mockResolvedValue(status())

    await open()

    await waitFor(() =>
      expect(screen.getByText("импортируйте этот файл здесь")).toBeTruthy()
    )
    expect(screen.getByText("импортировать cookies…")).toBeTruthy()
    // the product names that stay latin whatever the locale
    expect(screen.getByText("get cookies.txt LOCALLY")).toBeTruthy()
  })

  test("main's verdict is said in russian, by its code", async () => {
    getStatus.mockResolvedValue(
      status({
        problem: "youtube ended this session, export your cookies again",
        problemCode: "JAR_SESSION_ENDED",
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 12,
          youtubeCookieCount: 12,
          hasSid: true
        }
      })
    )

    await open()

    await waitFor(() =>
      expect(
        screen.getByText(
          "YouTube завершил эту сессию, экспортируйте cookies заново"
        )
      ).toBeTruthy()
    )
  })

  // a code this dictionary has not caught up with must not blank the row
  test("a code we do not know keeps main's english", async () => {
    getStatus.mockResolvedValue(
      status({
        problem: "something new main learned to say",
        problemCode: "JAR_SOMETHING_NEW",
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 12,
          youtubeCookieCount: 12
        }
      })
    )

    await open()

    await waitFor(() =>
      expect(screen.getByText("something new main learned to say")).toBeTruthy()
    )
  })

  // the word stays latin and undeclined next to any number, because what is
  // being counted is cookies rather than the one file holding them
  test("the signed-in row counts in russian", async () => {
    getStatus.mockResolvedValue(
      status({
        hasValidCookies: true,
        fileInfo: {
          ...status().fileInfo,
          cookieCount: 22,
          youtubeCookieCount: 22,
          signedIn: true,
          valid: true
        }
      })
    )

    await open()

    await waitFor(() =>
      expect(screen.getByText("вы вошли · 22 cookies")).toBeTruthy()
    )
  })
})

// and english still gets main's sentence untouched, which is the other half of
// the same decision
test("under english the status row is main's own text", async () => {
  getStatus.mockResolvedValue(
    status({
      problem: "youtube ended this session, export your cookies again",
      problemCode: "JAR_SESSION_ENDED",
      fileInfo: {
        ...status().fileInfo,
        cookieCount: 12,
        youtubeCookieCount: 12,
        hasSid: true
      }
    })
  )

  await open()

  await waitFor(() =>
    expect(
      screen.getByText("youtube ended this session, export your cookies again")
    ).toBeTruthy()
  )
})

// "export the cookies" was a gesture people were expected to already know.
// step 4 is a toolbar icon and a button, and it has to say so
test("the export step names the icon and the button", async () => {
  getStatus.mockResolvedValue(status())

  await open()

  await waitFor(() =>
    expect(screen.getByText(/click the extension/i)).toBeTruthy()
  )
  expect(screen.getByText("export")).toBeTruthy()
  expect(screen.getByText(/up by your address bar/i)).toBeTruthy()
})
