// unit tests for the yt-dlp engine: arg building, progress parsing, error mapping

const os = require("os")
const fs = require("fs")
const path = require("path")

const {
  buildArgs,
  buildCommonArgs,
  buildTrimArgs,
  normalizeAudioLanguage,
  expectedStreamCount,
  parseProgressLine,
  parseDestinationLine,
  parseStreamCountLine,
  normalizeUrl,
  OperationGate,
  redactLogLine,
  mapError,
  cookieFileHasEntries,
  ProgressTracker,
  RingBuffer,
  LineSplitter,
  ERROR_CODES,
  PROGRESS_TEMPLATE,
  FILE_TEMPLATE,
  STREAM_TEMPLATE,
  STDERR_BUFFER_LINES
} = require("../src/main/services/ytdlp-engine")

const PATHS = {
  ffmpegPath: "/res/binaries/ffmpeg",
  denoPath: "/res/binaries/deno/deno"
}

// find the value that follows a flag in an arg list
function valueAfter(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

// flags that must appear in one exact order, back to back
function containsSequence(args, sequence) {
  return args.some((_, index) =>
    sequence.every((value, offset) => args[index + offset] === value)
  )
}

describe("common args", () => {
  test("wires up deno, ffmpeg and the quiet/newline flags", () => {
    const args = buildCommonArgs(PATHS)

    expect(args).toContain("--no-js-runtimes")
    expect(valueAfter(args, "--js-runtimes")).toBe("deno:/res/binaries/deno/deno")
    expect(valueAfter(args, "--ffmpeg-location")).toBe("/res/binaries/ffmpeg")
    expect(args).toContain("--no-warnings")
    expect(args).toContain("--newline")
  })

  // the python service's 1/1/2 turned a transient blip into a failed download
  test("leaves the retry counts at yt-dlp's own defaults", () => {
    const args = buildCommonArgs(PATHS)

    expect(args).not.toContain("--retries")
    expect(args).not.toContain("--extractor-retries")
    expect(args).not.toContain("--fragment-retries")
  })

  test("omits deno and ffmpeg flags when the binaries are unknown", () => {
    const args = buildCommonArgs({})

    expect(args).not.toContain("--js-runtimes")
    expect(args).not.toContain("--ffmpeg-location")
  })

  test("passes --cookies only when a cookie file is given", () => {
    expect(buildCommonArgs(PATHS)).not.toContain("--cookies")
    expect(
      valueAfter(buildCommonArgs({ ...PATHS, cookieFile: "/c/cookies.txt" }), "--cookies")
    ).toBe("/c/cookies.txt")
  })
})

// yt-dlp's default clients need no PO token, so the escalation is only for an
// install that has already been refused. see the PO Token Guide: the prescribed
// setup is the `mweb` client plus a provider plugin.
describe("po token escalation", () => {
  const POT = {
    ...PATHS,
    potPaths: { pluginDir: "/res/binaries/pot/plugin", serverHome: "/res/binaries/pot/server" }
  }

  test("asks for nothing extra until the install has been refused", () => {
    const args = buildCommonArgs(POT)

    expect(args).not.toContain("--plugin-dirs")
    expect(args.join(" ")).not.toContain("player_client")
  })

  test("offers the provider without dictating a client", () => {
    const args = buildCommonArgs({ ...POT, potEnabled: true })

    expect(valueAfter(args, "--plugin-dirs")).toBe("/res/binaries/pot/plugin")
    expect(args).toContain(
      "youtubepot-bgutilscript:server_home=/res/binaries/pot/server"
    )
    // making the provider reachable is the whole escalation. given one,
    // yt-dlp picks a client, notices that client needs a token and fetches it
    // with no instruction from us - verified end to end. naming a client here
    // would override the one choice yt-dlp keeps in step with youtube, and
    // pin us to whichever client was right on the day this was written
    expect(args.join(" ")).not.toContain("player_client")
  })

  // fetch_pot defaults to `auto`, which is yt-dlp deciding whether the chosen
  // client actually needs a token. overriding it would be us second-guessing
  // the one component that tracks youtube's rollout
  test("leaves the fetch policy at yt-dlp's own default", () => {
    expect(buildCommonArgs({ ...POT, potEnabled: true }).join(" ")).not.toContain(
      "fetch_pot"
    )
  })

  // the provider runs its generator on the js runtime we ship. without deno
  // there is nothing to run it, so asking for a token would only buy a warning
  test("stays quiet when there is no js runtime to mint with", () => {
    const args = buildCommonArgs({ ...POT, denoPath: null, potEnabled: true })

    expect(args).not.toContain("--plugin-dirs")
  })

  test("stays quiet when the payload has not been installed", () => {
    const args = buildCommonArgs({ ...PATHS, potEnabled: true })

    expect(args).not.toContain("--plugin-dirs")
  })

  // --no-js-runtimes must keep leading --js-runtimes. reversed, the runtime is
  // disabled after being named: the provider goes unavailable and yt-dlp's own
  // challenge solver dies with it. verified against 2026.08.19
  test("keeps the js runtime flags in the only order that works", () => {
    const args = buildCommonArgs({ ...POT, potEnabled: true })

    expect(
      containsSequence(args, [
        "--no-js-runtimes",
        "--js-runtimes",
        "deno:/res/binaries/deno/deno"
      ])
    ).toBe(true)
  })
})

describe("info args", () => {
  test("dumps json without downloading", () => {
    const args = buildArgs("info", { ...PATHS, url: "https://youtu.be/abc" })

    expect(args).toContain("--dump-json")
    expect(args).toContain("--no-download")
    expect(args).toContain("--no-playlist")
    expect(args[args.length - 1]).toBe("https://youtu.be/abc")
  })

  test("playlist info stays flat and bounded", () => {
    const args = buildArgs("playlist-info", {
      ...PATHS,
      url: "https://youtube.com/playlist?list=x",
      maxVideos: 25
    })

    expect(args).toContain("--flat-playlist")
    expect(valueAfter(args, "--playlist-items")).toBe("1:25")
  })

  test("playlist info defaults to 50 videos", () => {
    const args = buildArgs("playlist-info", { ...PATHS, url: "https://x" })
    expect(valueAfter(args, "--playlist-items")).toBe("1:50")
  })
})

describe("combined download args", () => {
  test("writes the file where the caller asked for it", () => {
    const args = buildArgs("combined", {
      ...PATHS,
      url: "https://youtu.be/abc",
      height: 720,
      container: "mp4",
      outputDir: "/downloads",
      outputTemplate: "video.%(ext)s"
    })

    expect(valueAfter(args, "-P")).toBe("/downloads")
    expect(valueAfter(args, "-o")).toBe("video.%(ext)s")
  })

  test("carries the progress and final-filename plumbing", () => {
    const args = buildArgs("combined", {
      ...PATHS,
      url: "https://youtu.be/abc",
      height: 1080,
      container: "mp4"
    })

    // --print implies --quiet, so --progress must be present for progress lines
    expect(args).toContain("--progress")
    expect(valueAfter(args, "--progress-template")).toBe(PROGRESS_TEMPLATE)
    expect(args.filter((arg) => arg === "--print")).toHaveLength(2)
    expect(args).toContain(STREAM_TEMPLATE)
    expect(args).toContain(FILE_TEMPLATE)
  })
})

describe("nothing that downloads is run quiet", () => {
  const OPERATION_PARAMS = {
    combined: { height: 720, container: "mp4" },
    audio: { audioMode: "mp3" },
    simple: { formatSelector: "best" }
  }

  /**
   * --print implies --quiet, and --quiet does not stop at yt-dlp: a trimmed
   * download runs on yt-dlp's ffmpeg downloader, which fetches the media over
   * https itself and inherits our quiet as `-loglevel quiet`. ffmpeg then runs
   * the whole download in silence - nothing for the no-output watchdog to see,
   * and a failure that arrives as "ffmpeg exited with code N" with ffmpeg's own
   * reason thrown away.
   *
   * so the rule is a pairing, not a flag: an operation that prints must also
   * say --no-quiet.
   */
  for (const [operation, extra] of Object.entries(OPERATION_PARAMS)) {
    test(`${operation} pairs --print with --no-quiet`, () => {
      const args = buildArgs(operation, {
        ...PATHS,
        ...extra,
        url: "https://youtu.be/abc",
        outputDir: "/downloads",
        outputTemplate: "out.%(ext)s"
      })

      expect(args).toContain("--print")
      expect(args).toContain("--no-quiet")
    })

    test(`${operation} stays audible when it is trimmed`, () => {
      const args = buildArgs(operation, {
        ...PATHS,
        ...extra,
        url: "https://youtu.be/abc",
        outputDir: "/downloads",
        outputTemplate: "out.%(ext)s",
        timeRange: { start: 5, end: 65 }
      })

      expect(args).toContain("--no-quiet")
      expect(args).not.toContain("--quiet")
    })
  }

  // the other half of the pairing: --dump-json hands stdout to JSON.parse, so
  // chatter there is not noise, it is a parse error. these two print no CLIPLY
  // markers and have no ffmpeg downloader behind them, so they stay quiet
  for (const operation of ["info", "playlist-info"]) {
    test(`${operation} is left quiet`, () => {
      const args = buildArgs(operation, { ...PATHS, url: "https://youtu.be/abc" })

      expect(args).toContain("--dump-json")
      expect(args).not.toContain("--print")
      expect(args).not.toContain("--no-quiet")
    })
  }
})

describe("quality tier download args", () => {
  const TIER = {
    ...PATHS,
    url: "https://youtu.be/abc",
    outputDir: "/downloads",
    outputTemplate: "%(title).120B_%(height)sp_%(epoch)s.%(ext)s"
  }

  test("an mp4 tier asks for the preset and the resolution sort", () => {
    const args = buildArgs("combined", { ...TIER, height: 720, container: "mp4" })

    expect(containsSequence(args, ["-t", "mp4", "-S", "res:720"])).toBe(true)
  })

  test("an mkv tier asks for the mkv preset", () => {
    const args = buildArgs("combined", { ...TIER, height: 2160, container: "mkv" })

    expect(containsSequence(args, ["-t", "mkv", "-S", "res:2160"])).toBe(true)
  })

  /**
   * the whole point of the revamp, verified against 2026.08.19:
   *   -t mp4 -S res:720 -> 298+140, h264 720p
   *   -S res:720 -t mp4 -> 299+140, h264 1080p
   * `-t mp4` expands to an -S of its own and the last -S on the line wins, so
   * a swapped order silently hands the user a different resolution
   */
  test("the preset is pushed BEFORE the -S sort, never after", () => {
    const args = buildArgs("combined", { ...TIER, height: 720, container: "mp4" })

    const preset = args.indexOf("-t")
    const sort = args.indexOf("-S")

    expect(preset).toBeGreaterThan(-1)
    expect(sort).toBeGreaterThan(-1)
    expect(preset).toBeLessThan(sort)
    expect(args[sort + 1]).toBe("res:720")
  })

  test("drops the forced --merge-output-format that broke mp4 audio", () => {
    const args = buildArgs("combined", { ...TIER, height: 1080, container: "mp4" })

    expect(args).not.toContain("--merge-output-format")
    expect(args).not.toContain("-f")
  })

  test("trim args are still appended after the tier flags", () => {
    const args = buildArgs("combined", {
      ...TIER,
      height: 720,
      container: "mp4",
      timeRange: { start: 30, end: 45 },
      preciseCut: true
    })

    expect(containsSequence(args, ["-t", "mp4", "-S", "res:720"])).toBe(true)
    expect(valueAfter(args, "--download-sections")).toBe("*30-45")
    expect(args).toContain("--force-keyframes-at-cuts")
  })

  test("a container we never offered falls back to mp4", () => {
    const args = buildArgs("combined", {
      ...TIER,
      height: 720,
      container: "--exec=rm -rf /"
    })

    expect(valueAfter(args, "-t")).toBe("mp4")
  })

  // no menu row can produce this, but a malformed payload must still leave a
  // complete instruction behind: "best, in a container that plays everywhere"
  test("a request with no height still asks for a real container", () => {
    const args = buildArgs("combined", { ...TIER })

    expect(valueAfter(args, "-t")).toBe("mp4")
    expect(args).not.toContain("-S")
    expect(args).not.toContain("-f")
  })

  test("a tier download expects a video stream and an audio stream", () => {
    expect(expectedStreamCount("combined", { height: 720, container: "mp4" })).toBe(2)
  })
})

describe("output filename args", () => {
  test("the sanitising flags ride along with the template", () => {
    const args = buildArgs("combined", {
      ...PATHS,
      url: "https://youtu.be/abc",
      height: 720,
      container: "mp4",
      outputDir: "/downloads",
      outputTemplate: "%(title).120B_%(height)sp_%(epoch)s.%(ext)s"
    })

    expect(args).toContain("--windows-filenames")
    expect(valueAfter(args, "--trim-filenames")).toBe("240")
  })
})

describe("trim args", () => {
  test("builds a download section from numeric seconds", () => {
    const args = buildTrimArgs({ timeRange: { start: 30, end: 45.5 } })
    expect(args).toEqual(["--download-sections", "*30-45.5"])
  })

  test("passes timestamp strings through untouched", () => {
    const args = buildTrimArgs({ timeRange: { start: "0:30", end: "1:15" } })
    expect(args).toEqual(["--download-sections", "*0:30-1:15"])
  })

  test("adds keyframe forcing only for precise cuts", () => {
    expect(buildTrimArgs({ timeRange: { start: 0, end: 5 } })).not.toContain(
      "--force-keyframes-at-cuts"
    )
    expect(
      buildTrimArgs({ timeRange: { start: 0, end: 5 }, preciseCut: true })
    ).toContain("--force-keyframes-at-cuts")
  })

  test("is empty without a time range", () => {
    expect(buildTrimArgs({})).toEqual([])
  })

  test("reaches the combined download args", () => {
    const args = buildArgs("combined", {
      ...PATHS,
      url: "https://youtu.be/abc",
      height: 1080,
      container: "mp4",
      timeRange: { start: 30, end: 45 },
      preciseCut: true
    })

    expect(valueAfter(args, "--download-sections")).toBe("*30-45")
    expect(args).toContain("--force-keyframes-at-cuts")
  })
})

describe("audio mode args", () => {
  const AUDIO = {
    ...PATHS,
    url: "https://youtu.be/abc",
    outputDir: "/downloads",
    outputTemplate: "%(title).120B_audio_%(epoch)s.%(ext)s"
  }

  // -t mp3 is 'ba[acodec^=mp3]/ba/b -x --audio-format mp3' - selector,
  // extraction and container in one, so we add none of them ourselves
  test("mp3 uses the native preset", () => {
    const args = buildArgs("audio", { ...AUDIO, audioMode: "mp3" })

    expect(valueAfter(args, "-t")).toBe("mp3")
    expect(args).not.toContain("-f")
    expect(args).not.toContain("--extract-audio")
    expect(args).not.toContain("--audio-format")
  })

  test("m4a maps onto the aac preset", () => {
    const args = buildArgs("audio", { ...AUDIO, audioMode: "m4a" })

    expect(valueAfter(args, "-t")).toBe("aac")
    expect(args).not.toContain("-f")
  })

  // "original" is the absence of a preset: whatever youtube served, untouched
  test("original takes the best audio stream without extracting it", () => {
    const args = buildArgs("audio", { ...AUDIO, audioMode: "original" })

    expect(valueAfter(args, "-f")).toBe("ba/b")
    expect(args).not.toContain("-t")
    expect(args).not.toContain("--extract-audio")
  })

  test("trim args are still appended to a mode download", () => {
    const args = buildArgs("audio", {
      ...AUDIO,
      audioMode: "mp3",
      timeRange: { start: 5, end: 12 },
      preciseCut: true
    })

    expect(valueAfter(args, "-t")).toBe("mp3")
    expect(valueAfter(args, "--download-sections")).toBe("*5-12")
    expect(args).toContain("--force-keyframes-at-cuts")
  })

  // the menu offers three modes and nothing else, so anything unrecognised is
  // a malformed payload - it gets the universal container rather than a guess
  test("a mode we never offered falls back to mp3", () => {
    expect(valueAfter(buildArgs("audio", { ...AUDIO, audioMode: "flac" }), "-t")).toBe("mp3")
    expect(valueAfter(buildArgs("audio", { ...AUDIO }), "-t")).toBe("mp3")
  })
})

/**
 * language is a FILTER field, not a sort field
 *
 * `-S lang:hi` is silently ignored - verified against 2026.08.19, it returns
 * the original track and prints no error - so this is the one place the
 * "sorting only, never filters" rule is broken on purpose, and the `/b`
 * fallback tail is what keeps it from hard-failing.
 *
 * nothing here asserts on a format id: the -N suffixes (140-2, 251-12) are
 * assigned per response and shift between calls.
 */
describe("audio language args", () => {
  const TIER = {
    ...PATHS,
    url: "https://youtu.be/abc",
    outputDir: "/downloads",
    outputTemplate: "%(title).120B_%(height)sp_%(epoch)s.%(ext)s"
  }
  const AUDIO = {
    ...PATHS,
    url: "https://youtu.be/abc",
    outputDir: "/downloads",
    outputTemplate: "%(title).120B_audio_%(epoch)s.%(ext)s"
  }

  test("a video download pins the language with a fallback tail", () => {
    const args = buildArgs("combined", {
      ...TIER,
      height: 720,
      container: "mp4",
      audioLanguage: "hi"
    })

    expect(valueAfter(args, "-f")).toBe("bv*+ba[language=hi]/bv*+ba/b")
  })

  // -t expands to an -S of its own and the last -S wins, so the tier flags
  // keep the exact order ticket 1 verified - the -f only follows them
  test("the tier flags keep their verified order ahead of the selector", () => {
    const args = buildArgs("combined", {
      ...TIER,
      height: 1080,
      container: "mkv",
      audioLanguage: "ja"
    })

    expect(containsSequence(args, ["-t", "mkv", "-S", "res:1080"])).toBe(true)
    expect(args.indexOf("-S")).toBeLessThan(args.indexOf("-f"))
  })

  test("both containers carry the language the same way", () => {
    for (const container of ["mp4", "mkv"]) {
      const args = buildArgs("combined", {
        ...TIER,
        height: 720,
        container,
        audioLanguage: "de"
      })

      expect(valueAfter(args, "-t")).toBe(container)
      expect(valueAfter(args, "-f")).toBe("bv*+ba[language=de]/bv*+ba/b")
    }
  })

  // -t mp3 / -t aac carry their own selector; a later -f replaces just that,
  // leaving the extraction and container flags the preset brought with it
  test("a converted audio mode keeps its preset and takes the selector", () => {
    for (const [mode, preset] of [
      ["mp3", "mp3"],
      ["m4a", "aac"]
    ]) {
      const args = buildArgs("audio", { ...AUDIO, audioMode: mode, audioLanguage: "hi" })

      expect(valueAfter(args, "-t")).toBe(preset)
      expect(valueAfter(args, "-f")).toBe("ba[language=hi]/ba/b")
      expect(args.indexOf("-t")).toBeLessThan(args.indexOf("-f"))
    }
  })

  test("original audio swaps its selector for the language one", () => {
    const args = buildArgs("audio", {
      ...AUDIO,
      audioMode: "original",
      audioLanguage: "ko"
    })

    expect(args.filter((arg) => arg === "-f")).toHaveLength(1)
    expect(valueAfter(args, "-f")).toBe("ba[language=ko]/ba/b")
    expect(args).not.toContain("-t")
  })

  // zh-Hans and zh-Hant are separate tracks a prefix match would collide, so
  // the code goes in whole and the comparison is `=`
  test("a regional tag goes in whole, matched exactly", () => {
    const args = buildArgs("audio", {
      ...AUDIO,
      audioMode: "original",
      audioLanguage: "zh-Hant"
    })

    expect(valueAfter(args, "-f")).toBe("ba[language=zh-Hant]/ba/b")
    expect(args.join(" ")).not.toContain("^=")
  })

  /**
   * THE test for this feature. nearly every video has one audio language, and
   * on those the renderer sends no code at all - so the args have to come out
   * byte for byte identical to what they were before the picker existed.
   */
  test("without a language, every download is byte-identical to today's", () => {
    const cases = [
      ["combined", { ...TIER, height: 720, container: "mp4" }],
      ["combined", { ...TIER, height: 2160, container: "mkv" }],
      [
        "combined",
        { ...TIER, height: 720, container: "mp4", timeRange: { start: 30, end: 45 }, preciseCut: true }
      ],
      ["audio", { ...AUDIO, audioMode: "mp3" }],
      ["audio", { ...AUDIO, audioMode: "m4a" }],
      ["audio", { ...AUDIO, audioMode: "original" }]
    ]

    for (const [operation, params] of cases) {
      const baseline = buildArgs(operation, params)

      // the three shapes a request with no choice of dubs can arrive in
      for (const absent of [{}, { audioLanguage: null }, { audioLanguage: undefined }]) {
        expect(buildArgs(operation, { ...params, ...absent })).toEqual(baseline)
      }
    }

    // and the one that must not have grown an -f: a plain tier download
    expect(buildArgs("combined", { ...TIER, height: 720, container: "mp4" })).not.toContain("-f")
  })

  /**
   * the code is interpolated straight into a format expression, so anything
   * that is not a language tag is dropped and the download falls back to no
   * filter at all - the same reasoning as the TIER_CONTAINERS whitelist
   */
  test("a malformed code never reaches the format expression", () => {
    const hostile = [
      "hi]/bv*+ba[language=ko",
      "en'; rm -rf /",
      "en_US",
      "e",
      "",
      "  ",
      "abcdefghijklmnopq",
      null,
      42,
      { code: "hi" }
    ]

    for (const audioLanguage of hostile) {
      const combined = buildArgs("combined", {
        ...TIER,
        height: 720,
        container: "mp4",
        audioLanguage
      })
      const audio = buildArgs("audio", { ...AUDIO, audioMode: "mp3", audioLanguage })

      expect(combined).not.toContain("-f")
      expect(audio).not.toContain("-f")
      expect(combined).toEqual(
        buildArgs("combined", { ...TIER, height: 720, container: "mp4" })
      )
    }
  })

  test("the codes yt-dlp really reports all pass", () => {
    for (const code of ["hi", "en", "pt-BR", "zh-Hans", "zh-Hant", "fil"]) {
      expect(normalizeAudioLanguage({ audioLanguage: code })).toBe(code)
    }

    // surrounding whitespace is a payload artefact, not part of the tag
    expect(normalizeAudioLanguage({ audioLanguage: " hi " })).toBe("hi")
    expect(normalizeAudioLanguage({})).toBeNull()
  })

  test("a simple-platform download never grows a language filter", () => {
    const args = buildArgs("simple", {
      ...PATHS,
      url: "https://tiktok.com/@a/video/1",
      outputDir: "/downloads",
      audioLanguage: "hi"
    })

    expect(valueAfter(args, "-f")).toBe("best")
    expect(args.filter((arg) => arg === "-f")).toHaveLength(1)
  })
})

describe("simple platform args", () => {
  test("uses -f best with no format picking", () => {
    const args = buildArgs("simple", {
      ...PATHS,
      url: "https://tiktok.com/@a/video/1",
      outputDir: "/downloads"
    })

    expect(valueAfter(args, "-f")).toBe("best")
    expect(args).not.toContain("--merge-output-format")
    expect(args[args.length - 1]).toBe("https://tiktok.com/@a/video/1")
  })
})

describe("unknown operations", () => {
  test("throw rather than spawning something arbitrary", () => {
    expect(() => buildArgs("nonsense", { url: "https://x" })).toThrow(
      /Unknown yt-dlp operation/
    )
  })
})

describe("url handling", () => {
  // yt-dlp parses any leading-dash operand as an option: passing "--version"
  // as the url really does print the version instead of failing
  const OPERATIONS = ["info", "playlist-info", "combined", "audio", "simple"]

  test.each(OPERATIONS)("%s puts -- immediately before the url", (operation) => {
    const args = buildArgs(operation, { ...PATHS, url: "https://youtu.be/abc" })

    expect(args[args.length - 2]).toBe("--")
    expect(args[args.length - 1]).toBe("https://youtu.be/abc")
  })

  test("a dash-prefixed url stays an operand, never an option", () => {
    const hostile = "--exec=touch /tmp/pwned"
    const args = buildArgs("info", { ...PATHS, url: `https://x/${hostile}` })

    expect(args[args.length - 2]).toBe("--")
    expect(args.indexOf("--")).toBe(args.length - 2)
  })

  test("trusted extra args stay on the option side of the separator", () => {
    const args = buildArgs("info", {
      ...PATHS,
      url: "https://youtu.be/abc",
      extraArgs: ["--playlist-items", "1"]
    })

    expect(args.indexOf("--playlist-items")).toBeLessThan(args.indexOf("--"))
  })

  test("rejects anything that is not an http(s) url", () => {
    expect(() => normalizeUrl("--exec=touch /tmp/pwned")).toThrow(
      /doesn't look like a valid link/
    )
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/http and https/)
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow(/http and https/)
    expect(() => normalizeUrl("")).toThrow(/required/)
    expect(() => normalizeUrl(undefined)).toThrow(/required/)
  })

  test("tags rejections with INVALID_URL so the ipc layer can map them", () => {
    expect.assertions(1)
    try {
      normalizeUrl("-not-a-url")
    } catch (error) {
      expect(error.code).toBe(ERROR_CODES.INVALID_URL)
    }
  })

  test("accepts and trims ordinary links", () => {
    expect(normalizeUrl("  https://www.youtube.com/watch?v=abc  ")).toBe(
      "https://www.youtube.com/watch?v=abc"
    )
    expect(normalizeUrl("http://tiktok.com/@a/video/1")).toBe(
      "http://tiktok.com/@a/video/1"
    )
  })

  test("building args for a hostile url throws instead of spawning", () => {
    expect(() => buildArgs("combined", { ...PATHS, url: "--help" })).toThrow(
      /valid link/
    )
  })
})

