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
  test("sends a blocked youtube user to the cookie import", () => {
    showDownloadErrorToast("Download failed", "blocked", "BOT_DETECTION", "youtube")

    expect(actionOf().label).toBe("fix with cookies")

    actionOf().onClick()
    expect(openCookies).toHaveBeenCalled()
    expect(openReport).not.toHaveBeenCalled()
  })

  // every other failure keeps the action it had. a network blip is not
  // something cookies fix, and offering them would be a wrong instruction
  test.each([["NETWORK_ERROR"], ["RATE_LIMITED"], [undefined]])(
    "%s still offers Report",
    (category) => {
      showDownloadErrorToast("Download failed", "went wrong", category, "youtube")

      expect(actionOf().label).toBe("report")

      actionOf().onClick()
      expect(openReport).toHaveBeenCalled()
      expect(openCookies).not.toHaveBeenCalled()
    }
  )

  /**
   * BOT_DETECTION is not youtube's alone: the taxonomy matches a bare
   * "use --cookies", which tiktok and pinterest emit too. The dialog behind
   * this action imports youtube cookies and nothing else, so offering it for
   * one of those sends the user somewhere that cannot help them. An unnamed
   * platform gets Report as well - a missing action beats a wrong one.
   */
  test.each([["pinterest"], ["tiktok"], [undefined]])(
    "a %s block is not offered youtube cookies",
    (platform) => {
      showDownloadErrorToast(
        "Download failed",
        "blocked",
        "BOT_DETECTION",
        platform as "pinterest" | "tiktok" | undefined
      )

      expect(actionOf().label).toBe("report")

      actionOf().onClick()
      expect(openCookies).not.toHaveBeenCalled()
    }
  )
})

describe("showBotDetectionToast", () => {
  // the lookup path had no action at all, and it is where most blocks land
  test("carries main's wording and the cookie action", () => {
    showBotDetectionToast("YouTube asked us to confirm you're not a bot.", "youtube")

    expect(toastError).toHaveBeenCalledWith(
      "YouTube asked us to confirm you're not a bot.",
      expect.objectContaining({ id: "bot-detected" })
    )
    expect(actionOf().label).toBe("fix with cookies")

    actionOf().onClick()
    expect(openCookies).toHaveBeenCalled()
  })

  // the search hook is shared across all three platforms, so this path reaches
  // tiktok and pinterest too
  test.each([["pinterest"], ["tiktok"]])(
    "a %s block keeps main's wording but not the cookie action",
    (platform) => {
      showBotDetectionToast("They asked us to confirm we're not a bot.", platform as "pinterest" | "tiktok")

      expect(toastError.mock.calls[0][0]).toBe(
        "They asked us to confirm we're not a bot."
      )
      expect(actionOf().label).toBe("report")

      actionOf().onClick()
      expect(openCookies).not.toHaveBeenCalled()
    }
  )
})
