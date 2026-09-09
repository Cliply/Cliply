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

// the playlist item cap is owned by the mappers, next to the output templates
// whose index padding is derived from it - see the playlists section below
const {
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_ARCHIVE_DIR,
  escapeTemplateLiteral
} = require("../utils/ytdlp-mappers")

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

// the playlist half of the same three prints. a parallel set rather than three
// fields bolted onto the templates above, because a single-video run has no
// playlist context at all: %(info.playlist_autonumber)s renders as `NA` there,
// and every parser that reads these lines today would have to learn to ignore
// it. an operation picks one set or the other and the two never meet.
//
// PROGRESS carries **playlist_autonumber, never playlist_index**. autonumber
// is the item's position in the download *queue*: measured with `-I "1,5,9"`
// it reads 1, 2, 3 while playlist_index reads 1, 5, 9, so a bar built from the
// index would render "video 9 of 3". STREAM carries both, because the index is
// what names the file and what the per-row ui maps onto.
//
// there is no n_entries, which yt-dlp would happily supply. **the denominator
// is the selection the user made**, which the engine already knows and which
// nothing on this channel is allowed to contradict: an item that left the
// playlist between the listing and the download is one of the skipped, not a
// reason to quietly redefine the job as the smaller one that turned out to be
// possible. it is also the last number here that a forged line could move
const PLAYLIST_PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}%(progress._percent_str)s|%(progress._speed_str)s|` +
  `%(progress._eta_str)s|%(progress.eta)s|%(info.playlist_autonumber)s`
const PLAYLIST_STREAM_TEMPLATE =
  `before_dl:${STREAM_PREFIX}%(playlist_autonumber)s|%(playlist_index)s|%(id)s|%(format_id)s`
// ...and FILE carries the path as **json**, not as a bare string. yt-dlp
// sanitises the parts of a name it derives from a title, but it does not touch
// the -P the user chose: a legal directory holding a newline splits a bare
// print across two lines, and the engine would record the truncation as the
// file it saved (measured on 2026.08.19 with a directory named "nl\ndir").
// the `j` conversion escapes the newline, and escapes non-ascii while it is
// there, so one marker is always exactly one line
const PLAYLIST_FILE_TEMPLATE =
  `after_move:${FILE_PREFIX}%(playlist_autonumber)s|%(filepath)j`

// ...and the same fact again, on a channel nothing else can write to.
//
// stdout is a **mixed** channel: --no-quiet puts yt-dlp's own log on it, and
// some of that log is metadata we did not author. a playlist title carrying a
// newline and a well-formed CLIPLY_FILE line after it is printed verbatim, so
// a marker on stdout is not evidence that anything was saved - and no amount
// of checking the path it names can fix that, because it can name a real file
// in the real download folder. measured: an unrelated mp4 seeded in the
// destination was reported as the saved item of a run whose only download
// failed.
//
// --print-to-file appends this template to a file only we know the name of,
// and only yt-dlp's own after_move hook appends to it. the template prints no
// free text, so nothing that reaches the file came from anywhere else. that
// file is the single source of truth for what was saved; the stdout marker
// above is kept for live per-row progress and decides nothing
const PLAYLIST_RECORD_TEMPLATE = "after_move:%(playlist_autonumber)s|%(filepath)j"

// where those records live, under the engine's own state rather than the
// user's download folder
const PLAYLIST_RECORDS_DIR = "runs"

// the extractor half of a download-archive key. the playlist operations are
// youtube-only, so this is the only prefix an archive line may carry to be a
// record of something a selection of ours could be talking about
const PLAYLIST_ARCHIVE_EXTRACTOR = "youtube"

// the record channel is the whole basis for saying anything was saved, so a
// run that cannot prove the file is fresh does not start at all. its own
// wording, because the taxonomy's permission entry is about the folder the
// user picked and this one is about ours
const RECORDS_UNWRITABLE = {
  message: "Cliply couldn't prepare its record of this download.",
  suggestion: "Check permissions on Cliply's app data folder and try again."
}

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

/**
 * a netscape cookie row, as yt-dlp quotes one back at you
 *
 * both of its loaders print the offending line verbatim - "skipping cookie file
 * entry due to invalid length 8: '...'" and "invalid Netscape format cookies
 * file: '...'" - and the last column of that row is the cookie's value. Those
 * lines are kept in the stderr tail, the tail is attached to a failure, and the
 * report dialog puts the failure in a github issue url and on the clipboard. So
 * a single malformed row was a session token one click from being published.
 *
 * an earlier version kept the six structural columns, on the grounds that
 * knowing which cookie and which domain makes a report useful. That meant
 * matching python's repr of the row, column by column, and it leaked three
 * different ways: an escaped separator was inside the character class so a
 * column ran straight through it, a value containing an apostrophe flips python
 * to double quotes and ended the match early, and a flag spelled `true` matched
 * no pattern at all. Each fix was another clause guessing at repr syntax.
 *
 * so the row goes, whole. Everything from the first flag column to the end of
 * the line is replaced without reading it, which cannot leak a value it never
 * parses, and the diagnostic keeps the part worth having: that a row was
 * refused, and how many columns it had.
 */
const COOKIE_ROW_RE = /(?:\\t|\t)(?:TRUE|FALSE)(?:\\t|\t).*$/gim

// and the same protection for a row too malformed to have a recognisable flag
// column, keyed off yt-dlp's own wording rather than the row's shape
const COOKIE_DIAGNOSTIC_RE =
  /(skipping cookie file entry due to invalid length \d+:|invalid Netscape format cookies file:).*$/gim

const REDACTIONS = [
  [/\/Users\/[^/\\\s"'<>]+/g, "/Users/~"],
  [/\/home\/[^/\\\s"'<>]+/g, "/home/~"],
  [/([A-Za-z]):\\Users\\[^\\<>"|?*\n\r]+/g, "$1:\\Users\\~"],
  [/(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/g, "$1?<redacted>"],
  // the diagnostic first, so a row with no usable flag column is still cut off
  // at yt-dlp's own wording rather than surviving to the shape rule
  [COOKIE_DIAGNOSTIC_RE, "$1 <cookie row redacted>"],
  [COOKIE_ROW_RE, "<cookie row redacted>"]
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
   * mweb is named because a provider yt-dlp never consults mints nothing.
   *
   * 0.3.6 shipped this without a player_client, on the reasoning that yt-dlp
   * picks its own clients and asks for a token when the one it picked needs
   * one. That was measured on a machine youtube was not refusing, where the
   * default `web` client did ask. On refused machines it mostly does not: the
   * default clients are chosen precisely to avoid needing a token, so the
   * payload sat installed and idle. The telemetry put a number on it - the
   * same installs went from 3.7% to 16.3% of metadata fetches succeeding once
   * the payload landed, which is a token being fetched sometimes rather than
   * always.
   *
   * mweb requires a gvs token, so asking for it is what turns "the provider
   * may be consulted" into "the provider is consulted". It is also what
   * yt-dlp's own guidance says to reach for once the default clients are the
   * thing failing, which is exactly the state an escalated install is in.
   *
   * fetch_pot stays at its `auto` default. `always` would force a token even
   * where the client does not need one, and with mweb selected the two agree
   * anyway - so this remains yt-dlp's call, tracking youtube's rollout.
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
    args.push("--extractor-args", "youtube:player_client=mweb")
    args.push(
      "--extractor-args",
      `youtubepot-bgutilscript:server_home=${potPaths.serverHome}`
    )
  }

  return args
}

// progress + final-filename plumbing, plus the output location
//
// `playlist` swaps in the three PLAYLIST_* templates and changes nothing else.
// it is a flag rather than a second function because everything below the
// templates - the --no-quiet reasoning, -P, the filename trimming - is the
// same argument for both, and a copy of it would be a copy to keep in step
function buildDownloadArgs({ outputDir, outputTemplate, playlist = false } = {}) {
  // --print implies --quiet, so --progress is what keeps progress lines coming
  const args = [
    "--progress",
    "--progress-template",
    playlist ? PLAYLIST_PROGRESS_TEMPLATE : PROGRESS_TEMPLATE,
    "--print",
    playlist ? PLAYLIST_STREAM_TEMPLATE : STREAM_TEMPLATE,
    "--print",
    playlist ? PLAYLIST_FILE_TEMPLATE : FILE_TEMPLATE,
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

// =============================================================================
// playlists
// =============================================================================

// PLAYLIST_MAX_ITEMS - the ceiling on any one link, for the listing and for
// the selection built out of it - is imported at the top of this file rather
// than declared here. it lives beside the output templates because the item
// numbers in a filename are padded to its width, and those two must not be
// able to drift apart

// --skip-playlist-after-errors: how many items may fail before yt-dlp gives up
// on the rest. an old playlist always carries a few deleted videos, so a
// handful of failures is the normal shape and only a run going systematically
// wrong should stop early. this is yt-dlp's own circuit breaker
const PLAYLIST_ERROR_BUDGET = 5

// --sleep-requests, in seconds. yt-dlp's playlist guide calls pacing "not
// optional": one process walking 100 items at full speed is exactly what gets
// a single ip rate-limited
const PLAYLIST_SLEEP_REQUESTS = 1

// --concurrent-fragments. this speeds up the video being downloaded *now* by
// fetching its dash fragments in parallel; it is not several videos at once.
// yt-dlp walks a playlist strictly one video at a time and nothing here
// changes that
const PLAYLIST_FRAGMENTS = 4

// a playlist is mp4 at every height, unlike the per-tier container a single
// video gets. `-t mp4` does not fall back to 1080p h264 above 1080p - measured
// on a 4k video it takes the vp9 stream and remuxes it into mp4 - so one
// container buys a predictable extension for the whole folder at no cost
const PLAYLIST_CONTAINER = "mp4"

// the -I spec is written straight onto the command line, so it is whitelisted
// for the same reason TIER_CONTAINERS and AUDIO_LANGUAGE_PATTERN are: a list
// of indices arriving over ipc does not get to write yt-dlp option syntax
const PLAYLIST_ITEMS_PATTERN = /^[0-9,:]+$/

/**
 * validate a selection of 1-based playlist positions
 *
 * @param {number[]} indices - the positions the user ticked
 * @returns {number[]} the same positions, sorted and de-duplicated
 * @throws {Error} when the selection is empty, or holds anything that is not a
 *   position inside the cap
 */
function normalizePlaylistIndices(indices) {
  // an empty selection is not an empty spec. `-I ""` is not "download nothing",
  // it is the absence of a selection - which downloads the entire playlist. so
  // "nothing was ticked" has to fail here rather than quietly become the
  // largest possible download
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error("A playlist download needs at least one selected item.")
  }

  const seen = new Set()

  for (const value of indices) {
    // a position is an integer and only an integer: coercing "3" or 3.5 into
    // one would launder a malformed payload into something the spec accepts
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`Not a playlist position: ${JSON.stringify(value)}`)
    }

    if (value < 1 || value > PLAYLIST_MAX_ITEMS) {
      throw new Error(`Playlist position out of range: ${value}`)
    }

    seen.add(value)
  }

  return [...seen].sort((a, b) => a - b)
}

/**
 * turn a selection into yt-dlp's -I syntax, compressing runs
 *
 * `[1,2,4,5,6,7,8,9]` becomes `"1,2,4:9"`. yt-dlp reads `a:b` as an inclusive
 * range, so a run of three or more is worth collapsing; a pair is left alone
 * because "4,5" is the same length as "4:5" and reads as what it is.
 *
 * @param {number[]} indices - the positions the user ticked
 * @returns {string} the -I spec
 * @throws {Error} for anything normalizePlaylistIndices rejects
 */
function buildPlaylistItemsSpec(indices) {
  const positions = normalizePlaylistIndices(indices)
  const parts = []

  let runStart = positions[0]
  let runEnd = positions[0]

  const flush = () => {
    if (runEnd - runStart >= 2) {
      parts.push(`${runStart}:${runEnd}`)
      return
    }

    for (let position = runStart; position <= runEnd; position += 1) {
      parts.push(String(position))
    }
  }

  for (const position of positions.slice(1)) {
    if (position === runEnd + 1) {
      runEnd = position
      continue
    }

    flush()
    runStart = position
    runEnd = position
  }

  flush()

  const spec = parts.join(",")

  // the loop above can only emit digits, commas and colons - this is what
  // keeps that true the next time somebody edits it
  if (!PLAYLIST_ITEMS_PATTERN.test(spec)) {
    throw new Error("Refusing to hand yt-dlp a malformed playlist selection.")
  }

  return spec
}

/**
 * the flags that turn one invocation into a playlist walk
 *
 * every one of these comes from yt-dlp's own playlist guide, which is worth
 * following rather than improvising: an old playlist always holds a few
 * deleted videos, and these are the flags that keep that from ending the run.
 *
 * @param {Object} params - {playlistIndices, archiveFile}
 * @returns {string[]} args
 */
/**
 * the positions this run will download
 *
 * a caller may send bare positions or `[{index, id}]` entries. the ids are
 * what lets the engine work out how many items the archive will skip without
 * reading yt-dlp's English back off stdout, so entries are preferred - but
 * the selection itself is the indices either way
 *
 * @param {Object} params - {playlistIndices, playlistEntries}
 * @returns {number[]} the 1-based positions
 */
function playlistSelection({ playlistIndices, playlistEntries } = {}) {
  if (Array.isArray(playlistEntries) && playlistEntries.length > 0) {
    return playlistEntries.map((entry) => (entry ? entry.index : entry))
  }

  return playlistIndices
}

/**
 * where a run's save records live
 *
 * engine-owned state, beside the archives and well away from the user's
 * download folder: nothing but yt-dlp's own after_move hook may append here
 *
 * @param {Object} options - {userDataPath, operationId}
 * @returns {string|null} absolute path, or null without a userData path
 */
function buildPlaylistRecordsPath({ userDataPath, operationId } = {}) {
  if (!userDataPath) {
    return null
  }

  // the id reaches a filename, and an id is one of the few things a caller
  // hands us verbatim - so it is whitelisted rather than trusted
  const name = String(operationId || "").replace(/[^A-Za-z0-9._-]/g, "") || "run"

  return path.join(userDataPath, PLAYLIST_ARCHIVE_DIR, PLAYLIST_RECORDS_DIR, `${name}.records`)
}

function buildPlaylistArgs({ playlistIndices, playlistEntries, archiveFile, ignoreArchive } = {}) {
  const args = [
    // a declaration of intent rather than a correction: on a
    // `watch?v=...&list=...` link yt-dlp's own default is already the playlist
    // (measured against 2026.08.19 - a flat listing of one returns
    // `_type: "playlist"` with every entry). today's single-video behaviour is
    // ours, and comes from the explicit --no-playlist in `combined`, `audio`
    // and `simple`. saying the opposite out loud here is what keeps the two
    // halves of the app readable side by side
    "--yes-playlist",
    "-I",
    buildPlaylistItemsSpec(playlistSelection({ playlistIndices, playlistEntries })),
    "--skip-playlist-after-errors",
    String(PLAYLIST_ERROR_BUDGET),
    "--sleep-requests",
    String(PLAYLIST_SLEEP_REQUESTS),
    // no --max-downloads. yt-dlp's guide reaches for it as a safety cap, but
    // -I already bounds this run to the selection and buildPlaylistItemsSpec
    // caps that at PLAYLIST_MAX_ITEMS, so there is nothing left for it to
    // protect against - and it is not free. yt-dlp exits **101** the moment
    // the limit is reached rather than exceeded: measured against 2026.08.19,
    // `--max-downloads 2` over two items exits 101 while `--max-downloads 3`
    // over the same two exits 0. a cap that can only ever fire on a run that
    // downloaded everything it was asked for is a trap for whoever reads the
    // exit code
    "-N",
    String(PLAYLIST_FRAGMENTS)
  ]

  // resume: yt-dlp skips anything already listed in the archive, so an
  // interrupted run picks up where it stopped instead of starting over.
  // optional in the same way --cookies is - a caller with nowhere to keep the
  // file still gets a working download, it just re-fetches on a retry.
  //
  // `ignoreArchive` is "download all of it again", and it *omits* the flag
  // rather than pointing it somewhere harmless: yt-dlp writes to the archive
  // it is given as well as reading it, so a decoy would still record this run
  // and change what the next one does. only a literal true, because this is
  // the one option whose accidental truthiness re-downloads a hundred videos
  if (archiveFile && ignoreArchive !== true) {
    args.push("--download-archive", archiveFile)
  }

  return args
}

// the archive skip: an item recorded in --download-archive is never announced,
// never extracted and never downloaded - yt-dlp prints this one line and moves
// to the next item (measured against 2026.08.19). the id is the only handle we
// get on it, which is why this pattern captures it: it is what keeps two skips
// of the same run from collapsing into one count
// the title is optional because yt-dlp builds this line with
// format_field(info, "title", "%s "), which renders as empty for a null title -
// exactly what a video that was archived while public and has gone private
// since now reports. the id is always there, and the id is all we need
const ARCHIVE_SKIP_PATTERN =
  /^\[download\]\s+([^\s:]+):\s(?:.*\s)?has already been recorded in the archive$/

/**
 * parse one line of the record file yt-dlp appended to
 *
 * the same `<autonumber>|<json path>` shape the stdout marker carries, minus
 * the prefix - this file holds nothing else, so there is nothing to recognise
 *
 * @param {string} line - one line of the record file
 * @returns {Object|null} {itemIndex, filePath}, or null for anything else
 */
function parsePlaylistRecordLine(line) {
  const text = stripAnsi(line).trim()
  const separator = text.indexOf("|")

  if (separator === -1) {
    return null
  }

  let filePath
  try {
    filePath = JSON.parse(text.slice(separator + 1))
  } catch {
    return null
  }

  if (typeof filePath !== "string" || !filePath) {
    return null
  }

  return { itemIndex: parsePlaylistCounter(text.slice(0, separator)), filePath }
}

/**
 * decide whether a recorded path really is a file in the download folder
 *
 * two questions: is it inside the folder we asked yt-dlp to write to, and is
 * it a file. *which run wrote it* is not one of them, and deliberately so -
 * the record file already answers that. it is created per run, cleared before
 * the spawn and deleted on settle, so a line in it was appended by this run's
 * after_move hook whatever the file's own age. measured: a re-run over files
 * that are already on disk fires after_move for each of them and leaves their
 * mtimes untouched, so an "is this newer than the run" test throws away every
 * item of a legitimate second download.
 *
 * containment goes through realpath on both sides. path.resolve collapses
 * ".." but does not follow links, while statSync does - so a symlink inside
 * the destination pointing out of it satisfied a resolve-and-stat pair while
 * naming a file somewhere else entirely. resolving the root too keeps a
 * download folder that is itself a symlink working, which plenty are.
 *
 * @param {string} filePath - the recorded path
 * @param {string} outputDir - the folder the run was given
 * @returns {string|null} the resolved path, or null when it proves nothing
 */
function verifySavedFile(filePath, outputDir) {
  if (!filePath || !outputDir) {
    return null
  }

  try {
    const root = fs.realpathSync(outputDir)
    const resolved = fs.realpathSync(filePath)

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return null
    }

    return fs.statSync(resolved).isFile() ? resolved : null
  } catch {
    // realpath throws for anything that is not there, which is its own answer
    return null
  }
}

/**
 * the ids a download archive already holds
 *
 * yt-dlp's archive key is the **pair** `<extractor> <id>`, and the pair is
 * what it skips on. keeping only the id made a `vimeo aaaaaaaaaaa` line vouch
 * for a youtube video that happens to share those eleven characters, so a run
 * that downloaded nothing at all reported an item as already had. these
 * operations are youtube-only and the shipped binary writes exactly
 * `youtube <id>` for them (measured on the archives our own captures left
 * behind), so nothing else is an archive record as far as this is concerned.
 *
 * a missing file is an empty set rather than an error: that is the first run
 *
 * @param {string|null} archiveFile - path to the archive, if there is one
 * @returns {Set<string>} the ids recorded in it for our own extractor
 */
function readArchivedIds(archiveFile) {
  const ids = new Set()

  if (!archiveFile) {
    return ids
  }

  let contents
  try {
    contents = fs.readFileSync(archiveFile, "utf8")
  } catch {
    return ids
  }

  for (const line of contents.split(/\r?\n/)) {
    // exactly two fields, and the first is ours. a line carrying anything
    // else is a record of something this selection cannot be talking about
    const parts = line.trim().split(/\s+/)

    if (parts.length === 2 && parts[0] === PLAYLIST_ARCHIVE_EXTRACTOR && parts[1]) {
      ids.add(parts[1])
    }
  }

  return ids
}

/**
 * which of the selected positions this archive will make yt-dlp skip
 *
 * counted per **position**, not per id: a playlist can hold one video three
 * times, and the denominator counts positions. no entries means the caller
 * sent positions without ids, so there is nothing to match on and the honest
 * answer is none - which undercounts rather than inventing reuse.
 *
 * the positions themselves, and not only how many there are, because an
 * archive-skipped video is never announced on stdout at all: without this the
 * ui has no way to tell those rows from the ones the run never reached, and
 * would settle a video the user already has as skipped.
 *
 * @param {Array|null} entries - [{index, id}] for the selected positions
 * @param {Set<string>} archivedIds - what the archive already holds
 * @returns {number[]} the positions already recorded, in the order given
 */
function archivedSelectionIndices(entries, archivedIds) {
  if (!Array.isArray(entries) || archivedIds.size === 0) {
    return []
  }

  return entries
    .filter((entry) => entry && archivedIds.has(entry.id))
    .map((entry) => entry.index)
}

/**
 * how many of the selected positions this archive will make yt-dlp skip
 *
 * @param {Array|null} entries - [{index, id}] for the selected positions
 * @param {Set<string>} archivedIds - what the archive already holds
 * @returns {number} how many selected positions are already recorded
 */
function countArchivedSelections(entries, archivedIds) {
  return archivedSelectionIndices(entries, archivedIds).length
}

// there is deliberately no parser for `[download] <path> has already been
// downloaded` here. yt-dlp prints that sentence for the *input* to a
// postprocessor as readily as for a finished output: a cancelled mp3
// conversion leaves a complete .webm behind, and the retry announces that
// source and then fails the conversion, so the file the user asked for never
// exists. a merge intermediate does the same with an .f134.mp4. no test on
// the filename can tell an unfinished input from a finished output, so the
// line is not evidence and only after_move counts. the shipped binary fires
// after_move for a genuinely finished existing output, so nothing is lost;
// a future binary that stopped would undercount, which is the safe direction

