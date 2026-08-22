// unit tests for the format selectors ported from python/platforms/youtube.py

const {
  getSimplePlatformOptions,
  isYoutubeShorts,
  getFormatPresets,
  getFormatSelector,
  getAudioFormatSelector,
  getQualityLabel,
  getAudioQualityLabel
} = require("../src/main/utils/ytdlp-formats")

describe("shorts detection", () => {
  test("matches shorts urls regardless of case", () => {
    expect(isYoutubeShorts("https://www.youtube.com/shorts/abc")).toBe(true)
    expect(isYoutubeShorts("https://www.YouTube.com/Shorts/abc")).toBe(true)
  })

  test("does not match regular watch urls", () => {
    expect(isYoutubeShorts("https://www.youtube.com/watch?v=abc")).toBe(false)
    expect(isYoutubeShorts(undefined)).toBe(false)
  })
})

describe("format presets", () => {
  test("shorts get a single auto option", () => {
    const presets = getFormatPresets("https://www.youtube.com/shorts/abc")

    expect(presets.videoFormats).toHaveLength(1)
    expect(presets.videoFormats[0].format_id).toBe("shorts_auto")
    expect(presets.audioFormats).toHaveLength(1)
  })

  test("regular videos get the full list the ui expects", () => {
    const presets = getFormatPresets("https://www.youtube.com/watch?v=abc")

    expect(presets.videoFormats.map((format) => format.format_id)).toEqual([
      "auto",
      "best_quality",
      "hd_720p",
      "eco_360p"
    ])
    expect(presets.audioFormats.map((format) => format.format_id)).toEqual([
      "auto_audio",
      "high_audio",
      "medium_audio"
    ])
  })
})

describe("video format selectors", () => {
  test("match the python selectors exactly", () => {
    expect(getFormatSelector("auto", "auto_audio")).toBeNull()
    expect(getFormatSelector("shorts_auto", "auto_audio")).toBe(
      "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
    )
    expect(getFormatSelector("eco_360p", "auto_audio")).toBe(
      "best[height<=720]/bestvideo[height<=360]+bestaudio"
    )
    expect(getFormatSelector("hd_720p", "auto_audio")).toBe(
      "bestvideo[height<=720]+bestaudio"
    )
    expect(getFormatSelector("best_quality", "auto_audio")).toBe(
      "bestvideo+bestaudio/best"
    )
  })

  test("raw format ids are merged into a single selector", () => {
    expect(getFormatSelector("133", "139")).toBe("133+139")
  })

  test("falls back to best when only one side is a raw id", () => {
    expect(getFormatSelector("133", "auto_audio")).toBe("bestvideo+bestaudio/best")
    expect(getFormatSelector(undefined, undefined)).toBe("bestvideo+bestaudio/best")
  })
})

describe("audio format selectors", () => {
  test("match the python selectors exactly", () => {
    expect(getAudioFormatSelector("auto_audio")).toBe("bestaudio")
    expect(getAudioFormatSelector("high_audio")).toBe("bestaudio")
    expect(getAudioFormatSelector("medium_audio")).toBe("bestaudio[abr<=128]")
  })

  test("raw ids pass through and unknown values fall back", () => {
    expect(getAudioFormatSelector("251")).toBe("251")
    expect(getAudioFormatSelector(undefined)).toBe("bestaudio")
  })
})

describe("quality labels", () => {
  test("match the labels used in the current filenames", () => {
    expect(getQualityLabel("auto")).toBe("auto")
    expect(getQualityLabel("shorts_auto")).toBe("shorts")
    expect(getQualityLabel("best_quality")).toBe("best")
    expect(getQualityLabel("hd_720p")).toBe("720p")
    expect(getQualityLabel("eco_360p")).toBe("360p")
    expect(getQualityLabel("133")).toBe("133")
  })

  test("audio labels drop the _audio suffix", () => {
    expect(getAudioQualityLabel("auto_audio")).toBe("auto")
    expect(getAudioQualityLabel("high_audio")).toBe("high")
    expect(getAudioQualityLabel("medium_audio")).toBe("medium")
  })
})

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
