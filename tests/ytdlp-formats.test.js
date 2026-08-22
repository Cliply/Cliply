// unit tests for the simple-platform download options
// (the youtube preset table is gone - the menu is built from real formats now)

const { getSimplePlatformOptions } = require("../src/main/utils/ytdlp-formats")

describe("simple platform presets", () => {
  test("tiktok keeps the options its python service used", () => {
    const { formatSelector, extraArgs } = getSimplePlatformOptions("tiktok")

    // 'b' avoids the watermarked download_addr streams
    expect(formatSelector).toBe("b")
    expect(extraArgs).toContain("X-Forwarded-For:8.8.8.8")
    expect(extraArgs).toContain("tiktok:api_hostname=api22-normal-v4.tiktokv.com")
    expect(extraArgs[extraArgs.indexOf("--merge-output-format") + 1]).toBe("mp4")
  })

  test("pinterest merges video and audio, like the python path", () => {
    const { formatSelector, extraArgs } = getSimplePlatformOptions("pinterest")

    expect(formatSelector).toBe("bestvideo+bestaudio/best")
    expect(extraArgs[extraArgs.indexOf("--merge-output-format") + 1]).toBe("mp4")
  })

  test("an unknown platform falls back to plain best", () => {
    expect(getSimplePlatformOptions("nope")).toEqual({
      formatSelector: "best",
      extraArgs: []
    })
  })

  test("callers cannot mutate the shared preset", () => {
    getSimplePlatformOptions("tiktok").extraArgs.push("--boom")
    expect(getSimplePlatformOptions("tiktok").extraArgs).not.toContain("--boom")
  })
})