describe("operation gate", () => {
  test("lets concurrent downloads share the read side", async () => {
    const gate = new OperationGate()

    const first = await gate.acquireRead()
    const second = await gate.acquireRead()

    expect(gate.readers).toBe(2)

    first()
    second()
    expect(gate.isBusy()).toBe(false)
  })

  test("refuses a write while any download holds a read", async () => {
    const gate = new OperationGate()
    const release = await gate.acquireRead()

    expect(gate.tryAcquireWrite()).toBeNull()

    release()
    expect(gate.tryAcquireWrite()).not.toBeNull()
  })

  test("refuses a second write", () => {
    const gate = new OperationGate()

    expect(gate.tryAcquireWrite()).not.toBeNull()
    expect(gate.tryAcquireWrite()).toBeNull()
  })

  test("queues downloads behind an in-flight update instead of failing them", async () => {
    const gate = new OperationGate()
    const releaseWrite = gate.tryAcquireWrite()

    let granted = false
    const pending = gate.acquireRead().then((release) => {
      granted = true
      return release
    })

    await Promise.resolve()
    expect(granted).toBe(false)

    releaseWrite()
    await pending
    expect(granted).toBe(true)
  })

  test("releasing twice does not corrupt the reader count", async () => {
    const gate = new OperationGate()
    const release = await gate.acquireRead()

    release()
    release()

    expect(gate.readers).toBe(0)
    expect(gate.tryAcquireWrite()).not.toBeNull()
  })
})

