/**
 * yt-dlp engine - spawns the standalone yt-dlp binary, one process per operation
 * replaces the python fastapi server: arg building, progress parsing,
 * stderr capture and error mapping all live here
 */

const { spawn } = require("child_process")
const { EventEmitter } = require("events")
const fs = require("fs")
const os = require("os")
const path = require("path")

// shared with the cookie manager on purpose: when the two disagreed about
// "#HttpOnly_" lines, downloads dropped a jar the ui called loaded
const { cookieFileHasEntries } = require("../utils/cookie-jar")

// stdout is machine-readable only: --print implies --quiet, so the only lines
// yt-dlp writes are our two prefixed templates (verified against 2026.08.19)
const PROGRESS_PREFIX = "CLIPLY|"
const FILE_PREFIX = "CLIPLY_FILE|"
const STREAM_PREFIX = "CLIPLY_STREAM|"
const PROGRESS_TEMPLATE = `download:${PROGRESS_PREFIX}%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.eta)s`
const FILE_TEMPLATE = `after_move:${FILE_PREFIX}%(filepath)s`
// fires once before the download starts, carrying the format actually chosen
// ("160+139" for a merge, "18" for a pre-muxed file) - that is how many 0-100%
// sweeps the progress lines will make
const STREAM_TEMPLATE = `before_dl:${STREAM_PREFIX}%(format_id)s`

// how many stderr lines we keep for the report issue payload
const STDERR_BUFFER_LINES = 200

// kill a process that has printed nothing at all for this long
const DEFAULT_WATCHDOG_MS = 2 * 60 * 1000

// ...except while postprocessing, where silence is the expected shape rather
// than a symptom. yt-dlp pipes a postprocessor's ffmpeg output instead of
// letting it through, so a merge, a remux or an mp3 conversion prints nothing
// from the moment it starts until the file lands - minutes, on a long video.
// the download that reaches this phase has already fetched every byte, so the
// only thing DEFAULT_WATCHDOG_MS achieves here is killing a job that is working
const POSTPROCESS_WATCHDOG_MS = 30 * 60 * 1000

// ffmpeg's periodic status line, which it rewrites over a carriage return.
// these are load-bearing for the watchdog and worthless in an issue report:
// one trim can print thousands of them, and a 200-line buffer full of them
// would be a report with the actual failure scrolled out of it
const FFMPEG_PROGRESS_PATTERN = /^(?:frame|size|Lsize)=/

// how long a cancelled process gets to exit before it is killed outright
const KILL_GRACE_MS = 5000

// app quit: the ceiling on waiting for cancelled operations to actually exit.
// longer than KILL_GRACE_MS so the sigkill escalation always gets to fire
// before this gives up, plus slack for taskkill itself to run on windows
const SHUTDOWN_WAIT_MS = KILL_GRACE_MS + 2000

// a warm onedir answers --version in well under a second, but the very first
// run after an install is scanned by the os and can take the best part of a
// minute - so this ceiling only ever catches a genuinely wedged process
const PROBE_TIMEOUT_MS = 2 * 60 * 1000

// the official builds are pyinstaller *onedir* bundles: a directory holding
// the executable next to its _internal/ payload. the onefile builds cost
// 43-108 s per invocation on macos (they re-extract ~50 mb every run), which is
// why the engine lives in a directory now
const ENGINE_DIR_NAME = "ytdlp"

// the PO token payload sits beside the engine rather than inside it: the
// updater replaces the engine directory wholesale on every upgrade, and
// upstream's archives carry no plugins, so anything kept in there is deleted
// the next time yt-dlp updates itself
const POT_DIR_NAME = "pot"

// the executable keeps the release asset's own name, and that name differs per
// platform and per arch - never assume one
const EXECUTABLE_NAMES = {
  darwin: ["yt-dlp_macos", "yt-dlp"],
  win32: ["yt-dlp.exe", "yt-dlp_x86.exe", "yt-dlp_arm64.exe"],
  linux: [
    "yt-dlp_linux",
    "yt-dlp_linux_aarch64",
    "yt-dlp_musllinux",
    "yt-dlp_musllinux_aarch64",
    "yt-dlp"
  ]
}

const {
  ERROR_CATEGORIES,
  ERROR_STAGES,
  classify
} = require("../utils/error-taxonomy")

// the engine's historical name for the taxonomy - kept so existing call sites
// and tests read naturally. the engine used to own a second, narrower list and
// its own stderr pattern table; both drifted from the taxonomy, so the taxonomy
// is now the only classifier and this file only owns the wording.
const ERROR_CODES = ERROR_CATEGORIES

// wording and behaviour flags for the codes classify() can hand back. no
// patterns here on purpose: a second pattern table is exactly the drift this
// module just stopped paying for.
const ERROR_METADATA = {
  [ERROR_CODES.BOT_DETECTION]: {
    message: "YouTube asked us to confirm you're not a bot.",
    suggestion: "Import your YouTube cookies from Settings and try again.",
    needsCookies: true
  },
  [ERROR_CODES.VIDEO_UNAVAILABLE]: {
    message: "This video isn't available for download.",
    suggestion: "It may be private, age-restricted, or removed."
  },
  // no pattern reaches this one - it is raised by whoever looked at the format
  // list and found no video in it. the wording is here anyway, because a code
  // classify() can hand back needs something to say: a caller that names it
  // would otherwise get "Download failed", which explains nothing. the
  // pinterest refusal in ipc-handlers says the same thing in its own words,
  // because it knows which platform the user was on and this does not
  [ERROR_CODES.NOT_A_VIDEO]: {
    message: "There's no video at this link.",
    suggestion: "Cliply downloads video, so try a link that has one."
  },
  [ERROR_CODES.GEO_BLOCKED]: {
    message: "This video isn't available in your country.",
    suggestion: "The uploader restricted where it can be watched."
  },
  [ERROR_CODES.EXTRACTION_FAILED]: {
    message: "YouTube changed something the downloader needs to catch up with.",
    suggestion: "Updating the downloader usually fixes this.",
    // the download flow retries these once after running yt-dlp -U
    updateMayFix: true
  },
  [ERROR_CODES.NETWORK_ERROR]: {
    message: "Network interrupted the download.",
    suggestion: "Check your connection and try again.",
    retryable: true
  },
  // deliberately not retryable, and deliberately silent about the connection:
  // the user's network is fine, and retrying is what extends the block
  [ERROR_CODES.RATE_LIMITED]: {
    message: "YouTube is temporarily limiting this device.",
    suggestion: "Wait a few minutes before trying again."
  },
  [ERROR_CODES.DISK_FULL]: {
    message: "Not enough disk space to save this download.",
    suggestion: "Free up some space and try again."
  },
  [ERROR_CODES.PERMISSION_ERROR]: {
    message: "Can't write to the download folder.",
    suggestion: "Check permissions or pick a different download location."
  },
  [ERROR_CODES.PATH_ERROR]: {
    message: "Couldn't write to that location.",
    suggestion: "Try a different download folder, or one with a shorter path."
  },
  [ERROR_CODES.JS_RUNTIME_MISSING]: {
    message: "A component the downloader needs is missing.",
    suggestion: "Please reinstall Cliply."
  },
  [ERROR_CODES.FFMPEG_MISSING]: {
    message: "The video processor is missing.",
    suggestion: "Please reinstall Cliply."
  },
  [ERROR_CODES.FFMPEG_AV_BLOCKED]: {
    message: "Your antivirus stopped the video processor.",
    suggestion: "Allow Cliply in your antivirus, then try again."
  },
  [ERROR_CODES.FFMPEG_CORRUPT_STREAM]: {
    message: "The video stream was damaged.",
    suggestion: "Try a different quality."
  },
  [ERROR_CODES.FFMPEG_ERROR]: {
    message: "Something went wrong while processing the video.",
    suggestion: "Please try again."
  }
}

