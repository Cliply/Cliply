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

vi.mock("@/lib/api", () => ({
  cookiesApi: {
    getStatus: () => getStatus(),
    importFile: vi.fn(),
    test: vi.fn(),
    clear: vi.fn()
  },
  systemApi: { openExternal: vi.fn(async () => true) }
}))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

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