describe("expected stream count", () => {
  // the opening guess only has to be close: the CLIPLY_STREAM marker corrects
  // it from the format yt-dlp really chose before the bar moves
  test("a video download expects a video stream and an audio stream", () => {
    expect(expectedStreamCount("combined", { height: 720, container: "mp4" })).toBe(2)
  })

  test("counts one stream for audio-only and simple-platform operations", () => {
    expect(expectedStreamCount("audio", { audioMode: "mp3" })).toBe(1)
    expect(expectedStreamCount("simple", {})).toBe(1)
  })

  test("a trimmed download is one ffmpeg pass no matter how many formats", () => {
    expect(
      expectedStreamCount("combined", {
        height: 720,
        container: "mp4",
        timeRange: { start: 5, end: 12 }
      })
    ).toBe(1)
  })
})

describe("stream marker parsing", () => {
  test("counts the formats yt-dlp actually chose", () => {
    expect(parseStreamCountLine("CLIPLY_STREAM|160+139")).toBe(2)
    expect(parseStreamCountLine("CLIPLY_STREAM|18")).toBe(1)
  })

  test("ignores other lines", () => {
    expect(parseStreamCountLine("CLIPLY| 10.0%|1MiB/s|00:01|1")).toBeNull()
    expect(parseStreamCountLine("CLIPLY_STREAM|")).toBeNull()
  })

  test("corrects a wrong guess before the bar moves", () => {
    const tracker = new ProgressTracker(2)

    // the "auto" guess said two streams, but yt-dlp picked a pre-muxed format
    tracker.setExpectedStreams(parseStreamCountLine("CLIPLY_STREAM|18"))

    expect(tracker.update({ progress: 50 }).progress).toBe(50)
  })

  test("never drops below the streams already seen", () => {
    const tracker = new ProgressTracker(2)

    tracker.update({ progress: 100 })
    tracker.update({ progress: 0 })
    tracker.setExpectedStreams(1)

    expect(tracker.expectedStreams).toBe(2)
  })
})