// codes nothing classifies its way into - they are set directly by the caller
// that already knows what happened
const TERMINAL_ERRORS = {
  [ERROR_CODES.CANCELLED]: {
    message: "Download cancelled.",
    suggestion: "Start the download again whenever you're ready."
  },
  [ERROR_CODES.STALLED]: {
    message: "The download stopped responding.",
    suggestion: "Check your connection and try again."
  },
  [ERROR_CODES.ENGINE_MISSING]: {
    message: "The downloader engine is missing.",
    suggestion: "Please restart Cliply, or reinstall it if this keeps happening."
  },
  [ERROR_CODES.DOWNLOAD_FAILED]: {
    message: "Download failed.",
    suggestion: "Please try again."
  }
}

// neither table may be rewritten after load: wordingFor resolves through both,
// so a stray assignment would change what every failure says - and, for the
// metadata entries, whether the download flow retries at all
Object.freeze(ERROR_METADATA)
Object.freeze(TERMINAL_ERRORS)
for (const entry of Object.values(ERROR_METADATA)) Object.freeze(entry)
for (const entry of Object.values(TERMINAL_ERRORS)) Object.freeze(entry)

// wording for any code, whoever produced it, so the ui never shows a blank
// message. terminal codes first, then the classified ones, then the catch-all.
function wordingFor(code) {
  return (
    TERMINAL_ERRORS[code] ||
    ERROR_METADATA[code] ||
    TERMINAL_ERRORS[ERROR_CODES.DOWNLOAD_FAILED]
  )
}

// every failure path returns the same keys. a consumer that destructures
// `retryable` off a cancelled result has to get false, not undefined - task 6
// reads these into analytics, where the two are not the same value.
function errorShape(code, wording, details) {
  return {
    code,
    message: wording.message,
    suggestion: wording.suggestion,
    retryable: Boolean(wording.retryable),
    updateMayFix: Boolean(wording.updateMayFix),
    needsCookies: Boolean(wording.needsCookies),
    details
  }
}

/**
 * the failure a caller gets when it already knows the code, rather than
 * leaving it to be read out of stderr
 *
 * @param {string} code - one of ERROR_CODES
 * @param {string|null} details - redacted technical detail, if any
 * @returns {Object} the same shape mapError returns
 */
function explicitError(code, details = null) {
  return errorShape(code, wordingFor(code), details)
}

// =============================================================================
// pure helpers (unit tested)
// =============================================================================

// strip terminal colour codes - yt-dlp adds them to _percent_str on some hosts
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

function stripAnsi(value) {
  return String(value == null ? "" : value).replace(ANSI_PATTERN, "")
}

// values yt-dlp prints when it simply doesn't know yet
function isUnknownValue(value) {
  const normalized = stripAnsi(value).trim().toLowerCase()
  return (
    normalized === "" ||
    normalized === "na" ||
    normalized === "n/a" ||
    normalized === "none" ||
    normalized.includes("unknown")
  )
}

/**
 * parse one CLIPLY| progress line
 * @param {string} line - raw stdout line
 * @returns {Object|null} {progress, speed, eta, etaSeconds} or null when not a progress line
 */
function parseProgressLine(line) {
  const text = stripAnsi(line).trim()

  if (!text.startsWith(PROGRESS_PREFIX)) {
    return null
  }

  const parts = text.slice(PROGRESS_PREFIX.length).split("|")
  const percent = parseFloat(stripAnsi(parts[0]).replace("%", "").trim())

  if (!Number.isFinite(percent)) {
    return null
  }

  const speed = isUnknownValue(parts[1]) ? null : stripAnsi(parts[1]).trim()
  const eta = isUnknownValue(parts[2]) ? null : stripAnsi(parts[2]).trim()
  const etaSecondsRaw = isUnknownValue(parts[3])
    ? NaN
    : parseFloat(stripAnsi(parts[3]).trim())

  return {
    progress: Math.min(100, Math.max(0, percent)),
    speed,
    eta,
    etaSeconds: Number.isFinite(etaSecondsRaw) ? Math.round(etaSecondsRaw) : null
  }
}

/**
 * parse the final destination out of a stdout line
 * @param {string} line - raw stdout line
 * @returns {string|null} absolute file path or null
 */
function parseDestinationLine(line) {
  const text = stripAnsi(line).trim()

  if (text.startsWith(FILE_PREFIX)) {
    const filePath = text.slice(FILE_PREFIX.length).trim()
    return filePath || null
  }

  // fallbacks for the non-quiet output shape, in case --print ever stops firing
  const destination = text.match(
    /^\[(?:download|ExtractAudio|VideoConvertor)\]\s+Destination:\s+(.+)$/
  )
  if (destination) {
    return destination[1].trim()
  }

  const merged = text.match(/^\[Merger\]\s+Merging formats into\s+"(.+)"$/)
  if (merged) {
    return merged[1].trim()
  }

  const alreadyThere = text.match(/^\[download\]\s+(.+) has already been downloaded$/)
  if (alreadyThere) {
    return alreadyThere[1].trim()
  }

  return null
}

/**
 * read how many streams a download will fetch from the before_dl marker
 * @param {string} line - raw stdout line
 * @returns {number|null} stream count, or null when not a marker line
 */
function parseStreamCountLine(line) {
  const text = stripAnsi(line).trim()

  if (!text.startsWith(STREAM_PREFIX)) {
    return null
  }

  const formatId = text.slice(STREAM_PREFIX.length).trim()
  if (!formatId) {
    return null
  }

  return formatId.split("+").filter(Boolean).length || 1
}

/**
 * kill a child process, taking its descendants with it on windows
 *
 * yt-dlp spawns ffmpeg and deno as its own children. on windows `child.kill`
 * only reaches yt-dlp itself, so the tree has to go through taskkill - which
 * can fail either by not spawning at all or by spawning and exiting non-zero
 * (access denied, pid already gone). both fall back to signalling directly.
 *
 * @param {Object} child - the child process to terminate
 * @param {Object} options - {spawnFn, signal} - signal is the posix signal
 * @returns {void}
 */
function killProcessTree(child, options = {}) {
  if (!child || child.killed) {
    return
  }

  const spawnFn = options.spawnFn || spawn
  const signal = options.signal || "SIGKILL"

  let fellBack = false
  const fallback = () => {
    if (fellBack) return
    fellBack = true
    try {
      child.kill(signal)
    } catch {
      // process already gone
    }
  }

  if (process.platform !== "win32") {
    fallback()
    return
  }

  let killer = null

  try {
    killer = spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    })
  } catch {
    fallback()
    return
  }

  killer.on("error", fallback)
  killer.on("close", (code) => {
    if (code !== 0) {
      fallback()
    }
  })
}

