const {
  ERROR_CATEGORIES,
  ERROR_STAGES,
  CATEGORY_PATTERNS,
  appliesToStage,
  classify
} = require("../src/main/utils/error-taxonomy")

// the stage gate is tested here on fixtures rather than through the production
// table, which has no gated entry since FFMPEG_AV_BLOCKED stopped needing one.
// the mechanism is kept for a caller that knows its own stage - the updater is
// always at UPDATE - so it is worth holding to its contract now, not later.
describe("appliesToStage", () => {
  const gated = { stages: [ERROR_STAGES.UPDATE, ERROR_STAGES.RESOLVE_BINARY] }
  const ungated = { patterns: [/whatever/i] }

  it("lets a gated entry through at a stage it names", () => {
    expect(appliesToStage(gated, ERROR_STAGES.UPDATE)).toBe(true)
    expect(appliesToStage(gated, ERROR_STAGES.RESOLVE_BINARY)).toBe(true)
  })

  it("holds a gated entry back at every stage it does not name", () => {
    const others = Object.values(ERROR_STAGES).filter(
      (stage) => !gated.stages.includes(stage)
    )

    expect(others.length).toBeGreaterThan(0)
    for (const stage of others) {
      expect(appliesToStage(gated, stage)).toBe(false)
    }
  })

  it("lets an ungated entry through at every stage", () => {
    for (const stage of Object.values(ERROR_STAGES)) {
      expect(appliesToStage(ungated, stage)).toBe(true)
    }
  })

  it("reads an empty stages list as naming no stage, not as ungated", () => {
    // an empty array is truthy, so this takes the gated branch and matches
    // nothing. that is the safe reading: a typo that empties the list disables
    // the entry rather than quietly letting it match everywhere
    for (const stage of Object.values(ERROR_STAGES)) {
      expect(appliesToStage({ stages: [] }, stage)).toBe(false)
    }
  })
})

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

  it("recognises an av kill from the text, at any stage", () => {
    // mapError reads a stderr tail without knowing which stage produced it, so
    // this has to work at the stage it actually classifies at
    for (const stage of Object.values(ERROR_STAGES)) {
      expect(classify("ffmpeg exited with code 137: Killed", stage).category)
        .toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)
    }
  })

  it("needs a kill token next to ffmpeg, not just anywhere", () => {
    // "killed" on its own is some other process dying - calling that an av
    // block would send us chasing a defender bug that isn't there
    for (const text of [
      "ERROR: the process was killed",
      "Killed",
      "sigkill received",
      // yt-dlp runs postprocessors that are not ffmpeg, so the heading alone
      // does not make a kill an ffmpeg kill
      "ERROR: Postprocessing: thumbnail helper was killed",
      "ERROR: Postprocessing: AtomicParsley was killed"
    ]) {
      expect(classify(text, ERROR_STAGES.POSTPROCESS).category)
        .not.toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)
    }
  })

  it("leaves an ordinary ffmpeg failure generic", () => {
    expect(classify("ffmpeg exited with code 1", ERROR_STAGES.POSTPROCESS).category)
      .toBe(ERROR_CATEGORIES.FFMPEG_ERROR)
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

const {
  ERROR_CODES,
  ERROR_METADATA,
  TERMINAL_ERRORS,
  explicitError,
  mapError
} = require("../src/main/services/ytdlp-engine")

describe("NOT_A_VIDEO", () => {
  // "there was never a video here" is a different failure from "there was a
  // video and it is gone": one is content that went away, the other is somebody
  // expecting a downloader to take an image. folding the second into the first
  // buries a ux signal inside a bucket that reads as someone else's problem
  it("is its own category, not a shade of VIDEO_UNAVAILABLE", () => {
    expect(ERROR_CATEGORIES.NOT_A_VIDEO).toBe("NOT_A_VIDEO")
    expect(ERROR_CATEGORIES.NOT_A_VIDEO).not.toBe(
      ERROR_CATEGORIES.VIDEO_UNAVAILABLE
    )
  })

  it("is honoured as an explicit code", () => {
    // nothing else can produce it, so a caller that names it has to be believed
    expect(
      classify({ code: "NOT_A_VIDEO" }, ERROR_STAGES.FETCH_INFO).category
    ).toBe(ERROR_CATEGORIES.NOT_A_VIDEO)
  })

  it("is produced by no pattern, including its own wording", () => {
    // we raise it by inspecting a format list, never by reading stderr. a
    // pattern for it would be guessing at text nobody writes
    for (const text of [
      "This Pinterest pin contains an image, not a video.",
      "not a video",
      "image"
    ]) {
      expect(classify(text, ERROR_STAGES.FETCH_INFO).category).not.toBe(
        ERROR_CATEGORIES.NOT_A_VIDEO
      )
    }
  })

  it("has wording of its own to fall back on", () => {
    // ERROR_METADATA is "wording for the codes classify() can hand back", and
    // it can hand this one back now. without an entry, an explicitError for it
    // would say "Download failed" and explain nothing
    expect(ERROR_METADATA[ERROR_CATEGORIES.NOT_A_VIDEO].message).toEqual(
      expect.any(String)
    )
    expect(explicitError(ERROR_CATEGORIES.NOT_A_VIDEO).message).not.toBe(
      TERMINAL_ERRORS[ERROR_CODES.DOWNLOAD_FAILED].message
    )
  })
})

describe("taxonomy adoption", () => {
  it("engine ERROR_CODES is the taxonomy, not a second list", () => {
    expect(ERROR_CODES).toBe(ERROR_CATEGORIES)
  })

  it("keeps the two wording tables from shadowing each other", () => {
    // wordingFor prefers TERMINAL_ERRORS, so a key in both would silently hide
    // the ERROR_METADATA entry - and its behaviour flags with it
    const overlap = Object.keys(TERMINAL_ERRORS).filter(
      (code) => code in ERROR_METADATA
    )

    expect(overlap).toEqual([])
  })

  it("has wording for every code either table can produce", () => {
    // both tables, not just the metadata one: wordingFor falls back through
    // TERMINAL_ERRORS[DOWNLOAD_FAILED], so a blank message there would surface
    // as a blank message for any code neither table knows
    for (const table of [ERROR_METADATA, TERMINAL_ERRORS]) {
      expect(Object.keys(table).length).toBeGreaterThan(0)

      for (const [code, entry] of Object.entries(table)) {
        expect(typeof entry.message).toBe("string")
        expect(entry.message.trim().length).toBeGreaterThan(0)
        expect(typeof entry.suggestion).toBe("string")
        expect(entry.suggestion.trim().length).toBeGreaterThan(0)
        expect(ERROR_CATEGORIES[code]).toBe(code)
      }
    }
  })

  it("keeps both wording tables frozen after load", () => {
    for (const table of [ERROR_METADATA, TERMINAL_ERRORS]) {
      expect(Object.isFrozen(table)).toBe(true)
      for (const entry of Object.values(table)) {
        expect(Object.isFrozen(entry)).toBe(true)
      }
    }
  })

  it("constants no longer exports a rival vocabulary", () => {
    const constants = require("../src/main/utils/constants")
    expect(constants.ERROR_TYPES).toBeUndefined()
  })

  it("analytics-helpers no longer exports categorizeError", () => {
    const helpers = require("../src/main/utils/analytics-helpers")
    expect(helpers.categorizeError).toBeUndefined()
  })
})

// the engine's ERROR_PATTERNS table was the live classifier before the taxonomy
// took over. these are the patterns it carried that the taxonomy was derived
// from - every one of them must still land on a sensible category, or the
// reconciliation dropped something users were relying on.
describe("parity with the engine's retired pattern table", () => {
  const cases = [
    ["sign in to confirm you're not a bot", "BOT_DETECTION"],
    ["use --cookies", "BOT_DETECTION"],
    ["cookies are no longer valid", "BOT_DETECTION"],
    ["ERROR: Video unavailable", "VIDEO_UNAVAILABLE"],
    ["this video is private", "VIDEO_UNAVAILABLE"],
    ["sign in to confirm your age", "VIDEO_UNAVAILABLE"],
    ["join this channel to get access", "VIDEO_UNAVAILABLE"],
    ["no space left on device", "DISK_FULL"],
    ["ERROR: unable to open for writing", "PERMISSION_ERROR"],
    ["errno 13 permission denied", "PERMISSION_ERROR"],
    ["ERROR: unable to extract player response", "EXTRACTION_FAILED"],
    ["nsig extraction failed", "EXTRACTION_FAILED"],
    // the engine carried this one and the first draft of the taxonomy did not
    ["Some web client https formats have been skipped", "EXTRACTION_FAILED"],
    ["unable to download webpage", "NETWORK_ERROR"],
    ["HTTP Error 503: Service Unavailable", "NETWORK_ERROR"],
    ["remote end closed connection without response", "NETWORK_ERROR"],
    // 429 arrives wrapped in the same "unable to download webpage" wording as a
    // genuine network fault, so it has to be read before that pattern claims it
    [
      "unable to download webpage: HTTP Error 429: Too Many Requests",
      "RATE_LIMITED"
    ],
    ["HTTP Error 429: Too Many Requests", "RATE_LIMITED"],
    ["ffmpeg exited with code 1", "FFMPEG_ERROR"],
    ["ERROR: Postprocessing: something went wrong", "FFMPEG_ERROR"],
    // the engine folded these into one FFMPEG_ERROR; the taxonomy splits them
    ["ffmpeg not found", "FFMPEG_MISSING"],
    ["ffmpeg is not installed", "FFMPEG_MISSING"],
    ["moov atom not found", "FFMPEG_CORRUPT_STREAM"],
    ["Invalid data found when processing input", "FFMPEG_CORRUPT_STREAM"]
  ]

  it.each(cases)("classifies %j as %s", (text, expected) => {
    expect(classify(text, ERROR_STAGES.DOWNLOAD).category)
      .toBe(ERROR_CATEGORIES[expected])
  })

  // task 6 reads these into analytics, where a destructured undefined is not
  // false - so every path has to carry all three flags, cancelled included
  it("returns the same shape on every path", () => {
    const paths = {
      cancelled: mapError({ cancelled: true }),
      stalled: mapError({ stalled: true }),
      classified: mapError({ exitCode: 1, stderrLines: ["ERROR: Video unavailable"] }),
      fallback: mapError({ exitCode: 1, stderrLines: ["ERROR: nobody has seen this"] }),
      // the explicit-code path fail() takes: terminal wording carries no flags
      // at all, so this is the one most likely to emit them as undefined
      explicitTerminal: explicitError(ERROR_CATEGORIES.ENGINE_MISSING, null),
      explicitClassified: explicitError(ERROR_CATEGORIES.EXTRACTION_FAILED, null),
      explicitUnknownCode: explicitError("NOT_A_REAL_CODE", null)
    }

    for (const result of Object.values(paths)) {
      expect(Object.keys(result).sort()).toEqual([
        "code",
        "details",
        "message",
        "needsCookies",
        "retryable",
        "suggestion",
        "updateMayFix"
      ])

      for (const flag of ["retryable", "updateMayFix", "needsCookies"]) {
        expect(typeof result[flag]).toBe("boolean")
      }

      expect(typeof result.message).toBe("string")
      expect(result.message.trim().length).toBeGreaterThan(0)
    }

    // the flags still carry real values where they matter, on both routes
    expect(
      mapError({ exitCode: 1, stderrLines: ["ERROR: nsig extraction failed"] }).updateMayFix
    ).toBe(true)
    expect(paths.explicitClassified.updateMayFix).toBe(true)
    expect(paths.explicitTerminal.retryable).toBe(false)

    // a code neither table knows still gets the non-blank fallback wording
    expect(paths.explicitUnknownCode.message).toBe(
      TERMINAL_ERRORS[ERROR_CATEGORIES.DOWNLOAD_FAILED].message
    )
  })

  // the whole point of ungating FFMPEG_AV_BLOCKED: mapError is the only thing
  // that classifies real stderr, so a category it can never produce is dead
  it("reaches FFMPEG_AV_BLOCKED through mapError, not just classify", () => {
    const result = mapError({
      exitCode: 137,
      stderrLines: [
        "[Merger] Merging formats into \"video.mp4\"",
        "ERROR: Postprocessing: ffmpeg exited with code 137: Killed"
      ]
    })

    expect(result.code).toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)
    expect(result.message).toMatch(/antivirus/i)
  })

  it("does not call an unrelated kill an av block through mapError", () => {
    const result = mapError({
      exitCode: 1,
      stderrLines: ["ERROR: the helper process was killed"]
    })

    expect(result.code).not.toBe(ERROR_CATEGORIES.FFMPEG_AV_BLOCKED)
  })

  it("still carries every code the engine used to define", () => {
    // DOWNLOAD_FAILED included: it is mapError's fallback and the string the
    // renderer's report builder and the runner already emit
    const historical = [
      "BOT_DETECTION",
      "VIDEO_UNAVAILABLE",
      "NETWORK_ERROR",
      "PERMISSION_ERROR",
      "DOWNLOAD_FAILED",
      "INVALID_URL",
      "EXTRACTION_FAILED",
      "DISK_FULL",
      "FFMPEG_ERROR",
      "STALLED",
      "CANCELLED"
    ]

    for (const code of historical) {
      expect(ERROR_CATEGORIES[code]).toBe(code)
    }

    // the one intended rename
    expect(ERROR_CATEGORIES.BINARY_MISSING).toBeUndefined()
    expect(ERROR_CATEGORIES.ENGINE_MISSING).toBe("ENGINE_MISSING")
  })
})