describe("progress line parsing", () => {
  test("parses a normal progress line", () => {
    expect(parseProgressLine("CLIPLY| 42.0%|   3.79MiB/s|00:35|35")).toEqual({
      progress: 42,
      speed: "3.79MiB/s",
      eta: "00:35",
      etaSeconds: 35
    })
  })

  test("treats yt-dlp's unknown placeholders as missing values", () => {
    expect(parseProgressLine("CLIPLY|  0.0%| Unknown B/s|Unknown|NA")).toEqual({
      progress: 0,
      speed: null,
      eta: null,
      etaSeconds: null
    })
  })

  test("strips colour codes", () => {
    const line = `\u001b[0;94mCLIPLY|100.0%|3.65MiB/s|00:00|0\u001b[0m`
    expect(parseProgressLine(line).progress).toBe(100)
  })

  test("ignores lines that are not ours", () => {
    expect(parseProgressLine("[download] Destination: /tmp/a.mp4")).toBeNull()
    expect(parseProgressLine("")).toBeNull()
    expect(parseProgressLine("CLIPLY|not-a-number|x|y|z")).toBeNull()
  })
})

describe("destination parsing", () => {
  test("reads the after_move print line", () => {
    expect(parseDestinationLine("CLIPLY_FILE|/downloads/clip.mp4")).toBe(
      "/downloads/clip.mp4"
    )
  })

  test("falls back to yt-dlp's own destination lines", () => {
    expect(parseDestinationLine("[download] Destination: /downloads/a.mp4")).toBe(
      "/downloads/a.mp4"
    )
    expect(parseDestinationLine("[ExtractAudio] Destination: /downloads/a.mp3")).toBe(
      "/downloads/a.mp3"
    )
    expect(
      parseDestinationLine('[Merger] Merging formats into "/downloads/a.mp4"')
    ).toBe("/downloads/a.mp4")
    expect(
      parseDestinationLine("[download] /downloads/a.mp4 has already been downloaded")
    ).toBe("/downloads/a.mp4")
  })

  test("ignores unrelated lines", () => {
    expect(parseDestinationLine("CLIPLY| 12.0%|1MiB/s|00:01|1")).toBeNull()
    expect(parseDestinationLine("[youtube] Extracting URL: https://x")).toBeNull()
  })
})

