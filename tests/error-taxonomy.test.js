const {
  ERROR_CATEGORIES,
  ERROR_STAGES,
  CATEGORY_PATTERNS,
  classify
} = require("../src/main/utils/error-taxonomy")

describe("classify", () => {
  it("puts an antivirus kill in its own bucket, not generic ffmpeg", () => {
    const result = classify(
      "ffmpeg exited with code 137: Killed",
      ERROR_STAGES.POSTPROCESS
    )
    expect(result.category).toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)
  })

  it("prefers the specific ffmpeg cause over the generic one", () => {
    const result = classify(
      "ERROR: Postprocessing: moov atom not found",
      ERROR_STAGES.POSTPROCESS
    )
    expect(result.category).toBe(ERROR_CATEGORIES.FFMPEG_CORRUPT_STREAM)
  })

  it("splits geo blocks out of video-unavailable", () => {
    const result = classify(
      "ERROR: The uploader has not made this video available in your country",
      ERROR_STAGES.FETCH_INFO
    )
    expect(result.category).toBe(ERROR_CATEGORIES.GEO_BLOCKED)
  })

  it("recognises a missing js runtime instead of blaming extraction", () => {
    const result = classify(
      "ERROR: No suitable JavaScript runtime was found",
      ERROR_STAGES.RESOLVE_BINARY
    )
    expect(result.category).toBe(ERROR_CATEGORIES.JS_RUNTIME_MISSING)
  })

  it("falls back to UNKNOWN_ERROR and keeps the stage", () => {
    const result = classify("something nobody predicted", ERROR_STAGES.DOWNLOAD)
    expect(result.category).toBe(ERROR_CATEGORIES.UNKNOWN_ERROR)
    expect(result.stage).toBe(ERROR_STAGES.DOWNLOAD)
  })

  it("accepts an Error object or a {code} object, not just a string", () => {
    expect(classify(new Error("no space left on device"), ERROR_STAGES.FILESYSTEM).category)
      .toBe(ERROR_CATEGORIES.DISK_FULL)
    expect(classify({ code: "BOT_DETECTION" }, ERROR_STAGES.DOWNLOAD).category)
      .toBe(ERROR_CATEGORIES.BOT_DETECTION)
  })

  it("only blames antivirus during postprocessing", () => {
    // "killed" outside the ffmpeg stage is some other process dying - calling
    // that an av block would send us chasing a defender bug that isn't there
    const result = classify(
      "ffmpeg exited with code 137: Killed",
      ERROR_STAGES.DOWNLOAD
    )
    expect(result.category).not.toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)
    expect(result.category).toBe(ERROR_CATEGORIES.FFMPEG_ERROR)
  })

  it("keeps ungated patterns matching at every stage", () => {
    for (const stage of Object.values(ERROR_STAGES)) {
      expect(classify("no space left on device", stage).category)
        .toBe(ERROR_CATEGORIES.DISK_FULL)
    }
  })

  it("never throws back at a caller that hands it a hostile object", () => {
    const hostile = {
      get message() {
        throw new Error("boom")
      }
    }

    expect(() => classify(hostile, ERROR_STAGES.IPC)).not.toThrow()
    expect(classify(hostile, ERROR_STAGES.IPC)).toEqual({
      category: ERROR_CATEGORIES.UNKNOWN_ERROR,
      stage: ERROR_STAGES.IPC
    })
  })
})

describe("CATEGORY_PATTERNS", () => {
  it("cannot be rewritten by the modules that import it", () => {
    const before = CATEGORY_PATTERNS.length
    expect(Object.isFrozen(CATEGORY_PATTERNS)).toBe(true)

    // a push throws on a frozen array under strict mode and no-ops without it -
    // either way the table every other module sees must come out unchanged
    try {
      CATEGORY_PATTERNS.push({ category: "INJECTED", patterns: [/./] })
    } catch {
      // frozen, as intended
    }

    expect(CATEGORY_PATTERNS).toHaveLength(before)
    expect(CATEGORY_PATTERNS.some((entry) => entry.category === "INJECTED"))
      .toBe(false)
  })

  it("freezes each entry and its pattern list too", () => {
    for (const entry of CATEGORY_PATTERNS) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.patterns)).toBe(true)
      if (entry.stages) {
        expect(Object.isFrozen(entry.stages)).toBe(true)
      }
    }
  })

  it("keeps classifying correctly after a mutation attempt", () => {
    try {
      CATEGORY_PATTERNS.length = 0
    } catch {
      // frozen, as intended
    }

    expect(classify("no space left on device", ERROR_STAGES.FILESYSTEM).category)
      .toBe(ERROR_CATEGORIES.DISK_FULL)
  })
})
