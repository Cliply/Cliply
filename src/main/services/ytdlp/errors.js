/**
 * the error taxonomy's wording - this module owns what a failure says, and
 * the taxonomy owns which failure it was
 */

const {
  ERROR_CATEGORIES,
  ERROR_STAGES,
  classify
} = require("../../utils/error-taxonomy")

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

// the record channel is the whole basis for saying anything was saved, so a
// run that cannot prove the file is fresh does not start at all. its own
// wording, because the taxonomy's permission entry is about the folder the
// user picked and this one is about ours
const RECORDS_UNWRITABLE = {
  /**
   * the stable name of this exact refusal, alongside its category.
   *
   * it is a PERMISSION_ERROR, but the taxonomy's permission entry is about
   * the folder the user picked and tells them to choose another one, which
   * does nothing for this. anything reading the category alone would hand out
   * that advice, so the specific wording travels with a code of its own - the
   * same shape main's cookie verdicts use to carry a `JAR_*` beside a
   * sentence, and what lets the renderer say this one in russian.
   */
  code: "RECORDS_UNWRITABLE",
  message: "Cliply couldn't prepare its record of this download.",
  suggestion: "Check permissions on Cliply's app data folder and try again."
}

module.exports = {
  ERROR_CODES,
  ERROR_METADATA,
  TERMINAL_ERRORS,
  explicitError,
  mapError,
  RECORDS_UNWRITABLE
}