describe("progress tracker", () => {
  test("normalises the two sweeps of a video+audio download", () => {
    const tracker = new ProgressTracker(2)

    expect(tracker.update({ progress: 50 }).progress).toBe(25)
    expect(tracker.update({ progress: 100 }).progress).toBe(50)

    // audio stream restarts at 0% - the bar must not jump backwards
    const restart = tracker.update({ progress: 0 })
    expect(restart.streamIndex).toBe(1)
    expect(restart.progress).toBe(50)

    expect(tracker.update({ progress: 100 }).progress).toBe(100)
  })

  test("passes a single stream straight through", () => {
    const tracker = new ProgressTracker(1)

    expect(tracker.update({ progress: 33.3 }).progress).toBe(33.3)
    expect(tracker.update({ progress: 99 }).progress).toBe(99)
  })

  test("never reports a lower percentage than before", () => {
    const tracker = new ProgressTracker(1)

    expect(tracker.update({ progress: 80 }).progress).toBe(80)
    expect(tracker.update({ progress: 5 }).progress).toBe(80)
  })

  test("keeps speed and eta from the parsed line", () => {
    const update = new ProgressTracker(1).update({
      progress: 10,
      speed: "1.00MiB/s",
      eta: "00:10",
      etaSeconds: 10
    })

    expect(update.speed).toBe("1.00MiB/s")
    expect(update.eta).toBe("00:10")
    expect(update.etaSeconds).toBe(10)
  })
})