// the user's home folder and signed media urls (which carry their ip address)
// must never reach an issue report or analytics payload
const HOME_DIR = os.homedir()
const REDACTIONS = [
  [/\/Users\/[^/\\\s"'<>]+/g, "/Users/~"],
  [/\/home\/[^/\\\s"'<>]+/g, "/home/~"],
  [/([A-Za-z]):\\Users\\[^\\<>"|?*\n\r]+/g, "$1:\\Users\\~"],
  [/(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/g, "$1?<redacted>"]
]

/**
 * redact user paths and signed urls from a log line
 * @param {string} line - raw log line
 * @returns {string} redacted line
 */
function redactLogLine(line) {
  let text = String(line == null ? "" : line)

  if (HOME_DIR && text.includes(HOME_DIR)) {
    text = text.split(HOME_DIR).join("~")
  }

  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement)
  }

  return text
}

/**
 * map a failed run onto a user-facing error
 * @param {Object} outcome - {exitCode, stderrLines, cancelled, stalled}
 * @returns {Object} {code, message, suggestion, retryable, updateMayFix, needsCookies, details}
 */
function mapError({
  exitCode = null,
  stderrLines = [],
  cancelled = false,
  stalled = false
} = {}) {
  if (cancelled) {
    return errorShape(ERROR_CODES.CANCELLED, TERMINAL_ERRORS[ERROR_CODES.CANCELLED], null)
  }

  if (stalled) {
    return errorShape(ERROR_CODES.STALLED, TERMINAL_ERRORS[ERROR_CODES.STALLED], null)
  }

  const lines = Array.isArray(stderrLines) ? stderrLines : String(stderrLines).split("\n")
  const haystack = lines.join("\n")

  // the "ERROR:" line yt-dlp prints is the most useful technical detail
  const errorLine = [...lines].reverse().find((line) => /^\s*ERROR[: ]/i.test(line))
  const details = errorLine ? errorLine.trim() : lines[lines.length - 1] || null

  // the taxonomy owns the pattern table now. UNKNOWN_ERROR means nothing
  // matched, which is the same "we ran and it broke" the fallback below has
  // always reported - so it falls through rather than becoming a new code.
  const { category } = classify(haystack, ERROR_STAGES.DOWNLOAD)
  const metadata = category === ERROR_CODES.UNKNOWN_ERROR ? null : ERROR_METADATA[category]

  if (metadata) {
    return errorShape(category, metadata, details)
  }

  return errorShape(
    ERROR_CODES.DOWNLOAD_FAILED,
    TERMINAL_ERRORS[ERROR_CODES.DOWNLOAD_FAILED],
    details || (exitCode === null ? null : `yt-dlp exited with code ${exitCode}`)
  )
}

// format a time-range bound for --download-sections
function formatSectionTime(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }

  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0"
  }

  return String(Math.round(seconds * 1000) / 1000)
}

// common args for every invocation
function buildCommonArgs({
  ffmpegPath,
  denoPath,
  cookieFile,
  potPaths,
  potEnabled
} = {}) {
  const args = []

  // deno is required for youtube's js challenges since yt-dlp 2025.11.12
  if (denoPath) {
    args.push("--no-js-runtimes", "--js-runtimes", `deno:${denoPath}`)
  }

  if (ffmpegPath) {
    args.push("--ffmpeg-location", ffmpegPath)
  }

  args.push("--no-warnings", "--no-colors", "--newline")

  // no retry overrides: yt-dlp's defaults (10 / 3 / 10) ride out the transient
  // blips the python service's 1/1/2 turned into failures, and the no-output
  // watchdog still kills anything genuinely wedged

  if (cookieFile) {
    args.push("--cookies", cookieFile)
  }

  /**
   * the PO token escalation
   *
   * all this does is make a token provider reachable. it names no client and
   * sets no fetch policy, because yt-dlp already owns both: it picks from its
   * own client list, applies its own fallbacks, and - given a provider - it
   * notices the client it chose needs a token and fetches one unprompted.
   * That was verified end to end: no player_client passed, and the log still
   * read "Generating a gvs PO Token for web client" followed by a download.
   *
   * yt-dlp's wiki does suggest `mweb` "if you are having issues with the
   * default clients", but that advice is written for someone with no provider
   * at all - the missing token *is* the issue it describes. Pinning a client
   * here would override the one decision yt-dlp keeps in step with youtube,
   * and freeze us on whichever client happened to be right today. If telemetry
   * ever shows the defaults still failing with a provider present, `mweb`
   * becomes a second escalation step rather than the first.
   *
   * three conditions, each of which alone is a reason to stay quiet:
   *   - potEnabled: this install has actually been refused. minting costs
   *     seconds per video and youtube binds a token to the video id, so a new
   *     one is paid for every new video - not something to charge the ~84% who
   *     are never blocked
   *   - potPaths: the payload is installed. missing means degrade to today's
   *     behaviour, never fail
   *   - denoPath: the provider runs its generator on the js runtime we ship.
   *     no runtime, nothing to mint with
   *
   * fetch_pot is deliberately not set: it defaults to `auto`, which is yt-dlp
   * deciding whether the chosen client needs a token for a given context, and
   * that is the part which tracks youtube's rollout.
   *
   * --plugin-dirs is given explicitly rather than relying on a yt-dlp-plugins
   * folder beside the binary. the engine self-updates by replacing its whole
   * directory, so anything parked next to it is deleted by the next update -
   * and the binary itself moves between the bundled copy and the userData one.
   * naming the directory also means yt-dlp does not scan the user's own plugin
   * directories, which is code we neither ship nor control.
   */
  if (potEnabled && potPaths && denoPath) {
    args.push("--plugin-dirs", potPaths.pluginDir)
    args.push(
      "--extractor-args",
      `youtubepot-bgutilscript:server_home=${potPaths.serverHome}`
    )
  }

  return args
}

// progress + final-filename plumbing, plus the output location
function buildDownloadArgs({ outputDir, outputTemplate } = {}) {
  // --print implies --quiet, so --progress is what keeps progress lines coming
  const args = [
    "--progress",
    "--progress-template",
    PROGRESS_TEMPLATE,
    "--print",
    STREAM_TEMPLATE,
    "--print",
    FILE_TEMPLATE,
    // ...and --quiet does not stop at yt-dlp. a trimmed download is handed to
    // yt-dlp's ffmpeg downloader, which *fetches the media itself* over https,
    // and it passes our quiet straight through as `-loglevel quiet` - verified
    // against 2026.08.19. ffmpeg then runs the entire download without printing
    // one byte, which costs two things:
    //
    //   - the no-output watchdog has nothing to see, so it kills any trim that
    //     runs longer than DEFAULT_WATCHDOG_MS. an ffmpeg section download runs
    //     at roughly real time, so that is a clip of a couple of minutes.
    //   - a failure arrives as a bare "ERROR: ffmpeg exited with code N" with
    //     ffmpeg's own reason discarded. "Permission denied" reaches us as
    //     FFMPEG_ERROR / "Something went wrong while processing the video"
    //     rather than as the PERMISSION_ERROR the taxonomy would have named.
    //
    // --no-quiet re-enables both. it also restores yt-dlp's own line-oriented
    // output on stdout, which is what parseDestinationLine's non-quiet
    // fallbacks were already written for - the after_move print still lands
    // last, so it is still the final filePath
    "--no-quiet"
  ]

  if (outputDir) {
    args.push("-P", outputDir)
  }

  if (outputTemplate) {
    args.push("-o", outputTemplate)
    // --windows-filenames is a no-op on mac and windows: verified against
    // 2026.08.19, yt-dlp already substitutes `: / | ? * < >` with fullwidth
    // lookalikes by default there. it earns its place only on the linux build,
    // which would otherwise write names that break when copied to windows.
    // --trim-filenames keeps a name inside the 255-byte path component limit -
    // it takes a LENGTH, not a bare flag
    args.push("--windows-filenames", "--trim-filenames", "240")
  }

  return args
}

function buildTrimArgs({ timeRange, preciseCut } = {}) {
  if (!timeRange || timeRange.start === undefined || timeRange.end === undefined) {
    return []
  }

  const start = formatSectionTime(timeRange.start)
  const end = formatSectionTime(timeRange.end)
  const args = ["--download-sections", `*${start}-${end}`]

  if (preciseCut) {
    args.push("--force-keyframes-at-cuts")
  }

  return args
}

// the only containers a tier may ask for: -t expands into whole option sets, so
// an unvetted value from the renderer must never reach it
const TIER_CONTAINERS = ["mp4", "mkv"]

// the whole audio vocabulary: our wording -> yt-dlp's preset name. `original`
// maps to null because it *is* the absence of a preset - the stream youtube
// served, unconverted. the keys are also the valid-mode list
const AUDIO_MODE_PRESETS = { mp3: "mp3", m4a: "aac", original: null }

// a language code is interpolated straight into an -f expression, so it is
// whitelisted for the same reason TIER_CONTAINERS is: nothing arriving over
// ipc gets to write format-selector syntax. real codes are bcp-47 tags -
// "hi", "pt-BR", "zh-Hans" - and nothing else has to pass
const AUDIO_LANGUAGE_PATTERN = /^[a-zA-Z0-9-]{2,16}$/

/**
 * read the requested audio language off the download params
 *
 * anything unrecognised comes back as null, which means the args are built
 * exactly as they were before this option existed - the same download every
 * single-language video has always produced
 *
 * @param {Object} params - operation parameters
 * @returns {string|null} the language code, or null for "no language filter"
 */
function normalizeAudioLanguage(params = {}) {
  // a tag is a string, and only a string: coercing a number or an object into
  // one would launder a malformed payload into something the pattern accepts
  if (typeof params.audioLanguage !== "string") {
    return null
  }

  const code = params.audioLanguage.trim()

  return AUDIO_LANGUAGE_PATTERN.test(code) ? code : null
}

/**
 * the format selector that pins an audio language
 *
 * **language is a filter field, not a sort field.** `-S lang:hi` is silently
 * ignored - verified against 2026.08.19, it returns the original track and
 * prints no error - so this is the one place the "sorting only, never filters"
 * rule is broken on purpose. the `/b` fallback tail is what keeps it safe: a
 * language that has gone away since the listing degrades to the normal pick
 * instead of failing the download.
 *
 * the match is exact (`=`) and never a prefix (`^=`), because `zh-Hans` and
 * `zh-Hant` are separate tracks that a prefix match would collide into one.
 *
 * @param {string} language - a code that has already been validated
 * @param {boolean} audioOnly - true for the audio tab, false for video+audio
 * @returns {string} the -f expression
 */
function audioLanguageSelector(language, audioOnly) {
  return audioOnly
    ? `ba[language=${language}]/ba/b`
    : `bv*+ba[language=${language}]/bv*+ba/b`
}

/**
 * read a {height, container} quality tier off the download params
 *
 * a missing height is not an error: `-t mp4` on its own is still a complete
 * instruction ("best, in this container"), which is what yt-dlp would do anyway
 *
 * @param {Object} params - operation parameters
 * @returns {Object} {height, container} - height is null when none was asked for
 */
function normalizeQualityTier(params = {}) {
  const height = Math.round(Number(params.height))

  return {
    height: Number.isFinite(height) && height > 0 ? height : null,
    container: TIER_CONTAINERS.includes(params.container) ? params.container : "mp4"
  }
}

/**
 * read the audio mode off the download params
 * @param {Object} params - operation parameters
 * @returns {string} mp3 | m4a | original
 */
function normalizeAudioMode(params = {}) {
  const mode = String(params.audioMode || "").toLowerCase()

  // mp3 is the fallback for anything unrecognised - the same universal mode the
  // menu opens on, so a malformed payload can never produce an unplayable file
  return Object.hasOwn(AUDIO_MODE_PRESETS, mode) ? mode : "mp3"
}

/**
 * build the full arg list for one operation
 * @param {string} operation - info | playlist-info | combined | audio | simple
 * @param {Object} params - operation parameters
 * @returns {string[]} yt-dlp args, url last
 */
function buildArgs(operation, params = {}) {
  const args = buildCommonArgs(params)

  switch (operation) {
    case "info": {
      args.push("--dump-json", "--no-download", "--no-playlist")
      break
    }

    case "playlist-info": {
      args.push(
        "--dump-json",
        "--no-download",
        "--flat-playlist",
        "--playlist-items",
        `1:${params.maxVideos || 50}`
      )
      break
    }

    case "combined": {
      const tier = normalizeQualityTier(params)

      // ORDER IS LOAD-BEARING. `-t mp4` expands to an -S of its own and the
      // last -S on the line wins, so the preset has to come first:
      //   -t mp4 -S res:720 -> 298+140, h264 720p
      //   -S res:720 -t mp4 -> 299+140, h264 1080p
      // no --merge-output-format either: -t already remuxes to a container
      // whose codecs the whole world can actually play
      args.push("-t", tier.container)

      if (tier.height) {
        args.push("-S", `res:${tier.height}`)
      }

      const language = normalizeAudioLanguage(params)
      if (language) {
        args.push("-f", audioLanguageSelector(language, false))
      }

      args.push("--no-playlist")
      args.push(...buildDownloadArgs(params))
      args.push(...buildTrimArgs(params))
      break
    }

    case "audio": {
      const preset = AUDIO_MODE_PRESETS[normalizeAudioMode(params)]
      const language = normalizeAudioLanguage(params)

      if (!preset) {
        // no -x on purpose: "original" means the stream in the container
        // youtube served it in, and the /b tail keeps sites that only offer
        // muxed formats from failing outright
        args.push("-f", language ? audioLanguageSelector(language, true) : "ba/b")
      } else {
        // -t mp3 / -t aac carry their own selector, extraction and container
        args.push("-t", preset)

        // a later -f replaces the preset's own selector while its extraction
        // and container flags stay - verified: `-t mp3 -f "ba[language=hi]/ba/b"`
        // produces an mp3 whose %(language)s reads hi
        if (language) {
          args.push("-f", audioLanguageSelector(language, true))
        }
      }

      args.push("--no-playlist")
      args.push(...buildDownloadArgs(params))
      args.push(...buildTrimArgs(params))
      break
    }

    case "simple": {
      // tiktok / pinterest - one muxed file, no format picking
      args.push("-f", params.formatSelector || "best")
      args.push("--no-playlist")
      args.push(...buildDownloadArgs(params))
      break
    }

    default:
      throw new Error(`Unknown yt-dlp operation: ${operation}`)
  }

  if (params.extraArgs) {
    args.push(...params.extraArgs)
  }

  // everything past "--" is an operand, never an option. without it a url the
  // user pasted as "--exec=..." would be honoured as a yt-dlp flag
  args.push("--", normalizeUrl(params.url))

  return args
}

/**
 * validate a user-supplied url before it reaches the command line
 * @param {string} url - the url to download
 * @returns {string} the trimmed url
 * @throws {Error} tagged with INVALID_URL when it is missing or not http(s)
 */
function normalizeUrl(url) {
  const trimmed = typeof url === "string" ? url.trim() : ""

  if (!trimmed) {
    throw invalidUrlError("A video link is required.")
  }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw invalidUrlError("That doesn't look like a valid link.")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidUrlError("Only http and https links are supported.")
  }

  return trimmed
}

function invalidUrlError(message) {
  const error = new Error(message)
  error.code = ERROR_CODES.INVALID_URL
  error.suggestion = "Paste the link straight from your browser and try again."
  return error
}

// yt-dlp reports progress per stream, so a video+audio download sweeps 0-100
// twice. this is the opening guess; the before_dl marker corrects it once the
// real format is known - including the case where the pick turns out to be a
// single pre-muxed file.
function expectedStreamCount(operation, params = {}) {
  if (operation !== "combined") {
    return 1
  }

  // a time range hands the whole job to ffmpeg, which reports one sweep no
  // matter how many formats it is muxing
  if (params.timeRange) {
    return 1
  }

  // a video download merges a video stream with an audio one
  return 2
}

/**
 * the one gate both downloads and self-updates go through
 *
 * downloads take a shared read lock and wait when an update is mid-flight;
 * `-U` and seeding take an exclusive write lock and *refuse* rather than queue,
 * because an update must never sit behind a two-hour download. both paths
 * change state synchronously inside the acquire call, so there is no window
 * between checking and holding.
 */
class OperationGate {
  constructor() {
    this.readers = 0
    this.writing = false
    this.waitingReaders = []
  }

  /**
   * take a shared lock, waiting for any in-flight write to finish
   * @returns {Promise<Function>} resolves with the release function
   */
  acquireRead() {
    if (!this.writing) {
      this.readers += 1
      return Promise.resolve(this.makeReadRelease())
    }

    return new Promise((resolve) => {
      this.waitingReaders.push(() => {
        this.readers += 1
        resolve(this.makeReadRelease())
      })
    })
  }

  /**
   * take the exclusive lock if nothing else holds the gate
   * @returns {Function|null} release function, or null when busy
   */
  tryAcquireWrite() {
    if (this.writing || this.readers > 0) {
      return null
    }

    this.writing = true

    let released = false
    return () => {
      if (released) return
      released = true
      this.writing = false
      this.drainWaitingReaders()
    }
  }

  makeReadRelease() {
    let released = false
    return () => {
      if (released) return
      released = true
      this.readers = Math.max(0, this.readers - 1)
    }
  }

  drainWaitingReaders() {
    const waiting = this.waitingReaders
    this.waitingReaders = []
    for (const grant of waiting) {
      grant()
    }
  }

  isBusy() {
    return this.writing || this.readers > 0
  }
}

// bounded line buffer for stderr
class RingBuffer {
  constructor(limit = STDERR_BUFFER_LINES) {
    this.limit = limit
    this.lines = []
  }

  push(line) {
    if (!line) return
    this.lines.push(line)
    if (this.lines.length > this.limit) {
      this.lines.splice(0, this.lines.length - this.limit)
    }
  }

  tail(count = this.limit) {
    return this.lines.slice(-count)
  }

  toString(count = this.limit) {
    return this.tail(count).join("\n")
  }
}

// turns per-stream percentages into a single monotonic bar
class ProgressTracker {
  constructor(expectedStreams = 1) {
    this.expectedStreams = Math.max(1, expectedStreams)
    this.streamIndex = 0
    this.lastStreamProgress = 0
    this.lastOverall = 0
  }

  // called when the before_dl marker reveals the real format, which is more
  // reliable than guessing from the selector
  setExpectedStreams(count) {
    if (!Number.isFinite(count) || count < 1) return
    this.expectedStreams = Math.max(count, this.streamIndex + 1)
  }

  update(parsed) {
    const streamProgress = parsed.progress

    // a percentage that jumps backwards means yt-dlp moved on to the next stream
    if (streamProgress + 1 < this.lastStreamProgress) {
      this.streamIndex += 1
    }
    this.lastStreamProgress = streamProgress

    const streams = Math.max(this.expectedStreams, this.streamIndex + 1)
    const overall = ((this.streamIndex + streamProgress / 100) / streams) * 100

    this.lastOverall = Math.min(100, Math.max(this.lastOverall, overall))

    return {
      progress: Math.round(this.lastOverall * 10) / 10,
      streamProgress,
      streamIndex: this.streamIndex,
      speed: parsed.speed,
      eta: parsed.eta,
      etaSeconds: parsed.etaSeconds
    }
  }
}

// splits a stream into lines, holding back partial ones
class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine
    this.buffer = ""
  }

  push(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r\n|\r|\n/)
    this.buffer = lines.pop()
    for (const line of lines) {
      this.onLine(line)
    }
  }

  flush() {
    if (this.buffer) {
      const line = this.buffer
      this.buffer = ""
      this.onLine(line)
    }
  }
}

