// @vitest-environment jsdom
//
// what an info failure carries once it has crossed ipc.
//
// main classifies the failure itself and puts the answer in `category`
// (ipc-handlers.js:421) - `code` beside it is the engine's own code or the
// "GENERAL_ERROR" placeholder, which is not a taxonomy value at all. throwing a
// bare Error here discarded both, so every media_info_failed the renderer could
// report was UNKNOWN_ERROR.

import { afterEach, describe, expect, test, vi } from "vitest"

import { DownloadError, pinterestApi, tiktokApi, videoApi } from "./api"

type Responder = () => unknown

function bridge({
  getInfo
}: {
  getInfo: Responder
}) {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    video: { getInfo: async () => getInfo() },
    pinterest: { getInfo: async () => getInfo() },
    tiktok: { getInfo: async () => getInfo() }
  }
}

const FAILURE = {
  success: false,
  error: {
    message: "YouTube asked us to confirm you're not a bot.",
    suggestion: "Import your YouTube cookies from Settings and try again.",
    code: "BOT_DETECTION",
    details: "ERROR: [youtube] Sign in to confirm you're not a bot",
    category: "BOT_DETECTION"
  }
}

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe("an info request that failed", () => {
  test.each([
    ["youtube", () => videoApi.getVideoInfo("https://youtu.be/abc")],
    ["pinterest", () => pinterestApi.getInfo("https://pin.it/abc")],
    ["tiktok", () => tiktokApi.getInfo("https://vm.tiktok.com/abc")]
  ])("carries %s's classification back to the caller", async (_name, call) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    bridge({ getInfo: () => FAILURE })

    const error = await call().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DownloadError)
    // still an Error, so every existing `instanceof Error` branch is unmoved
    expect(error).toBeInstanceOf(Error)
    expect((error as DownloadError).message).toBe(FAILURE.error.message)
    expect((error as DownloadError).category).toBe("BOT_DETECTION")
    expect((error as DownloadError).details).toBe(FAILURE.error.details)
  })

  test("survives a failure that carried no classification", async () => {
    // the preload's own catch returns {message, suggestion} and nothing else
    vi.spyOn(console, "error").mockImplementation(() => {})
    bridge({
      getInfo: () => ({
        success: false,
        error: { message: "Communication error with main process" }
      })
    })

    const error = (await videoApi
      .getVideoInfo("https://youtu.be/abc")
      .catch((thrown: unknown) => thrown)) as DownloadError

    expect(error.message).toBe("Communication error with main process")
    expect(error.category).toBeUndefined()
  })
})