describe("error mapping", () => {
  const map = (line) => mapError({ exitCode: 1, stderrLines: [line] })

  test("bot detection asks for cookies", () => {
    const result = map(
      "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser"
    )

    expect(result.code).toBe(ERROR_CODES.BOT_DETECTION)
    expect(result.needsCookies).toBe(true)
  })

  test("unavailable and private videos map to the friendly message", () => {
    expect(map("ERROR: [youtube] abc: Video unavailable").code).toBe(
      ERROR_CODES.VIDEO_UNAVAILABLE
    )
    // the wording youtube actually returned for a bogus id in august 2026
    expect(map("ERROR: [youtube] aaaaaaaaaaa: This video is unavailable").code).toBe(
      ERROR_CODES.VIDEO_UNAVAILABLE
    )
    expect(map("ERROR: [youtube] abc: Private video. Sign in").code).toBe(
      ERROR_CODES.VIDEO_UNAVAILABLE
    )
    expect(
      map("ERROR: [youtube] abc: Sign in to confirm your age").code
    ).toBe(ERROR_CODES.VIDEO_UNAVAILABLE)
  })

  test("a geo block is its own code, not a generic unavailable video", () => {
    // the taxonomy split these apart: "not available in your country" is worth
    // telling the user about specifically, and it used to read as "removed"
    const result = map(
      "ERROR: [youtube] abc: The uploader has not made this video available in your country"
    )

    expect(result.code).toBe(ERROR_CODES.GEO_BLOCKED)
    expect(result.message).toContain("your country")
  })

  test("ffmpeg causes we can act on get their own codes", () => {
    expect(map("ERROR: Postprocessing: ffmpeg not found").code).toBe(
      ERROR_CODES.FFMPEG_MISSING
    )
    expect(map("ERROR: Postprocessing: moov atom not found").code).toBe(
      ERROR_CODES.FFMPEG_CORRUPT_STREAM
    )
  })

  test("network failures are retryable", () => {
    const result = map(
      "ERROR: unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>"
    )

    expect(result.code).toBe(ERROR_CODES.NETWORK_ERROR)
    expect(result.retryable).toBe(true)
  })

  // a throttled connection is the one failure where our own advice made the
  // problem worse: NETWORK_ERROR told the user to retry, and retrying is what
  // deepens a rate limit. it must not be retryable, and it must not blame the
  // user's connection - theirs is fine, it is youtube refusing us
  test("rate limiting is not retryable and does not blame the connection", () => {
    const result = map(
      "ERROR: unable to download webpage: HTTP Error 429: Too Many Requests"
    )

    expect(result.code).toBe(ERROR_CODES.RATE_LIMITED)
    expect(result.retryable).toBe(false)
    expect(`${result.message} ${result.suggestion}`).not.toMatch(/connection/i)
  })

  test("extraction failures are the ones an update can fix", () => {
    const result = map("ERROR: [youtube] abc: nsig extraction failed: Some players may fail")

    expect(result.code).toBe(ERROR_CODES.EXTRACTION_FAILED)
    expect(result.updateMayFix).toBe(true)
  })

  test("disk and permission failures keep their own codes", () => {
    expect(map("ERROR: unable to write data: [Errno 28] No space left on device").code).toBe(
      ERROR_CODES.DISK_FULL
    )
    expect(map("ERROR: unable to open for writing: Permission denied").code).toBe(
      ERROR_CODES.PERMISSION_ERROR
    )
  })

  test("ffmpeg failures map to a processing error", () => {
    expect(map("ERROR: Postprocessing: ffmpeg exited with code 1").code).toBe(
      ERROR_CODES.FFMPEG_ERROR
    )
  })

  test("anything unrecognised is a generic failure that keeps the detail", () => {
    const result = map("ERROR: something nobody has seen before")

    expect(result.code).toBe(ERROR_CODES.DOWNLOAD_FAILED)
    expect(result.details).toContain("something nobody has seen before")
    expect(result.retryable).toBe(false)
  })

  test("cancellation and stalls short-circuit the pattern table", () => {
    expect(
      mapError({ cancelled: true, stderrLines: ["ERROR: Video unavailable"] }).code
    ).toBe(ERROR_CODES.CANCELLED)
    expect(
      mapError({ stalled: true, stderrLines: ["ERROR: Video unavailable"] }).code
    ).toBe(ERROR_CODES.STALLED)
  })

  test("picks the last ERROR line as the technical detail", () => {
    const result = mapError({
      exitCode: 1,
      stderrLines: [
        "[debug] noise",
        "ERROR: first problem",
        "ERROR: the real problem"
      ]
    })

    expect(result.details).toBe("ERROR: the real problem")
  })

  test("bot detection wins over the unavailable patterns", () => {
    const result = mapError({
      exitCode: 1,
      stderrLines: [
        "ERROR: Video unavailable",
        "ERROR: Sign in to confirm you're not a bot"
      ]
    })

    expect(result.code).toBe(ERROR_CODES.BOT_DETECTION)
  })
})