// =============================================================================
// operation handle
// =============================================================================

/**
 * one spawned yt-dlp process
 * exposes `promise`, `cancel()` and progress events (`events` is the handle itself)
 */
class YtdlpOperation extends EventEmitter {
  constructor({
    id,
    operation,
    binaryPath,
    args,
    cwd,
    watchdogMs = DEFAULT_WATCHDOG_MS,
    collectStdout = false,
    expectedStreams = 1,
    trackStreamMarker = true,
    gate = null,
    killGraceMs = KILL_GRACE_MS,
    spawnFn = spawn,
    killFn = process.kill
  }) {
    super()

    this.gate = gate
    this.killGraceMs = killGraceMs
    this.spawnFn = spawnFn
    this.killFn = killFn

    this.id = id
    this.operation = operation
    this.binaryPath = binaryPath
    this.args = args
    this.cwd = cwd
    this.watchdogMs = watchdogMs
    this.collectStdout = collectStdout
    this.trackStreamMarker = trackStreamMarker

    this.stderrBuffer = new RingBuffer(STDERR_BUFFER_LINES)
    this.tracker = new ProgressTracker(expectedStreams)
    this.stdout = ""
    this.filePath = null
    this.phase = "starting"
    this.cancelled = false
    this.stalled = false
    this.settled = false
    this.startedAt = Date.now()
    this.child = null
    this.watchdog = null
    this.killTimer = null
    this.releaseGate = null

    // the handle contract in the ticket - `events` is this emitter
    this.events = this

    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })

    this.begin()
  }

  // wait for the gate (an update may be replacing the binary) before spawning
  begin() {
    if (!this.gate) {
      this.start()
      return
    }

    this.gate.acquireRead().then((release) => {
      // cancelled while we were queued behind an update - never spawn at all.
      // cancel()'s own path already called fail() before this ever resolved,
      // so settled is already true and fail() here would just no-op - without
      // releasing a lock we only just received. release it directly, or every
      // update after this one sees the gate as busy forever.
      if (this.cancelled || this.settled) {
        release()
        return
      }

      this.releaseGate = release
      this.start()
    })
  }

  start() {
    try {
      this.child = this.spawnFn(this.binaryPath, this.args, {
        cwd: this.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // yt-dlp spawns ffmpeg and deno as its own children. detaching it into
        // its own process group on posix means a signal to -pid reaches every
        // descendant, not just yt-dlp - the same guarantee windows gets from
        // taskkill /T. windows has no equivalent grouping semantics for this
        // and uses taskkill for its tree-kill instead, so this stays off there.
        detached: process.platform !== "win32",
        env: { ...process.env }
      })
    } catch (error) {
      this.fail({ code: ERROR_CODES.ENGINE_MISSING, cause: error })
      return
    }

    const stdoutSplitter = new LineSplitter((line) => this.handleStdoutLine(line))
    const stderrSplitter = new LineSplitter((line) => this.handleStderrLine(line))

    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => {
      this.touch()
      if (this.collectStdout) {
        this.stdout += chunk
      }
      stdoutSplitter.push(chunk)
    })

    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk) => {
      this.touch()
      stderrSplitter.push(chunk)
    })

    this.child.on("error", (error) => {
      // ENOENT here means the binary vanished between the path check and spawn
      const code =
        error && error.code === "ENOENT"
          ? ERROR_CODES.ENGINE_MISSING
          : ERROR_CODES.DOWNLOAD_FAILED
      this.fail({ code, cause: error })
    })

    this.child.on("close", (exitCode) => {
      stdoutSplitter.flush()
      stderrSplitter.flush()
      this.clearTimers()

      if (this.settled) {
        return
      }

      if (exitCode === 0 && !this.cancelled && !this.stalled) {
        this.setPhase("completed")
        this.emit("progress", {
          progress: 100,
          streamProgress: 100,
          streamIndex: this.tracker.streamIndex,
          speed: null,
          eta: null,
          etaSeconds: 0
        })

        const result = {
          id: this.id,
          operation: this.operation,
          exitCode,
          filePath: this.filePath,
          stdout: this.stdout,
          stderr: this.getStderr(),
          durationMs: Date.now() - this.startedAt
        }

        this.settled = true
        this.releaseGateIfHeld()
        this.emit("completed", result)
        this.resolve(result)
        return
      }

      this.fail({ exitCode })
    })

    this.touch()
    this.setPhase("running")
  }

  handleStdoutLine(line) {
    if (!line) return

    const streamCount = parseStreamCountLine(line)
    if (streamCount !== null) {
      if (this.trackStreamMarker) {
        this.tracker.setExpectedStreams(streamCount)
      }
      this.emit("streams", this.tracker.expectedStreams)
      return
    }

    const progress = parseProgressLine(line)
    if (progress) {
      const update = this.tracker.update(progress)

      // yt-dlp prints two 100% lines per stream - without this guard the phase
      // would flap back to downloading after postprocessing has started
      if (this.phase !== "processing" || update.streamProgress < 100) {
        this.setPhase("downloading")
      }

      this.emit("progress", update)

      // the last stream finishing means ffmpeg/postprocessing takes over, and
      // yt-dlp goes quiet until the file lands
      if (
        update.streamProgress >= 100 &&
        update.streamIndex >= this.tracker.expectedStreams - 1
      ) {
        this.setPhase("processing")
      }
      return
    }

    const destination = parseDestinationLine(line)
    if (destination) {
      this.filePath = destination
      this.emit("destination", destination)
      return
    }

    this.emit("stdout", line)
  }

  handleStderrLine(line) {
    if (!line || !line.trim()) return

    // the watchdog was already fed by the chunk this line arrived in, before
    // anything was parsed - so dropping the line here costs it nothing
    if (FFMPEG_PROGRESS_PATTERN.test(line.trimStart())) return

    const redacted = redactLogLine(line.trimEnd())
    this.stderrBuffer.push(redacted)
    this.emit("stderr", redacted)
  }

  setPhase(phase) {
    if (this.phase === phase) return
    this.phase = phase

    // the deadline is per-phase, and postprocessing's is much longer. re-arm on
    // the way in rather than waiting for output that, in this phase, is not
    // coming - the timer running right now was started under the old deadline.
    //
    // only this phase: the terminal phases are set either side of the close
    // handler's clearTimers(), where arming anything would be a timer nobody
    // clears again
    if (phase === "processing") {
      this.touch()
    }

    this.emit("phase", phase)
  }

  /**
   * how long this phase gets to stay silent before it is called wedged
   * @returns {number} milliseconds, or 0 when the watchdog is off entirely
   */
  watchdogDeadline() {
    if (!this.watchdogMs) return 0

    return this.phase === "processing"
      ? Math.max(this.watchdogMs, POSTPROCESS_WATCHDOG_MS)
      : this.watchdogMs
  }

  // reset the no-output watchdog
  touch() {
    if (this.settled) return

    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }

    const deadline = this.watchdogDeadline()
    if (!deadline) return

    this.watchdog = setTimeout(() => {
      this.stalled = true
      this.killChild()
    }, deadline)
  }

  clearTimers() {
    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }

  // hand the shared lock back so a queued update can proceed
  releaseGateIfHeld() {
    if (this.releaseGate) {
      const release = this.releaseGate
      this.releaseGate = null
      release()
    }
  }

  killChild() {
    if (!this.child || this.child.killed) {
      return
    }

    // yt-dlp spawns ffmpeg (and deno) as children. on windows child.kill only
    // reaches yt-dlp itself, leaving ffmpeg holding the output file, so the
    // whole tree has to go through taskkill
    if (process.platform === "win32") {
      this.killTree()
      return
    }

    this.signalGroup("SIGTERM")

    // yt-dlp cleans up its .part files and its children on sigterm; kill hard
    // if it hangs
    this.killTimer = setTimeout(() => {
      this.signalGroup("SIGKILL")
    }, this.killGraceMs)
  }

  /**
   * posix only: signal the process group start() detached this child into, so
   * ffmpeg and deno die with it instead of surviving as orphans. a group that
   * is already gone (esrch) falls back to the direct child, so a stuck
   * download is never left uncancellable because the group lookup failed
   * @param {string} signal - "SIGTERM" or "SIGKILL"
   */
  signalGroup(signal) {
    if (!this.child || !this.child.pid) return

    try {
      this.killFn(-this.child.pid, signal)
      return
    } catch {
      // no such process group - fall through to the direct child
    }

    try {
      this.child.kill(signal)
    } catch {
      // process already gone
    }
  }

  killTree() {
    killProcessTree(this.child, { spawnFn: this.spawnFn })
  }

  /**
   * cancel this operation - the child is killed and the promise rejects
   * @returns {boolean} whether the operation was still running
   */
  cancel() {
    if (this.settled || this.cancelled) {
      return false
    }

    this.cancelled = true
    this.setPhase("cancelled")

    // still queued behind an update: settle now, nothing was ever spawned
    if (!this.child) {
      this.fail({})
      return true
    }

    this.killChild()
    return true
  }

  fail({ code = null, exitCode = null, cause = null }) {
    if (this.settled) return
    this.settled = true
    this.clearTimers()
    this.releaseGateIfHeld()

    const stderrLines = this.stderrBuffer.tail()
    // both branches go through errorShape, so an explicit code carries the same
    // seven keys a classified one does - a wording entry only defines the flags
    // it needs, and the rest have to read as false, not as missing
    const mapped = code
      ? explicitError(code, cause ? redactLogLine(cause.message) : null)
      : mapError({
          exitCode,
          stderrLines,
          cancelled: this.cancelled,
          stalled: this.stalled
        })

    const error = new Error(mapped.message)
    error.code = mapped.code
    error.suggestion = mapped.suggestion
    error.details = mapped.details
    error.retryable = Boolean(mapped.retryable)
    error.updateMayFix = Boolean(mapped.updateMayFix)
    error.needsCookies = Boolean(mapped.needsCookies)
    error.exitCode = exitCode
    error.operationId = this.id
    error.stderrTail = stderrLines

    this.emit("failed", error)
    this.reject(error)
  }

  /**
   * last captured stderr lines, redacted and ready for an issue report
   * @param {number} count - how many lines
   * @returns {string} joined stderr tail
   */
  getStderr(count = STDERR_BUFFER_LINES) {
    return this.stderrBuffer.toString(count)
  }
}

