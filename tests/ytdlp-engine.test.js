// unit tests for the yt-dlp engine: arg building, progress parsing, error mapping

const os = require("os")
const fs = require("fs")
const path = require("path")

const {
  buildArgs,
  buildCommonArgs,
  buildTrimArgs,
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

describe("common args", () => {
  test("wires up deno, ffmpeg and the quiet/newline flags", () => {
    const args = buildCommonArgs(PATHS)

    expect(args).toContain("--no-js-runtimes")
    expect(valueAfter(args, "--js-runtimes")).toBe("deno:/res/binaries/deno/deno")
    expect(valueAfter(args, "--ffmpeg-location")).toBe("/res/binaries/ffmpeg")
    expect(args).toContain("--no-warnings")
    expect(args).toContain("--newline")
  })

  test("ports the python retry counts", () => {
    const args = buildCommonArgs(PATHS)

    expect(valueAfter(args, "--retries")).toBe("1")
    expect(valueAfter(args, "--extractor-retries")).toBe("1")
    expect(valueAfter(args, "--fragment-retries")).toBe("2")
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
  test("maps preset ids through the ported format selectors", () => {
    const args = buildArgs("combined", {
      ...PATHS,
      url: "https://youtu.be/abc",
      videoFormatId: "hd_720p",
      audioFormatId: "auto_audio",
      outputDir: "/downloads",
      outputTemplate: "video.%(ext)s"
    })

    expect(valueAfter(args, "-f")).toBe("bestvideo[height<=720]+bestaudio")
    expect(valueAfter(args, "--merge-output-format")).toBe("mp4")
    expect(valueAfter(args, "-P")).toBe("/downloads")
    expect(valueAfter(args, "-o")).toBe("video.%(ext)s")
  })

  test("auto omits -f entirely, like the python path did", () => {
    const args = buildArgs("combined", {
      ...PATHS,
      url: "https://youtu.be/abc",
      videoFormatId: "auto",
      audioFormatId: "auto_audio"
    })

    expect(args).not.toContain("-f")
  })

  test("raw format ids from --dump-json are merged", () => {
    const args = buildArgs("combined", {
      ...PATHS,
      url: "https://youtu.be/abc",
      videoFormatId: "133",
      audioFormatId: "139"
    })

    expect(valueAfter(args, "-f")).toBe("133+139")
  })

  test("carries the progress and final-filename plumbing", () => {
    const args = buildArgs("combined", {
      ...PATHS,
      url: "https://youtu.be/abc",
      videoFormatId: "best_quality",
      audioFormatId: "auto_audio"
    })

    // --print implies --quiet, so --progress must be present for progress lines
    expect(args).toContain("--progress")
    expect(valueAfter(args, "--progress-template")).toBe(PROGRESS_TEMPLATE)
    expect(args.filter((arg) => arg === "--print")).toHaveLength(2)
    expect(args).toContain(STREAM_TEMPLATE)
    expect(args).toContain(FILE_TEMPLATE)
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
      videoFormatId: "auto",
      audioFormatId: "auto_audio",
      timeRange: { start: 30, end: 45 },
      preciseCut: true
    })

    expect(valueAfter(args, "--download-sections")).toBe("*30-45")
    expect(args).toContain("--force-keyframes-at-cuts")
  })
})

describe("audio args", () => {
  test("keeps the source container when no target format is asked for", () => {
    const args = buildArgs("audio", {
      ...PATHS,
      url: "https://youtu.be/abc",
      audioFormatId: "medium_audio"
    })

    expect(valueAfter(args, "-f")).toBe("bestaudio[abr<=128]")
    expect(args).not.toContain("--extract-audio")
  })

  test("extracts to the requested audio format", () => {
    const args = buildArgs("audio", {
      ...PATHS,
      url: "https://youtu.be/abc",
      audioFormatId: "auto_audio",
      audioFormat: "mp3"
    })

    expect(args).toContain("--extract-audio")
    expect(valueAfter(args, "--audio-format")).toBe("mp3")
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
  test("counts two streams for merged selectors and auto", () => {
    expect(
      expectedStreamCount("combined", { videoFormatId: "hd_720p", audioFormatId: "auto_audio" })
    ).toBe(2)
    expect(
      expectedStreamCount("combined", { videoFormatId: "auto", audioFormatId: "auto_audio" })
    ).toBe(2)
  })

  test("counts one stream for pre-muxed and audio-only operations", () => {
    expect(expectedStreamCount("combined", { formatSelector: "best" })).toBe(1)
    expect(expectedStreamCount("audio", {})).toBe(1)
    expect(expectedStreamCount("simple", {})).toBe(1)
  })

  test("a trimmed download is one ffmpeg pass no matter how many formats", () => {
    expect(
      expectedStreamCount("combined", {
        videoFormatId: "hd_720p",
        audioFormatId: "auto_audio",
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
    expect(
      map(
        "ERROR: [youtube] abc: The uploader has not made this video available in your country"
      ).code
    ).toBe(ERROR_CODES.VIDEO_UNAVAILABLE)
    expect(map("ERROR: [youtube] abc: Private video. Sign in").code).toBe(
      ERROR_CODES.VIDEO_UNAVAILABLE
    )
    expect(
      map("ERROR: [youtube] abc: Sign in to confirm your age").code
    ).toBe(ERROR_CODES.VIDEO_UNAVAILABLE)
  })

  test("network failures are retryable", () => {
    const result = map(
      "ERROR: unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>"
    )

    expect(result.code).toBe(ERROR_CODES.NETWORK_ERROR)
    expect(result.retryable).toBe(true)
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