describe("log redaction", () => {
  test("removes the user's home folder", () => {
    const line = redactLogLine(`writing to ${path.join(os.homedir(), "Downloads", "a.mp4")}`)

    expect(line).not.toContain(os.homedir())
    expect(line).toContain("~")
  })

  test("removes signed media urls, which carry the user's ip", () => {
    const line = redactLogLine(
      "Input #0 from 'https://rr1.googlevideo.com/videoplayback?expire=1&ip=2405%3A201&sig=abc'"
    )

    expect(line).not.toContain("ip=2405")
    expect(line).toContain("<redacted>")
  })

  test("redacts other platforms' home folders too", () => {
    expect(redactLogLine("/home/someone/dl/a.mp4")).toBe("/home/~/dl/a.mp4")
    expect(redactLogLine("C:\\Users\\Someone\\dl")).toBe("C:\\Users\\~\\dl")
  })
})

describe("stderr ring buffer", () => {
  test("keeps only the most recent lines", () => {
    const buffer = new RingBuffer(3)

    buffer.push("one")
    buffer.push("two")
    buffer.push("three")
    buffer.push("four")

    expect(buffer.tail()).toEqual(["two", "three", "four"])
    expect(buffer.toString()).toBe("two\nthree\nfour")
  })

  test("defaults to the documented 200-line window", () => {
    const buffer = new RingBuffer()

    for (let index = 0; index < STDERR_BUFFER_LINES + 50; index++) {
      buffer.push(`line ${index}`)
    }

    expect(buffer.tail()).toHaveLength(STDERR_BUFFER_LINES)
    expect(buffer.tail()[0]).toBe("line 50")
  })
})

