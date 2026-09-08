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

const getStatus = vi.fn()

const importFile = vi.fn()
const testCookies = vi.fn()
const clearCookies = vi.fn()

vi.mock("@/lib/api", () => ({
  cookiesApi: {
    getStatus: () => getStatus(),
    importFile: () => importFile(),
    test: () => testCookies(),
    clear: () => clearCookies()
  },
  systemApi: { openExternal: vi.fn(async () => true) }
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
})

afterEach(cleanup)

describe("CookieDialog", () => {
  test("a signed-in jar reports the count and drops the instructions", async () => {
    getStatus.mockResolvedValue(
      status({
        hasValidCookies: true,
        fileInfo: { ...status().fileInfo, cookieCount: 22, youtubeCookieCount: 22, signedIn: true, valid: true }
      })
    )

    await open()

    await waitFor(() => expect(screen.getByText(/Signed in · 22 cookies/)).toBeTruthy())
    // the recipe is the empty state, not permanent furniture
    expect(screen.queryByText(/close the private window/i)).toBeNull()
    expect(screen.getByText(/Replace/)).toBeTruthy()
  })

  test("an empty jar teaches the export, and warns about the account", async () => {
    getStatus.mockResolvedValue(status())

    await open()

    await waitFor(() => expect(screen.getByText("Not imported")).toBeTruthy())
    expect(screen.getByText(/close the private window/i)).toBeTruthy()
    expect(screen.getByText(/throwaway account/i)).toBeTruthy()
    expect(screen.getByText("Import cookies…")).toBeTruthy()
    // nothing on disk, so nothing to reassure anyone about
    expect(screen.queryByText(/Nothing was deleted/)).toBeNull()
  })

  // a jar that stopped working used to render exactly like one that never
  // existed: same layout, same button label, no timestamp, no count. The only
  // reasonable reading of that is "pressing Test deleted my cookies"
  test("a jar that stopped working still shows that it was imported", async () => {
    getStatus.mockResolvedValue(
      status({
        problem: "YouTube ended this session - export your cookies again",
        status: { lastImport: new Date(Date.now() - 2 * 86400000).toISOString() },
        fileInfo: { ...status().fileInfo, cookieCount: 12, youtubeCookieCount: 12, hasSid: true }
      })
    )

    await open()

    await waitFor(() =>
      expect(screen.getByText(/YouTube ended this session/)).toBeTruthy()
    )
    // the three things that say "your file is still there"
    expect(screen.getByText(/Nothing was deleted/)).toBeTruthy()
    expect(screen.getByText(/12 cookies/)).toBeTruthy()
    expect(screen.getByText("imported 2 days ago")).toBeTruthy()
    // and a button that reads as a redo rather than a first run
    expect(screen.getByText("Import again…")).toBeTruthy()
  })

  // the two failures that look identical to a user and mean different things.
  // both come from main word for word
  test.each([
    ["These YouTube cookies aren't from a signed-in session - sign in first, then export"],
    ["Your YouTube cookies have expired - export them again"]
  ])("renders main's sentence: %s", async (problem) => {
    getStatus.mockResolvedValue(
      status({
        problem,
        fileInfo: { ...status().fileInfo, cookieCount: 8, youtubeCookieCount: 8 }
      })
    )

    await open()

    await waitFor(() => expect(screen.getByText(problem)).toBeTruthy())
    // still unusable, so the instructions stay up
    expect(screen.getByText(/close the private window/i)).toBeTruthy()
  })
})

// picking the wrong file used to do nothing visible: no toast on the way in,
// and a status line reading "No cookies imported" - the same words as an
// untouched install. The button looked broken and the jar was gone.
describe("a file that isn't a cookie jar", () => {
  test("says so, with main's reason", async () => {
    importFile.mockRejectedValue(
      new Error("That file has no cookies in it. Export cookies.txt with the extension, then pick that file.")
    )
    getStatus.mockResolvedValue(status())

    await open()
    await waitFor(() => expect(screen.getByText("Not imported")).toBeTruthy())
    screen.getByText("Import cookies…").click()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][1].description).toMatch(/no cookies in it/)
  })

  test("a jar that imports but isn't a login is not silent either", async () => {
    importFile.mockResolvedValue({ imported: false, hasValidCookies: false })
    getStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValue(
        status({
          problem: "These YouTube cookies aren't from a signed-in session - sign in first, then export",
          fileInfo: { ...status().fileInfo, cookieCount: 4, youtubeCookieCount: 4 }
        })
      )

    await open()
    await waitFor(() => expect(screen.getByText("Not imported")).toBeTruthy())
    screen.getByText("Import cookies…").click()

    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastWarning.mock.calls[0][1].description).toMatch(/signed-in session/)
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
      fileInfo: { ...status().fileInfo, cookieCount: 22, youtubeCookieCount: 22, signedIn: true, valid: true }
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
    await waitFor(() => expect(screen.getByText("Test")).toBeTruthy())
    screen.getByText("Test").click()

    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastWarning.mock.calls[0][0]).toMatch(/turned these cookies down/i)
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
    await waitFor(() => expect(screen.getByText("Test")).toBeTruthy())
    screen.getByText("Test").click()

    await waitFor(() => expect(toastPlain).toHaveBeenCalled())
    expect(toastPlain.mock.calls[0][0]).toBe("Cookies look fine")
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
        fileInfo: { ...status().fileInfo, cookieCount: 22, youtubeCookieCount: 22, signedIn: true, valid: true }
      })
    )
    clearCookies.mockRejectedValue(
      new Error("Couldn't remove the cookies - they're still on this machine")
    )

    await open()
    await waitFor(() => expect(screen.getByText("Remove")).toBeTruthy())
    screen.getByText("Remove").click()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][1].description).toMatch(/still on this machine/)
    // and it is a button again rather than a permanent spinner
    await waitFor(() =>
      expect(screen.getByText("Remove").closest("button")?.disabled).toBe(false)
    )
  })
})