// =============================================================================
// engine
// =============================================================================

const PLATFORM_DIRS = {
  darwin: "macos",
  win32: "windows",
  linux: "linux"
}

/**
 * executable names to look for inside an unpacked engine, best first
 * @param {string} platform - process.platform override
 * @returns {string[]} candidate file names
 */
function executableCandidates(platform = process.platform) {
  return EXECUTABLE_NAMES[platform] || EXECUTABLE_NAMES.linux
}

/**
 * find the yt-dlp executable inside an unpacked onedir engine
 * @param {string} directory - engine directory
 * @param {string} platform - process.platform override (the build script
 *   unpacks engines for platforms it is not running on)
 * @returns {string|null} absolute path, or null when the directory holds none
 */
function resolveExecutableIn(directory, platform = process.platform) {
  if (!directory) {
    return null
  }

  for (const name of executableCandidates(platform)) {
    const candidate = path.join(directory, name)
    if (fileExists(candidate)) {
      return candidate
    }
  }

  return null
}

/**
 * where an executable *would* live - for messages and for paths we are about
 * to create
 * @param {string} directory - engine directory
 * @returns {string} absolute path
 */
function nominalExecutableIn(directory) {
  return path.join(directory, executableCandidates()[0])
}

/**
 * the single self-extracting file older builds installed in userData/engine
 * @param {string} platform - process.platform override
 * @returns {string} file name
 */