/**
 * read one of the playlist counter fields
 *
 * yt-dlp renders these as `NA` whenever it has no playlist context to fill
 * them from, so "absent" is a normal reading rather than a malformed line
 *
 * @param {string} value - one raw field
 * @returns {number|null} a 1-based position or count, or null
 */
function parsePlaylistCounter(value) {
  if (isUnknownValue(value)) {
    return null
  }

  const parsed = parseInt(stripAnsi(value).trim(), 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * parse one playlist CLIPLY| progress line
 *
 * @param {string} line - raw stdout line
 * @returns {Object|null} {progress, speed, eta, etaSeconds, itemIndex, totalItems}
 */
function parsePlaylistProgressLine(line) {
  // the first four fields are the single-video template's, read by the single
  // video parser: the two templates share that prefix on purpose, and this is
  // what stops them drifting into two opinions about a percentage or an eta
  const parsed = parseProgressLine(line)

  if (!parsed) {
    return null
  }

  const parts = stripAnsi(line).trim().slice(PROGRESS_PREFIX.length).split("|")

  return {
    ...parsed,
    // playlist_autonumber, not playlist_index - see PLAYLIST_PROGRESS_TEMPLATE
    // for why the other one would render "video 9 of 3".
    //
    // and only this one field: anything past it is ignored rather than read.
    // n_entries used to sit at parts[5], and a fixture or a binary we have not
    // met may still print it there - it must not become a denominator by the
    // back door now that the selection owns that number
    itemIndex: parsePlaylistCounter(parts[4])
  }
}

/**
 * parse the playlist before_dl marker: a new item is starting
 *
 * @param {string} line - raw stdout line
 * @returns {Object|null} {itemIndex, playlistIndex, videoId, streams}
 */
function parsePlaylistStreamLine(line) {
  const text = stripAnsi(line).trim()

  if (!text.startsWith(STREAM_PREFIX)) {
    return null
  }

  const parts = text.slice(STREAM_PREFIX.length).split("|")
  const formatId = stripAnsi(parts[3] || "").trim()

  if (!formatId) {
    return null
  }

  return {
    itemIndex: parsePlaylistCounter(parts[0]),
    playlistIndex: parsePlaylistCounter(parts[1]),
    videoId: isUnknownValue(parts[2]) ? null : stripAnsi(parts[2]).trim(),
    // the same arithmetic parseStreamCountLine does: "134+140" is a merge, so
    // this item will sweep 0-100 twice
    streams: formatId.split("+").filter(Boolean).length || 1
  }
}

/**
 * parse the playlist after_move print: an item landed on disk
 *
 * @param {string} line - raw stdout line
 * @returns {Object|null} {itemIndex, filePath}
 */
function parsePlaylistFileLine(line) {
  const text = stripAnsi(line).trim()

  if (!text.startsWith(FILE_PREFIX)) {
    return null
  }

  const rest = text.slice(FILE_PREFIX.length)
  const separator = rest.indexOf("|")

  if (separator === -1) {
    return null
  }

  // split on the *first* separator only, then decode. the tail is json (see
  // PLAYLIST_FILE_TEMPLATE), which is what makes both of those safe: a "|" or
  // a newline inside the path is escaped, so it can neither be mistaken for a
  // separator nor cut the marker in half
  let filePath
  try {
    filePath = JSON.parse(rest.slice(separator + 1).trim())
  } catch {
    return null
  }

  if (typeof filePath !== "string" || !filePath) {
    return null
  }

  return { itemIndex: parsePlaylistCounter(rest.slice(0, separator)), filePath }
}

/**
 * parse an archive skip - an item we already have, that will never download
 *
 * @param {string} line - raw stdout line
 * @returns {string|null} the video id, or null when this is not an archive skip
 */
function parseArchiveSkipLine(line) {
  const match = stripAnsi(line).trim().match(ARCHIVE_SKIP_PATTERN)

  return match ? match[1] : null
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
 * @param {string} operation - info | playlist-info | combined | audio |
 *   simple | playlist-combined | playlist-audio
 * @param {Object} params - operation parameters
 * @returns {string[]} yt-dlp args, url last
 */
function buildArgs(operation, params = {}) {
  const args = buildCommonArgs(params)

  // the output shape follows the **operation**, and is never read off params.
  // the two template sets are not interchangeable - the single-video parser
  // reads a playlist `CLIPLY_FILE|1|/path` as the file path "1|/path" - so a
  // stray `playlist` key arriving over ipc does not get to choose between
  // them, for the same reason PLAYLIST_ITEMS_PATTERN exists
  const playlist = operation === "playlist-combined" || operation === "playlist-audio"

  switch (operation) {
    case "info": {
      args.push("--dump-json", "--no-download", "--no-playlist")
      break
    }

    case "playlist-info": {
      // --dump-single-json, not --dump-json. one object carrying
      // playlist_count, title, uploader and entries[], instead of one line per
      // entry with the playlist's own size nowhere in the output.
      //
      // the two are not alternatives to choose between: passing both makes
      // yt-dlp print the per-entry lines *and* the object - 14 lines for a
      // 13-item playlist, measured against 2026.08.19 - which is not something
      // JSON.parse will take
      args.push(
        "--no-download",
        "--flat-playlist",
        "--dump-single-json",
        // the same declaration of intent the download operations make. a
        // `watch?v=...&list=...` link would list the playlist anyway, but a
        // listing operation that stayed silent about it reads as though it had
        // been forgotten
        "--yes-playlist",
        "-I",
        `1:${PLAYLIST_MAX_ITEMS}`
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
      args.push(...buildDownloadArgs({ ...params, playlist }))
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
      args.push(...buildDownloadArgs({ ...params, playlist }))
      args.push(...buildTrimArgs(params))
      break
    }

    case "playlist-combined":
    case "playlist-audio": {
      // structural, not cosmetic. `--download-sections` across videos of
      // different lengths is meaningless, so the operation refuses a time range
      // outright rather than leaving it to the ui to hide the control - a
      // future caller cannot quietly produce a run nobody can explain
      if (params.timeRange) {
        throw new Error("A playlist download cannot be trimmed.")
      }

      if (operation === "playlist-combined") {
        const { height } = normalizeQualityTier(params)

        // ORDER IS LOAD-BEARING here for the reason spelled out in `combined`
        // above. the container is *not* read off the tier: a playlist is
        // PLAYLIST_CONTAINER at every height
        args.push("-t", PLAYLIST_CONTAINER)

        if (height) {
          args.push("-S", `res:${height}`)
        }
      } else {
        const preset = AUDIO_MODE_PRESETS[normalizeAudioMode(params)]

        // the same two shapes `audio` has, minus the dub picker: the languages
        // a video carries are read out of *its* format list, and a playlist
        // has one list per video. so every item gets its original track, which
        // is yt-dlp's own default anyway
        args.push(...(preset ? ["-t", preset] : ["-f", "ba/b"]))
      }

      args.push(...buildPlaylistArgs(params))

      // the private save channel, which is what the outcome is read from.
      // FILE takes output-template syntax, so the path is escaped for the
      // same reason buildSimpleOutputTemplate escapes a title: a folder
      // called "100%(id)s" would otherwise be *expanded* and the records
      // would be written somewhere nobody goes looking
      if (params.recordsFile) {
        args.push(
          "--print-to-file",
          PLAYLIST_RECORD_TEMPLATE,
          escapeTemplateLiteral(params.recordsFile)
        )
      }

      args.push(...buildDownloadArgs({ ...params, playlist }))
      break
    }

    case "simple": {
      // tiktok / pinterest - one muxed file, no format picking
      args.push("-f", params.formatSelector || "best")
      args.push("--no-playlist")
      args.push(...buildDownloadArgs({ ...params, playlist }))
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
/**
 * hosts the youtube jar is for
 *
 * youtube-nocookie is in here because it is still a youtube extraction: the
 * name is about the embed not setting third-party cookies, not about ours.
 */
const YOUTUBE_HOSTS =
  /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i

/**
 * is this url one the youtube cookie jar has any business being sent with?
 *
 * --cookies is a save destination as well as a read source, so attaching the
 * jar to a pinterest or tiktok download does not merely fail to help - yt-dlp
 * writes that site's cookies back into youtube_cookies.txt on the way out.
 * Verified against the bundled binary: one run against an unrelated host left
 * its cookie sitting in the jar next to LOGIN_INFO. Every such download also
 * rewrites the file, which is a chance to lose the login for no upside.
 *
 * (nothing leaks the other way - http.cookiejar only sends cookies whose
 * domain matches the request - so this is about what we write, not what we
 * expose.)
 *
 * @param {string} url - the url the operation is for
 * @returns {boolean}
 */
function isYouTubeUrl(url) {
  try {
    return YOUTUBE_HOSTS.test(new URL(String(url)).hostname)
  } catch {
    return false
  }
}

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
  // a playlist item is a single video: it runs the very same 1-or-2-sweep
  // cycle, once per item. so for a playlist this is the opening guess for
  // *each* item rather than for the run, and the per-item before_dl marker
  // corrects it the same way
  if (operation !== "combined" && operation !== "playlist-combined") {
    return 1
  }

  // a time range hands the whole job to ffmpeg, which reports one sweep no
  // matter how many formats it is muxing. a playlist can never carry one -
  // buildArgs refuses it - so this only ever fires for a single video
  if (params.timeRange) {
    return 1
  }

  // a video download merges a video stream with an audio one
  return 2
}

/**
 * how many items a playlist run is about to walk
 *
 * **the denominator, for the bar and for every count the run reports.** it is
 * the selection the user made, and nothing yt-dlp prints revises it: an item
 * that left the playlist between the listing and the download is one of the
 * skipped rather than a reason to shrink the job to fit.
 *
 * @param {string} operation - the operation about to run
 * @param {Object} params - operation parameters
 * @returns {number|null} the selection size, or null for a non-playlist run
 */
function expectedItemCount(operation, params = {}) {
  if (operation !== "playlist-combined" && operation !== "playlist-audio") {
    return null
  }

  try {
    return normalizePlaylistIndices(playlistSelection(params)).length
  } catch {
    // a selection this malformed never reaches a spawn: buildArgs throws on it
    // first. answering null here keeps the two from racing to report it
    return null
  }
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

/**
 * the same bar, one level up: a run of items, each of which is its own download
 *
 * one ProgressTracker per item, thrown away and rebuilt at every before_dl
 * marker. that reset is the point of the class - an item's sweep counter is
 * only meaningful inside that item, and carrying it across would open item 2
 * at 50% because item 1 finished two streams.
 *
 * the run's own bar is `(itemsCompleted + itemProgress / 100) / totalItems`,
 * so it advances smoothly through an item instead of jumping only when one
 * lands.
 */
class PlaylistProgressTracker {
  constructor({ expectedStreams = 1, totalItems = null } = {}) {
    this.expectedStreamsPerItem = Math.max(1, expectedStreams)
    this.totalItems = totalItems && totalItems > 0 ? totalItems : null

    this.item = new ProgressTracker(this.expectedStreamsPerItem)
    this.itemIndex = 1
    this.playlistIndex = null
    this.videoId = null
    this.itemsCompleted = 0
    // whether the item in flight has already been counted whole. its own
    // percentage stops being added on top of itemsCompleted the moment it has,
    // or an item landing would count twice
    this.itemSettled = false
    this.lastOverall = 0
  }

  // the two the operation reads off a tracker without caring which kind it is
  get streamIndex() {
    return this.item.streamIndex
  }

  get expectedStreams() {
    return this.item.expectedStreams
  }

  /**
   * a new item is starting - reset everything that is per-item
   * @param {Object} marker - {itemIndex, playlistIndex, videoId, streams}
   */
  startItem(marker = {}) {
    if (marker.itemIndex) {
      // an autonumber past the end of the selection is not a position in this
      // run. it only ever moves the bar, but there is no reason to let it
      this.itemIndex = this.totalItems
        ? Math.min(marker.itemIndex, this.totalItems)
        : marker.itemIndex
    }

    // the item before this one is done with, however it ended. an item that
    // failed extraction prints no progress and no after_move at all, so
    // counting only the files that landed would freeze the bar for the rest of
    // a run the moment one video turned out to be private
    this.itemsCompleted = Math.max(this.itemsCompleted, this.itemIndex - 1)

    if (marker.playlistIndex !== undefined) {
      this.playlistIndex = marker.playlistIndex
    }
    if (marker.videoId !== undefined) {
      this.videoId = marker.videoId
    }

    this.item = new ProgressTracker(this.expectedStreamsPerItem)
    this.itemSettled = false

    if (marker.streams) {
      this.item.setExpectedStreams(marker.streams)
    }
  }

  /**
   * an item landed on disk
   * @param {number|null} itemIndex - its autonumber, when the print carried one
   */
  completeItem(itemIndex = null) {
    const completed = Number.isInteger(itemIndex) ? itemIndex : this.itemsCompleted + 1

    this.itemsCompleted = Math.max(this.itemsCompleted, completed)

    // the item in flight is now counted whole, so stop adding its own
    // percentage on top: item 1 of 2 landing would otherwise read
    // (1 + 1) / 2 - a full bar with half the playlist still to download, and
    // the monotonic clamp would pin it there for the rest of the run
    if (!Number.isInteger(itemIndex) || itemIndex >= this.itemIndex) {
      this.itemSettled = true
    }
  }

  update(parsed) {
    // the denominator is never taken off the wire - it is the selection, set
    // once at construction. see PLAYLIST_PROGRESS_TEMPLATE

    // a marker we never saw - the item still has to start, or its progress
    // would be folded into the previous one's
    if (parsed.itemIndex && parsed.itemIndex > this.itemIndex) {
      this.startItem({ itemIndex: parsed.itemIndex })
    }

    return this.snapshot(this.item.update(parsed))
  }

  /**
   * the current reading, with or without a fresh progress line behind it
   * @param {Object|null} itemUpdate - what the item's own tracker just returned
   * @returns {Object} the progress event
   */
  snapshot(itemUpdate = null) {
    const item = itemUpdate || {
      progress: this.item.lastOverall,
      streamProgress: this.item.lastStreamProgress,
      streamIndex: this.item.streamIndex,
      speed: null,
      eta: null,
      etaSeconds: null
    }

    // the selection, set once at construction. a caller that sent none leaves
    // the item in flight as the only lower bound on the run's length
    const totalItems = this.totalItems || Math.max(this.itemIndex, 1)
    const inFlight = this.itemSettled ? 0 : item.progress / 100
    const overall = ((this.itemsCompleted + inFlight) / totalItems) * 100

    this.lastOverall = Math.min(100, Math.max(this.lastOverall, overall))
    const rounded = Math.round(this.lastOverall * 10) / 10

    return {
      // the single 0-100 bar every consumer of a progress event already reads
      progress: rounded,
      overallProgress: rounded,
      itemProgress: item.progress,
      itemsCompleted: this.itemsCompleted,
      totalItems,
      itemIndex: this.itemIndex,
      playlistIndex: this.playlistIndex,
      videoId: this.videoId,
      streamProgress: item.streamProgress,
      streamIndex: item.streamIndex,
      speed: item.speed,
      eta: item.eta,
      etaSeconds: item.etaSeconds
    }
  }

  /**
   * the reading a finished run ends on
   *
   * every item is resolved by now, saved or skipped, so the bar is full. how
   * many of them actually landed is the outcome's business, not the bar's
   *
   * @returns {Object} the final progress event
   */
  finalSnapshot() {
    const totalItems = this.totalItems || Math.max(this.itemIndex, this.itemsCompleted, 1)

    this.itemsCompleted = totalItems
    this.lastOverall = 100

    return {
      progress: 100,
      overallProgress: 100,
      itemProgress: 100,
      itemsCompleted: totalItems,
      totalItems,
      itemIndex: this.itemIndex,
      playlistIndex: this.playlistIndex,
      videoId: this.videoId,
      streamProgress: 100,
      streamIndex: this.item.streamIndex,
      speed: null,
      eta: null,
      etaSeconds: 0
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
    expectedItems = null,
    playlist = false,
    outputDir = null,
    recordsFile = null,
    startupError = null,
    reusedIndices = [],
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
    this.outputDir = outputDir
    this.recordsFile = recordsFile
    // how many positions the user ticked. the denominator of every count this
    // operation reports, and the one number yt-dlp is not asked about
    this.expectedItems = expectedItems

    this.id = id
    this.operation = operation
    this.binaryPath = binaryPath
    this.args = args
    this.cwd = cwd
    this.watchdogMs = watchdogMs
    this.collectStdout = collectStdout
    this.trackStreamMarker = trackStreamMarker
    this.playlist = Boolean(playlist)

    this.stderrBuffer = new RingBuffer(STDERR_BUFFER_LINES)
    this.tracker = this.playlist
      ? new PlaylistProgressTracker({ expectedStreams, totalItems: expectedItems })
      : new ProgressTracker(expectedStreams)
    this.stdout = ""
    this.filePath = null

    // playlist only: the files this run put on disk, keyed by the item's
    // autonumber so one item cannot be counted twice. filled from the record
    // file at exit and from nowhere else
    this.savedItems = new Map()
    this.recordsRead = false

    // ...and, separately, which of the selected positions yt-dlp will skip
    // because the archive already holds them. computed **before the run**, by
    // intersecting the selection's ids with the archive file, because reading
    // it afterwards would find everything this run had just added to it.
    //
    // it is a different claim from "saved" in any case: the archive records
    // that a download once succeeded, not that the file is there now - a new
    // download folder, or a file the user has deleted since, skips the same.
    //
    // the positions travel alongside the count because yt-dlp never announces
    // an archive-skipped item: they are the only handle the ui has on which
    // rows to draw as already downloaded rather than as never reached
    this.reusedIndices = Array.isArray(reusedIndices) ? [...reusedIndices] : []
    this.reusedItems = this.reusedIndices.length
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

    // the run never happens if its save channel could not be prepared. this is
    // before begin(), so nothing is spawned and nothing is read: recordsFile
    // is null in this state, which is what keeps readSavedRecords out of the
    // stale file that caused the refusal
    if (startupError) {
      this.fail({
        code: ERROR_CODES.PERMISSION_ERROR,
        cause: startupError,
        wording: RECORDS_UNWRITABLE
      })
      return
    }

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

      // what was saved is read here, once, before anything is decided
      this.readSavedRecords()

      // **a playlist outcome is decided by counting items, not by the exit
      // code, in both directions.**
      //
      // yt-dlp exits 1 if any item failed, and an old playlist always holds a
      // few deleted videos, so a run that saved 8 of 9 exits 1 and would
      // otherwise be reported as "Download failed" with eight files on disk.
      //
      // it also exits **0** having done nothing at all: a selected position
      // that left the playlist between the listing and the download leaves it
      // "Downloading 0 items of 11" and perfectly happy. accepting that would
      // draw a full bar over an empty folder, and would hide the day an
      // upgrade stops printing the markers this all counts.
      //
      // a null exit code is excluded on top: that is a process that was
      // signalled rather than one that finished - an oom kill, Activity
      // Monitor, a crash - and it never decided it was done, so it does not
      // get to be `completed` on the strength of whatever it had written.
      //
      // every one of those failures goes through fail() with its tally
      // attached, exactly as a cancel does, so nothing already on disk is lost
      const succeeded = this.playlist
        ? exitCode !== null && this.accountedItems() > 0
        : exitCode === 0

      // the empty-run wording belongs to exactly one branch, and the order
      // matters: a cancel, a stall and an external kill all have their own
      // reason already, and saying "finished without saving" over a run that
      // saved eight files would be a contradiction
      const emptyRun =
        this.playlist &&
        !this.cancelled &&
        !this.stalled &&
        exitCode !== null &&
        this.accountedItems() === 0

      if (succeeded && !this.cancelled && !this.stalled) {
        this.setPhase("completed")
        this.emit(
          "progress",
          this.playlist
            ? this.tracker.finalSnapshot()
            : {
                progress: 100,
                streamProgress: 100,
                streamIndex: this.tracker.streamIndex,
                speed: null,
                eta: null,
                etaSeconds: 0
              }
        )

        // single-video runs get none of these keys, so nothing reading a
        // result today has to learn about items
        const tally = this.playlist ? this.itemTally() : null

        const result = {
          id: this.id,
          operation: this.operation,
          exitCode,
          // a playlist's filePath follows the records too, not the marker the
          // progress bar was reading
          filePath: tally ? tally.files[tally.files.length - 1] || null : this.filePath,
          stdout: this.stdout,
          stderr: this.getStderr(),
          durationMs: Date.now() - this.startedAt,
          ...tally
        }

        this.settled = true
        this.discardRecords()
        this.releaseGateIfHeld()
        this.emit("completed", result)
        this.resolve(result)
        return
      }

      this.fail({ exitCode, emptyRun })
    })

    this.touch()
    this.setPhase("running")
  }

  handleStdoutLine(line) {
    if (!line) return

    // the playlist prints are a different shape from the single-video ones, so
    // they get their own reader rather than a set of conditionals threaded
    // through this one. that separation is what keeps a single-video download
    // parsing exactly as it did before playlists existed
    if (this.playlist) {
      this.handlePlaylistStdoutLine(line)
      return
    }

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

  handlePlaylistStdoutLine(line) {
    const marker = parsePlaylistStreamLine(line)
    if (marker) {
      this.tracker.startItem(marker)
      this.emit("streams", this.tracker.expectedStreams)
      // out of `processing` the moment a new item starts, or item 2 would run
      // its whole download under the half-hour merge deadline
      this.setPhase("downloading")
      // ...and the flag alone does not do it. the chunk this line arrived in
      // called touch() *before* anything was parsed, so the timer running now
      // was armed under the phase the previous item left behind, and setPhase
      // only re-arms on the way *into* `processing`. without this an item that
      // announces itself and then hangs before its first byte waits half an
      // hour to be called stalled
      this.touch()
      // an item boundary moves the run's own bar even when the item that just
      // ended never printed a file, so this is emitted rather than waited on
      this.emit("progress", this.tracker.snapshot())
      return
    }

    const progress = parsePlaylistProgressLine(line)
    if (progress) {
      const update = this.tracker.update(progress)

      // yt-dlp prints two 100% lines per stream - without this guard the phase
      // would flap back to downloading after postprocessing has started
      if (this.phase !== "processing" || update.streamProgress < 100) {
        this.setPhase("downloading")
      }

      this.emit("progress", update)

      // the last stream of *this item* finishing means ffmpeg takes over and
      // yt-dlp goes quiet until the file lands. the next item's marker is what
      // brings the phase back
      if (
        update.streamProgress >= 100 &&
        update.streamIndex >= this.tracker.expectedStreams - 1
      ) {
        this.setPhase("processing")
      }
      return
    }

    // an item finished. **this moves the bar and nothing else** - what was
    // saved is read out of the record file at exit, because this channel also
    // carries metadata we did not write and a marker on it proves nothing
    const file = parsePlaylistFileLine(line)
    if (file) {
      this.tracker.completeItem(file.itemIndex)
      this.filePath = file.filePath
      this.emit("destination", file.filePath)
      // the phase deliberately stays where it is. the item is done and what
      // follows is yt-dlp choosing the next one, which is allowed to be quiet -
      // the next marker is what puts the short deadline back
      this.touch()
      this.emit("progress", this.tracker.snapshot())
      return
    }

    // a line that meant to be a marker and did not parse. it changes no
    // count, but it is worth saying out loud: this is what a yt-dlp that
    // changed its output would look like from in here
    if (stripAnsi(line).trim().startsWith(FILE_PREFIX)) {
      this.noteUnverifiedMarker("malformed")
      return
    }

    this.emit("stdout", line)
  }

  /**
   * read what yt-dlp recorded that it saved
   *
   * the record file is the only input to the saved count. it is appended to
   * by yt-dlp's own after_move hook and by nothing else, so a line that
   * reached it describes a file that reached its destination - and each one
   * is then checked against the filesystem anyway.
   *
   * idempotent: the close handler and fail() may both reach it, and the file
   * is deleted afterwards either way
   *
   * @returns {void}
   */
  readSavedRecords() {
    if (this.recordsRead || !this.playlist) return
    this.recordsRead = true

    if (!this.recordsFile) return

    let contents
    try {
      contents = fs.readFileSync(this.recordsFile, "utf8")
    } catch {
      // never created, which is what a run that reached no after_move looks
      // like. no saves, and not an error
      return
    }

    for (const line of contents.split("\n")) {
      if (!line.trim()) continue

      const record = parsePlaylistRecordLine(line)
      if (!record) {
        this.noteUnverifiedMarker("unreadable record")
        continue
      }

      const saved = verifySavedFile(record.filePath, this.outputDir)
      if (!saved) {
        this.noteUnverifiedMarker("recorded file did not check out")
        continue
      }

      this.savedItems.set(
        Number.isInteger(record.itemIndex) ? record.itemIndex : `path:${saved}`,
        saved
      )
    }
  }

  /**
   * throw the record file away
   *
   * it is per run and describes nothing once the run is over, and it lives in
   * the engine's own state directory rather than the user's. left behind only
   * when the app dies without settling the operation, where it is the one
   * trace of what a crashed run had managed to do
   *
   * @returns {void}
   */
  discardRecords() {
    if (!this.recordsFile) return

    try {
      fs.unlinkSync(this.recordsFile)
    } catch {
      // never created, or already gone
    }
  }

  /**
   * say out loud that a marker was ignored
   *
   * into the stderr buffer rather than nowhere: this is the one thing that
   * turns "the download failed" into a diagnosable report, and it is exactly
   * what a future yt-dlp changing its output would look like from in here.
   * the wording deliberately avoids every phrase the taxonomy matches on, so
   * a diagnostic can never become somebody else's classification.
   *
   * @param {string} reason - why it was not counted
   */
  noteUnverifiedMarker(reason) {
    this.stderrBuffer.push(`cliply: ignored an unverified file marker (${reason})`)
  }

  /**
   * items this run can account for, saved or reused
   *
   * the success test, and the reason it is not the exit code: yt-dlp exits 1
   * if any item failed, and 0 for a selection that turned out to be empty
   *
   * @returns {number} how many of the selected positions are accounted for
   */
  accountedItems() {
    return this.savedItems.size + this.reusedItems
  }

  /**
   * what a playlist run did, for a result or for a failure
   * @returns {Object} {files, itemsSaved, itemsReused, reusedIndices, itemsSkipped, itemsTotal}
   */
  itemTally() {
    const files = [...this.savedItems.values()]
    const itemsSaved = files.length
    const itemsReused = this.reusedItems
    // the selection, always. an item that vanished from the playlist between
    // the listing and the download is one of the skipped - reporting "2 of 2"
    // for a run the user asked three videos of would redefine the job as
    // whatever turned out to be possible
    const itemsTotal = this.expectedItems || this.accountedItems()

    return {
      files,
      itemsSaved,
      itemsReused,
      // the same fact as itemsReused, said per row. a copy, so nothing a
      // consumer does to the array reaches back into the operation
      reusedIndices: [...this.reusedIndices],
      itemsSkipped: Math.max(0, itemsTotal - this.accountedItems()),
      itemsTotal
    }
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

    // sigterm first so yt-dlp gets the chance to stop on its own, then kill
    // hard if it hangs. it does *not* tidy up on the way out: the binary
    // installs no sigterm handler, so python dies where it stands and whatever
    // it had open stays on disk - measured, a cancelled 1080p download leaves
    // a `clip.f137.mp4.part` behind and prints nothing about it. that is by
    // design rather than a leak, since a .part is what makes the next run
    // resume instead of restart - but a *completed* stream left next to a
    // half-written one is why handlePlaylistStdoutLine refuses to count a
    // format intermediate as a saved video
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

  fail({ code = null, exitCode = null, cause = null, emptyRun = false, wording = null }) {
    if (this.settled) return
    this.settled = true
    this.clearTimers()
    this.releaseGateIfHeld()

    // a cancel or a spawn failure never reaches the close handler's read
    this.readSavedRecords()

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

    // an explicit code may bring its own words. the taxonomy's entries are
    // shared and frozen, so a caller that knows something more specific than
    // the table does says it here rather than editing the table
    const error = new Error(wording ? wording.message : mapped.message)
    error.code = mapped.code
    error.suggestion = wording ? wording.suggestion : mapped.suggestion
    // the empty-run wording replaces the technical detail *after* the taxonomy
    // has had the untouched stderr, and only when the taxonomy found nothing.
    // pushing it into the ring buffer instead would evict a line: 200 lines
    // is the whole buffer, and a bot-detection error followed by 199 ordinary
    // ones is one push away from being classified as a generic failure
    error.details =
      emptyRun && mapped.code === ERROR_CODES.DOWNLOAD_FAILED
        ? "yt-dlp finished without saving any of the selected videos."
        : mapped.details
    error.retryable = Boolean(mapped.retryable)
    error.updateMayFix = Boolean(mapped.updateMayFix)
    error.needsCookies = Boolean(mapped.needsCookies)
    error.exitCode = exitCode
    error.operationId = this.id
    error.stderrTail = stderrLines

    // a cancelled or stalled playlist keeps whatever it already saved: those
    // files are on disk either way, and discarding the list is how a cancel
    // turns into "we downloaded nothing" in front of a user looking at eight
    // finished videos. a total failure reports an empty list, which is the
    // same statement made honestly
    if (this.playlist) {
      Object.assign(error, this.itemTally())
      this.discardRecords()
    }

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
  /**
   * the jar for one operation, or null when it has no business being there
   *
   * the url decides, not the operation name: getInfo serves youtube, pinterest
   * and tiktok alike, so there is no operation that means "this is youtube".
   *
   * an explicitly passed cookieFile still wins, including an explicit null.
   * That is how the cookie test forces the jar on for its probe, and it is why
   * the check is `!== undefined` rather than a truthiness test.
   *
   * @param {Object} params - the operation's parameters
   * @returns {string|null} path to pass to --cookies
   */
  resolveCookieFile(params = {}) {
    if (params.cookieFile !== undefined) {
      return params.cookieFile
    }

    return isYouTubeUrl(params.url) ? this.getCookieFile() : null
  }

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
   * @param {string} operation - info | playlist-info | combined | audio |
   *   simple | playlist-combined | playlist-audio
   * @param {Object} params - operation parameters (url, formats, output, trim)
   * @param {Object} options - {id, watchdogMs, cwd, onProgress}
   * @returns {YtdlpOperation} handle with promise / cancel() / events
   */
  run(operation, params = {}, options = {}) {
    const resolved = {
      ...params,
      ffmpegPath: params.ffmpegPath || this.getFfmpegPath(),
      denoPath: params.denoPath || this.getDenoPath(),
      cookieFile: this.resolveCookieFile(params),
      // buildCommonArgs needs both, and needs potEnabled first - so an install
      // that was never refused, which is most of them, does not pay two stat
      // calls per operation to look for a payload it would not use anyway
      potEnabled:
        params.potEnabled !== undefined ? params.potEnabled : this.potEnabled
    }

    resolved.potPaths =
      params.potPaths !== undefined
        ? params.potPaths
        : resolved.potEnabled
          ? this.getPotPaths()
          : null

    const id = options.id || `${operation}_${Date.now()}_${this.operations.size}`
    const isInfo = operation === "info" || operation === "playlist-info"
    const isPlaylistDownload =
      operation === "playlist-combined" || operation === "playlist-audio"

    // both of these have to happen *before* the spawn.
    //
    // the record file, because --print-to-file appends: a repeated operation
    // id would otherwise inherit whatever a crashed run left behind, and the
    // directory is engine-owned state that nothing else creates.
    //
    // the archive read, because yt-dlp writes to the archive as it goes -
    // reading it afterwards would report everything this run just added as
    // something it had skipped
    let reusedIndices = []
    let recordsError = null

    if (isPlaylistDownload) {
      resolved.recordsFile = buildPlaylistRecordsPath({
        userDataPath: this.getUserDataPath(),
        operationId: id
      })

      // and it has to actually work. a removal that quietly failed left the
      // path pointing at a *readable* record from the last run under this id,
      // and a download that then failed resolved as having saved the previous
      // run's file. there is no safe way to carry on from here - a channel we
      // cannot vouch for is not a channel - so this throws and the operation
      // settles without yt-dlp ever being spawned
      try {
        if (!resolved.recordsFile) {
          throw new Error("No records path for a playlist download.")
        }

        fs.mkdirSync(path.dirname(resolved.recordsFile), { recursive: true })
        // not recursive on purpose: a directory sitting on the records path is
        // a state nobody should be able to explain, and quietly deleting it is
        // a worse answer than refusing
        fs.rmSync(resolved.recordsFile, { force: true })
        // created, not merely absent, so "we could not write here" and "yt-dlp
        // recorded nothing" stay different states for the rest of the run
        fs.writeFileSync(resolved.recordsFile, "")
      } catch (error) {
        recordsError = error
        resolved.recordsFile = null
      }

      reusedIndices =
        resolved.ignoreArchive === true
          ? []
          : archivedSelectionIndices(
              resolved.playlistEntries,
              readArchivedIds(resolved.archiveFile)
            )
    }

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
      // a playlist download reads its stdout through the PLAYLIST_* templates
      // and ends on a count of saved files rather than on the exit code
      playlist: isPlaylistDownload,
      expectedItems: expectedItemCount(operation, resolved),
      // what a recorded save is checked against: the same folder -P was built
      // from, so a save has to land where we asked for it
      outputDir: resolved.outputDir || null,
      recordsFile: resolved.recordsFile || null,
      // a records channel we could not prepare stops the run before it starts
      startupError: recordsError,
      reusedIndices,
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
   * fetch playlist metadata - one object, with the videos flat inside it
   * @param {string} url - playlist url
   * @param {Object} options - {watchdogMs, cookieFile}
   * @returns {Promise<Object>} the parsed --dump-single-json payload
   */
  async getPlaylistInfo(url, options = {}) {
    const handle = this.run("playlist-info", { url, ...options }, options)
    const result = await handle.promise

    try {
      return JSON.parse(result.stdout.trim())
    } catch (error) {
      // the same failure shape getInfo() throws. the line-per-entry parser this
      // replaced swallowed a broken payload into an empty array, which reaches
      // the user as a playlist that genuinely has no videos in it - a wrong
      // answer where this is a reported failure
      const parseError = new Error("Couldn't read the playlist details.")
      parseError.code = ERROR_CODES.DOWNLOAD_FAILED
      parseError.suggestion = "Please try again."
      parseError.details = error.message
      throw parseError
    }
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
  PlaylistProgressTracker,
  LineSplitter,
  buildArgs,
  buildCommonArgs,
  buildDownloadArgs,
  buildTrimArgs,
  buildPlaylistArgs,
  buildPlaylistItemsSpec,
  normalizePlaylistIndices,
  normalizeQualityTier,
  normalizeAudioMode,
  normalizeAudioLanguage,
  expectedStreamCount,
  expectedItemCount,
  parseProgressLine,
  parseDestinationLine,
  parseStreamCountLine,
  parsePlaylistProgressLine,
  parsePlaylistStreamLine,
  parsePlaylistFileLine,
  parsePlaylistRecordLine,
  parseArchiveSkipLine,
  verifySavedFile,
  readArchivedIds,
  archivedSelectionIndices,
  countArchivedSelections,
  playlistSelection,
  buildPlaylistRecordsPath,
  normalizeUrl,
  isYouTubeUrl,
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
  PLAYLIST_PROGRESS_TEMPLATE,
  PLAYLIST_FILE_TEMPLATE,
  PLAYLIST_STREAM_TEMPLATE,
  PLAYLIST_RECORD_TEMPLATE,
  ENGINE_DIR_NAME,
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_ERROR_BUDGET,
  PLAYLIST_SLEEP_REQUESTS,
  PLAYLIST_FRAGMENTS,
  PLAYLIST_CONTAINER,
  STDERR_BUFFER_LINES,
  DEFAULT_WATCHDOG_MS,
  POSTPROCESS_WATCHDOG_MS,
  PROBE_TIMEOUT_MS,
  KILL_GRACE_MS,
  SHUTDOWN_WAIT_MS
}
