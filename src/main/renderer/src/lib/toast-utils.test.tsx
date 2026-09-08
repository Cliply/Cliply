// which way out a failed download offers
//
// bot detection is the one failure the user can act on, and until now the only
// action on this toast was "Report" - so a blocked user could report the block
// and nothing else. main has flagged these all along; nothing read the flag.

import { describe, expect, test, vi, beforeEach } from "vitest"

const toastError = vi.fn()
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const openCookies = vi.fn()
const openReport = vi.fn()
vi.mock("@/lib/cookieStore", () => ({ cookieActions: { open: () => openCookies() } }))
vi.mock("@/lib/reportStore", () => ({ reportActions: { open: () => openReport() } }))

import { showBotDetectionToast, showDownloadErrorToast } from "@/lib/toast-utils"

function actionOf(call: number = 0) {
  return toastError.mock.calls[call][1].action as {
    label: string
    onClick: () => void
  }
}

beforeEach(() => {
  toastError.mockClear()
  openCookies.mockClear()
  openReport.mockClear()
})

describe("showDownloadErrorToast", () => {
  test("sends a blocked user to the cookie import", () => {
    showDownloadErrorToast("Download failed", "blocked", "BOT_DETECTION")

    expect(actionOf().label).toBe("Fix with cookies")

    actionOf().onClick()
    expect(openCookies).toHaveBeenCalled()
    expect(openReport).not.toHaveBeenCalled()
  })

  // every other failure keeps the action it had. a network blip is not
  // something cookies fix, and offering them would be a wrong instruction
  test.each([["NETWORK_ERROR"], ["RATE_LIMITED"], [undefined]])(
    "%s still offers Report",
    (category) => {
      showDownloadErrorToast("Download failed", "went wrong", category)

      expect(actionOf().label).toBe("Report")

      actionOf().onClick()
      expect(openReport).toHaveBeenCalled()
      expect(openCookies).not.toHaveBeenCalled()
    }
  )
})

describe("showBotDetectionToast", () => {
  // the lookup path had no action at all, and it is where most blocks land
  test("carries main's wording and the cookie action", () => {
    showBotDetectionToast("YouTube asked us to confirm you're not a bot.")

    expect(toastError).toHaveBeenCalledWith(
      "YouTube asked us to confirm you're not a bot.",
      expect.objectContaining({ id: "bot-detected" })
    )
    expect(actionOf().label).toBe("Fix with cookies")

    actionOf().onClick()
    expect(openCookies).toHaveBeenCalled()
  })
})