function legacyBinaryName(platform = process.platform) {
  return platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
}

class YtdlpEngine {
  /**
   * @param {Object} options - explicit paths (tests and callers pass these in;
   *   anything omitted is resolved from electron / the bundled resources)
   */
  constructor(options = {}) {
    this.options = options
    this.userDataPath = options.userDataPath || null
    this.resourcesPath = options.resourcesPath || null
    this.ffmpegPath = options.ffmpegPath || null
    this.denoPath = options.denoPath || null
    this.cookieFile = options.cookieFile || null
    this.cookieManager = options.cookieManager || null
    // whether this install has been refused and needs to escalate to a PO
    // token. it lives on the engine as a plain boolean because run() is
    // synchronous while the setting it comes from is on disk - whoever reads
    // settings pushes the answer in here, the same way the engine version is
    // pushed into analytics
    this.potEnabled = Boolean(options.potEnabled)
    this.watchdogMs = options.watchdogMs || DEFAULT_WATCHDOG_MS
    this.killGraceMs = options.killGraceMs || KILL_GRACE_MS
    this.spawnFn = options.spawnFn || spawn
    this.killFn = options.killFn || process.kill

    this.operations = new Map()

    // {path, version} - see getVersion()
    this.cachedVersion = null

    // downloads and self-updates share one gate so neither can start while the
    // other holds it - see OperationGate
    this.gate = options.gate || new OperationGate()
  }

  // ---------------------------------------------------------------------------
  // paths
  // ---------------------------------------------------------------------------

  getUserDataPath() {
    if (this.userDataPath) {
      return this.userDataPath
    }

    this.userDataPath = electronPath("userData") || path.join(os.tmpdir(), "cliply")
    return this.userDataPath
  }

  getResourcesPath() {
    if (this.resourcesPath) {
      return this.resourcesPath
    }

    // in development the repo root plays the role of resourcesPath
    this.resourcesPath =
      process.env.NODE_ENV === "development"
        ? path.join(__dirname, "..", "..", "..")
        : process.resourcesPath || path.join(__dirname, "..", "..", "..")

    return this.resourcesPath
  }

  // userData/engine is the updater's workspace (staging dirs land here too)
  getEngineDir() {
    return path.join(this.getUserDataPath(), "engine")
  }

  // ...and userData/engine/ytdlp is the unpacked engine itself
  getInstalledEngineDir() {
    return path.join(this.getEngineDir(), ENGINE_DIR_NAME)
  }