describe("line splitter", () => {
  test("holds back partial lines until they complete", () => {
    const lines = []
    const splitter = new LineSplitter((line) => lines.push(line))

    splitter.push("CLIPLY| 10.0%|1MiB/s|00:01|1\nCLIP")
    expect(lines).toEqual(["CLIPLY| 10.0%|1MiB/s|00:01|1"])

    splitter.push("LY| 20.0%|1MiB/s|00:01|1\n")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe("CLIPLY| 20.0%|1MiB/s|00:01|1")

    splitter.push("trailing")
    splitter.flush()
    expect(lines[2]).toBe("trailing")
  })
})

describe("cookie file detection", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-cookies-"))

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test("an empty netscape file does not count as cookies", () => {
    const file = path.join(tempDir, "empty.txt")
    fs.writeFileSync(file, "# Netscape HTTP Cookie File\n# generated\n\n")

    expect(cookieFileHasEntries(file)).toBe(false)
  })

  test("a file with a real entry does", () => {
    const file = path.join(tempDir, "full.txt")
    fs.writeFileSync(
      file,
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue\n"
    )

    expect(cookieFileHasEntries(file)).toBe(true)
  })

  test("a missing file does not throw", () => {
    expect(cookieFileHasEntries(path.join(tempDir, "nope.txt"))).toBe(false)
  })

  // "#HttpOnly_" looks like a comment but prefixes a real cookie, and that is
  // where youtube keeps its auth cookies. When the engine skipped these and the
  // cookie manager did not, an http-only jar showed as loaded in the ui while
  // downloads silently ran without --cookies.
  test("an http-only jar counts as cookies", () => {
    const file = path.join(tempDir, "httponly.txt")
    fs.writeFileSync(
      file,
      "# Netscape HTTP Cookie File\n" +
        "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-1PSID\tvalue\n"
    )

    expect(cookieFileHasEntries(file)).toBe(true)
  })

  test("the engine and the cookie manager agree about an http-only jar", async () => {
    const CookieManager = require("../src/main/services/cookie-manager")
    const { YtdlpEngine } = require("../src/main/services/ytdlp-engine")
    const jar = path.join(tempDir, "manager-httponly.txt")

    fs.writeFileSync(
      jar,
      "# Netscape HTTP Cookie File\n" +
        "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-1PSID\tvalue\n"
    )

    const manager = new CookieManager()
    manager.cookieDir = tempDir
    manager.cookieFile = jar
    manager.statusFile = path.join(tempDir, "manager-status.json")
    await manager.refresh()

    // the manager says the user has a usable login...
    expect(manager.hasValidCookies()).toBe(true)

    const engine = new YtdlpEngine({
      userDataPath: tempDir,
      resourcesPath: tempDir,
      cookieManager: manager
    })

    // ...and the engine actually sends it
    expect(engine.getCookieFile()).toBe(jar)
    expect(buildCommonArgs({ cookieFile: engine.getCookieFile() })).toContain(
      "--cookies"
    )
  })
})

describe("locating the po token payload", () => {
  const { YtdlpEngine } = require("../src/main/services/ytdlp-engine")
  let tempDir

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-pot-"))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // both halves are needed to mint anything: the plugin is what yt-dlp loads,
  // the server is what the plugin runs. half an install is not an install
  function seed(base, parts = ["plugin", "server"]) {
    for (const part of parts) {
      fs.mkdirSync(path.join(base, "pot", part), { recursive: true })
    }
  }

  test("finds nothing when the payload was never installed", () => {
    const engine = new YtdlpEngine({
      userDataPath: tempDir,
      resourcesPath: tempDir
    })

    expect(engine.getPotPaths()).toBeNull()
  })

  test("uses the copy that ships with the app", () => {
    const resources = path.join(tempDir, "resources")
    seed(path.join(resources, "binaries"))

    const engine = new YtdlpEngine({
      userDataPath: path.join(tempDir, "userdata"),
      resourcesPath: resources
    })

    expect(engine.getPotPaths()).toEqual({
      pluginDir: path.join(resources, "binaries", "pot", "plugin"),
      serverHome: path.join(resources, "binaries", "pot", "server")
    })
  })

  // the payload can also arrive after install, downloaded only by the users who
  // turn out to need it. a downloaded copy is the newer one, so it wins - the
  // same precedence getBinaryPath() already uses for the engine itself
  test("prefers a downloaded copy over the bundled one", () => {
    const resources = path.join(tempDir, "resources")
    const userData = path.join(tempDir, "userdata")
    seed(path.join(resources, "binaries"))
    seed(userData)

    const engine = new YtdlpEngine({
      userDataPath: userData,
      resourcesPath: resources
    })

    expect(engine.getPotPaths().pluginDir).toBe(
      path.join(userData, "pot", "plugin")
    )
  })

  test("refuses a half-installed payload rather than minting with part of it", () => {
    const userData = path.join(tempDir, "userdata")
    seed(userData, ["plugin"])

    const engine = new YtdlpEngine({
      userDataPath: userData,
      resourcesPath: path.join(tempDir, "resources")
    })

    expect(engine.getPotPaths()).toBeNull()
  })
})