  getInstalledBinaryPath() {
    const directory = this.getInstalledEngineDir()
    return resolveExecutableIn(directory) || nominalExecutableIn(directory)
  }

  // the read-only copy that ships in the installer
  getBundledEngineDir() {
    return this.resolveBundledDir([
      [ENGINE_DIR_NAME],
      [PLATFORM_DIRS[process.platform] || process.platform, ENGINE_DIR_NAME]
    ])
  }

  getBundledBinaryPath() {
    const directory = this.getBundledEngineDir()
    return resolveExecutableIn(directory) || nominalExecutableIn(directory)
  }

  /**
   * the binary to run: the writable userData copy wins, resources is the fallback
   * @returns {string} path to yt-dlp
   */
  getBinaryPath() {
    const installed = resolveExecutableIn(this.getInstalledEngineDir())

    if (installed) {
      return installed
    }

    return this.getBundledBinaryPath()
  }

  getFfmpegPath() {
    if (this.ffmpegPath) {
      return this.ffmpegPath
    }

    const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
    this.ffmpegPath = this.resolveBundled(
      [[name], [PLATFORM_DIRS[process.platform] || process.platform, name]],
      true
    )

    return this.ffmpegPath
  }

  getDenoPath() {
    if (this.denoPath) {
      return this.denoPath
    }

    const name = process.platform === "win32" ? "deno.exe" : "deno"
    this.denoPath = this.resolveBundled(
      [
        ["deno", name],
        ["deno", PLATFORM_DIRS[process.platform] || process.platform, name]
      ],
      true
    )

    return this.denoPath
  }

  /**
   * where the PO token payload lives, or null when it is not installed
   *
   * two halves, both required: `plugin` is the provider yt-dlp loads through
   * --plugin-dirs, `server` is the generator the provider runs on deno. a jar
   * with only one of them cannot mint anything, so it is treated as absent
   * rather than passed on to fail later with a warning nobody reads.
   *
   * userData wins over the bundled copy, which is the precedence
   * getBinaryPath() already uses for the engine: the payload can either ship in
   * the installer or be downloaded later by the installs that turn out to need
   * it, and a downloaded copy is the newer of the two.
   *
   * @returns {{pluginDir: string, serverHome: string}|null}
   */
  /**
   * remember that this install has to send a PO token from now on
   *
   * separate from the constructor because the answer lives in the settings
   * file, which is read asynchronously long after the engine is built - and
   * because a refusal can arrive mid-session, at which point every later
   * operation should escalate without waiting for a restart.
   *
   * @param {boolean} enabled
   */
  setPotEnabled(enabled) {
    this.potEnabled = Boolean(enabled)
  }

  getPotPaths() {
    const roots = [
      path.join(this.getUserDataPath(), POT_DIR_NAME),
      path.join(this.getResourcesPath(), "binaries", POT_DIR_NAME)
    ]

    for (const root of roots) {
      const pluginDir = path.join(root, "plugin")
      const serverHome = path.join(root, "server")

      if (directoryExists(pluginDir) && directoryExists(serverHome)) {
        return { pluginDir, serverHome }
      }
    }

    return null
  }

  // first existing candidate under <resources>/binaries, packaged layout first
  resolveBundled(candidates, allowMissing = false) {
    const base = path.join(this.getResourcesPath(), "binaries")

    for (const segments of candidates) {
      const candidate = path.join(base, ...segments)
      if (fileExists(candidate)) {
        return candidate
      }
    }

    return allowMissing ? null : path.join(base, ...candidates[0])
  }

  // same idea for the engine, which is a directory rather than a single file
  resolveBundledDir(candidates) {
    const base = path.join(this.getResourcesPath(), "binaries")

    for (const segments of candidates) {
      const candidate = path.join(base, ...segments)
      if (directoryExists(candidate)) {
        return candidate
      }
    }

    return path.join(base, ...candidates[0])
  }

  /**
   * the cookie file to pass to --cookies, or null when there is nothing useful
   * @returns {string|null} cookie file path
   */
  getCookieFile() {
    if (this.cookieManager) {
      const fromManager = this.cookieManager.getCookieFilePath()
      return fromManager && cookieFileHasEntries(fromManager) ? fromManager : null
    }

    if (this.cookieFile && cookieFileHasEntries(this.cookieFile)) {
      return this.cookieFile
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // running operations
  // ---------------------------------------------------------------------------

  /**
   * spawn one yt-dlp operation
   * @param {string} operation - info | playlist-info | combined | audio | simple
   * @param {Object} params - operation parameters (url, formats, output, trim)
   * @param {Object} options - {id, watchdogMs, cwd, onProgress}
   * @returns {YtdlpOperation} handle with promise / cancel() / events
   */
  run(operation, params = {}, options = {}) {
    const resolved = {
      ...params,
      ffmpegPath: params.ffmpegPath || this.getFfmpegPath(),
      denoPath: params.denoPath || this.getDenoPath(),
      cookieFile:
        params.cookieFile !== undefined ? params.cookieFile : this.getCookieFile(),
      potPaths: params.potPaths !== undefined ? params.potPaths : this.getPotPaths(),
      potEnabled:
        params.potEnabled !== undefined ? params.potEnabled : this.potEnabled
    }

    const id = options.id || `${operation}_${Date.now()}_${this.operations.size}`
    const isInfo = operation === "info" || operation === "playlist-info"

    const handle = new YtdlpOperation({
      id,
      operation,
      binaryPath: this.getBinaryPath(),
      args: buildArgs(operation, resolved),
      // -P already decides where files land; inheriting a cwd that may not
      // exist would only turn into a confusing spawn ENOENT
      cwd: options.cwd || undefined,
      watchdogMs: options.watchdogMs || this.watchdogMs,
      collectStdout: isInfo,
      expectedStreams: expectedStreamCount(operation, resolved),
      // a trimmed download is muxed by ffmpeg in a single pass, so the format
      // marker would over-count the sweeps
      trackStreamMarker: !resolved.timeRange,
      gate: this.gate,
      killGraceMs: options.killGraceMs || this.killGraceMs,
      spawnFn: this.spawnFn,
      killFn: this.killFn
    })

    if (typeof options.onProgress === "function") {
      handle.on("progress", options.onProgress)
    }

    this.operations.set(id, handle)

    // drop the handle synchronously as it settles, so a caller that awaits the
    // promise sees an accurate active count the moment it resumes
    const forget = () => this.operations.delete(id)
    handle.once("completed", forget)
    handle.once("failed", forget)

    // a spawn that failed inside the constructor already emitted its event
    if (handle.settled) {
      forget()
    }

    // nobody is required to await the promise - swallow the rejection here so
    // an unawaited cancel can never become an unhandled rejection
    handle.promise.catch(() => {})

    return handle
  }

  /**
   * fetch video metadata
   * @param {string} url - video url
   * @param {Object} options - {watchdogMs, cookieFile}
   * @returns {Promise<Object>} the parsed --dump-json payload
   */
  async getInfo(url, options = {}) {
    const handle = this.run("info", { url, ...options }, options)
    const result = await handle.promise

    try {
      return JSON.parse(result.stdout.trim())
    } catch (error) {
      const parseError = new Error("Couldn't read the video details.")
      parseError.code = ERROR_CODES.DOWNLOAD_FAILED
      parseError.suggestion = "Please try again."
      parseError.details = error.message
      throw parseError
    }
  }

  /**
   * fetch playlist metadata (flat, one entry per video)
   * @param {string} url - playlist url
   * @param {Object} options - {maxVideos, watchdogMs}
   * @returns {Promise<Object[]>} one parsed json object per line
   */
  async getPlaylistInfo(url, options = {}) {
    const handle = this.run("playlist-info", { url, ...options }, options)
    const result = await handle.promise

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }

  downloadCombined(params, options = {}) {
    return this.run("combined", params, options)
  }

  downloadAudio(params, options = {}) {
    return this.run("audio", params, options)
  }

  downloadSimple(params, options = {}) {
    return this.run("simple", params, options)
  }

  /**
   * the engine version, cached
   *
   * a freshly unpacked onedir bundle pays a one-time os scan on its first run
   * (43 s measured on macos), so `--version` is not something the health checks
   * the renderer fires on mount should ever wait for twice. the answer only
   * changes when we replace the engine, which is what invalidateVersion() is for.
   *
   * @returns {Promise<string|null>} version string, or null when unusable
   */
  async getVersion() {
    const release = await this.gate.acquireRead()
    try {
      const binaryPath = this.getBinaryPath()

      if (this.cachedVersion && this.cachedVersion.path === binaryPath) {
        return this.cachedVersion.version
      }

      const version = await this.probeVersion(binaryPath)
      this.cachedVersion = { path: binaryPath, version }

      return version
    } finally {
      release()
    }
  }

  // call after seeding or a self-update swapped the binary
  invalidateVersion() {
    this.cachedVersion = null
  }

  /**
   * the version we already know, without going near the binary
   *
   * the application menu is built synchronously and the issue report has to
   * name the engine the moment it opens, so neither can await a probe. null
   * means we do not know - which is a state worth saying out loud rather than
   * papering over, since a refused seed leaves us in it for the whole run.
   *
   * @returns {string|null} version string, or null when unknown
   */
  getKnownVersion() {
    const binaryPath = this.getBinaryPath()

    return this.cachedVersion && this.cachedVersion.path === binaryPath
      ? this.cachedVersion.version
      : null
  }

  /**
   * take a version somebody else already probed
   *
   * the seed and the self-update both run `--version` on the engine they just
   * installed, and on a freshly unpacked onedir that first run is the one that
   * costs seconds. handing the answer back here means nothing downstream buys
   * it a second time.
   *
   * precondition: the caller probed the binary getBinaryPath() resolves to
   * *now*. this keys the answer to that path and asks nothing else - so a
   * caller that probes a staged engine before the swap, and reports it here,
   * files the new engine's version against the old one and every reader is
   * told the wrong thing until something invalidates it.
   *
   * @param {string} version - what that probe reported
   */
  rememberVersion(version) {
    // a probe that failed reports no version at all, and that is not an answer
    // worth keeping: recording it would forget a version we did have and pin
    // the result for the rest of the run, where an empty slot lets the next
    // getVersion() go and ask again
    if (!version) return

    this.cachedVersion = { path: this.getBinaryPath(), version }
  }

  /**
   * read the version of the binary that would be run
   * @param {string} binaryPath - optional override
   * @param {Object} options - {timeoutMs} - a first run needs far longer than
   *   a warm one, so the updater raises this when it probes a staged engine
   * @returns {Promise<string|null>} version string, or null when unusable
   */
  probeVersion(binaryPath = this.getBinaryPath(), options = {}) {
    const timeoutMs = options.timeoutMs || PROBE_TIMEOUT_MS
    const signal = options.signal || null

    return new Promise((resolve) => {
      let output = ""
      let child = null
      let settled = false
      let timeout = null
      let onAbort = null
      // a probe we killed cannot be trusted even if the child manages a clean
      // exit on its way out
      let discarded = false

      const settle = (value) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        if (onAbort && signal) signal.removeEventListener("abort", onAbort)
        resolve(value)
      }

      try {
        child = this.spawnFn(binaryPath, ["--version"], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true
        })
      } catch {
        settle(null)
        return
      }

      // node reports both "could not spawn" and "could not signal a running
      // child" as an error event. only the first means nothing is running.
      let spawned = typeof child.pid === "number"
      child.once("spawn", () => {
        spawned = true
      })

      // stopping the probe never settles the promise on its own: the caller
      // may be about to delete the directory this binary is running out of, so
      // it has to wait for the process to be confirmed gone
      const stop = () => {
        discarded = true
        killProcessTree(child, { spawnFn: this.spawnFn })
      }

      timeout = setTimeout(stop, timeoutMs)

      if (signal) {
        if (signal.aborted) {
          stop()
        } else {
          onAbort = stop
          signal.addEventListener("abort", onAbort)
        }
      }

      child.stdout.on("data", (data) => {
        output += data.toString()
      })

      child.on("close", (code) => {
        settle(!discarded && code === 0 && output.trim() ? output.trim() : null)
      })

      child.on("error", () => {
        if (spawned) {
          // the probe is still alive - only its close may settle this
          return
        }

        settle(null)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // bookkeeping
  // ---------------------------------------------------------------------------

  getActiveCount() {
    return this.operations.size
  }

  hasActiveOperations() {
    return this.operations.size > 0
  }

  getOperation(id) {
    return this.operations.get(id) || null
  }

  /**
   * cancel one operation
   * @param {string} id - operation id
   * @returns {boolean} whether it was cancelled
   */
  cancel(id) {
    const handle = this.operations.get(id)
    return handle ? handle.cancel() : false
  }

  // used on app quit - nothing should outlive the window
  cancelAll() {
    let cancelled = 0

    for (const handle of this.operations.values()) {
      if (handle.cancel()) {
        cancelled += 1
      }
    }

    return cancelled
  }

  /**
   * cancel everything and wait for the process tree to actually be gone,
   * not just for the signal to have been sent
   *
   * cancelAll() alone returns the moment signals go out - the sigterm grace
   * period and any taskkill spawn are still in flight. a caller that quits
   * right after it can exit before that escalation ever runs, orphaning
   * whatever yt-dlp had not managed to clean up yet. this waits for each
   * operation's own promise (which only settles once its child's close event
   * fires) instead, bounded so a wedged process can never hold the app open.
   *
   * @param {number} maxWaitMs - ceiling on how long to wait
   * @returns {Promise<number>} how many operations were cancelled
   */
  async awaitShutdown(maxWaitMs = SHUTDOWN_WAIT_MS) {
    // captured before cancelAll(), since a settling operation removes itself
    // from this.operations - the promises are what outlive that
    const settling = [...this.operations.values()].map((handle) =>
      handle.promise.catch(() => {})
    )
    const cancelled = this.cancelAll()

    if (settling.length > 0) {
      await Promise.race([
        Promise.all(settling),
        new Promise((resolve) => setTimeout(resolve, maxWaitMs))
      ])
    }

    return cancelled
  }
}

// =============================================================================
// small file helpers
// =============================================================================

function fileExists(filePath) {
  try {
    return Boolean(filePath) && fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function directoryExists(dirPath) {
  try {
    return Boolean(dirPath) && fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

// electron is absent in unit tests and build scripts
function electronPath(name) {
  try {
    const { app } = require("electron")
    return app && typeof app.getPath === "function" ? app.getPath(name) : null
  } catch {
    return null
  }
}

module.exports = {
  YtdlpEngine,
  YtdlpOperation,
  OperationGate,
  RingBuffer,
  ProgressTracker,
  LineSplitter,
  buildArgs,
  buildCommonArgs,
  buildDownloadArgs,
  buildTrimArgs,
  normalizeQualityTier,
  normalizeAudioMode,
  normalizeAudioLanguage,
  expectedStreamCount,
  parseProgressLine,
  parseDestinationLine,
  parseStreamCountLine,
  normalizeUrl,
  killProcessTree,
  redactLogLine,
  mapError,
  cookieFileHasEntries,
  executableCandidates,
  resolveExecutableIn,
  nominalExecutableIn,
  legacyBinaryName,
  ERROR_CODES,
  // exported so a test can hold the two wording tables to their invariant:
  // they must not share a key, or wordingFor would silently shadow one
  ERROR_METADATA,
  TERMINAL_ERRORS,
  // the explicit-code half of fail(), exported so the shape contract is tested
  // against what fail actually calls rather than a copy of it
  explicitError,
  PROGRESS_TEMPLATE,
  FILE_TEMPLATE,
  STREAM_TEMPLATE,
  ENGINE_DIR_NAME,
  STDERR_BUFFER_LINES,
  DEFAULT_WATCHDOG_MS,
  POSTPROCESS_WATCHDOG_MS,
  PROBE_TIMEOUT_MS,
  KILL_GRACE_MS,
  SHUTDOWN_WAIT_MS
}
