// the single source of truth for what broke and where.
// engine, updater, ipc layer and analytics all classify through this file -
// three separate vocabularies used to drift apart here.

const ERROR_STAGES = Object.freeze({
  RESOLVE_BINARY: "resolve_binary",
  FETCH_INFO: "fetch_info",
  DOWNLOAD: "download",
  POSTPROCESS: "postprocess",
  UPDATE: "update",
  FILESYSTEM: "filesystem",
  IPC: "ipc"
})

const ERROR_CATEGORIES = Object.freeze({
  BOT_DETECTION: "BOT_DETECTION",
  VIDEO_UNAVAILABLE: "VIDEO_UNAVAILABLE",
  // deliberately not a shade of VIDEO_UNAVAILABLE, which means there was a
  // video and it is gone or blocked. this one means there was never a video
  // here at all - a pinterest image pin, today - so it is somebody expecting a
  // downloader to take something that is not one, and that is a question about
  // where people get stuck rather than about content that went away.
  //
  // no pattern produces it and none should: it is raised by inspecting a format
  // list (ipc-handlers' pinterest branch), never by reading stderr
  NOT_A_VIDEO: "NOT_A_VIDEO",
  GEO_BLOCKED: "GEO_BLOCKED",
  EXTRACTION_FAILED: "EXTRACTION_FAILED",
  INVALID_URL: "INVALID_URL",
  NETWORK_ERROR: "NETWORK_ERROR",
  STALLED: "STALLED",
  DISK_FULL: "DISK_FULL",
  PERMISSION_ERROR: "PERMISSION_ERROR",
  PATH_ERROR: "PATH_ERROR",
  FFMPEG_MISSING: "FFMPEG_MISSING",
  FFMPEG_AV_BLOCKED: "FFMPEG_AV_BLOCKED",
  FFMPEG_CORRUPT_STREAM: "FFMPEG_CORRUPT_STREAM",
  FFMPEG_ERROR: "FFMPEG_ERROR",
  ENGINE_MISSING: "ENGINE_MISSING",
  JS_RUNTIME_MISSING: "JS_RUNTIME_MISSING",
  ENGINE_UPDATE_FAILED: "ENGINE_UPDATE_FAILED",
  DUPLICATE_DOWNLOAD: "DUPLICATE_DOWNLOAD",
  INVALID_DOWNLOAD_ID: "INVALID_DOWNLOAD_ID",
  CANCELLED: "CANCELLED",
  // no pattern produces this one: it is the engine's fallback for a run that
  // failed without saying anything we recognise, and the string the renderer's
  // report builder and the download runner already emit. UNKNOWN_ERROR is what
  // classify() returns instead - the two are deliberately distinct so "we ran
  // and it broke" stays separable from "we could not tell what broke"
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  UNKNOWN_ERROR: "UNKNOWN_ERROR"
})

// order matters: first match wins, so the specific causes are listed before
// the generic ones they would otherwise be swallowed by.
//
// an entry may also carry `stages` to limit where it applies. an entry without
// it matches at any stage.
const CATEGORY_PATTERNS = [
  // --- postprocess: specific ffmpeg causes before generic ffmpeg ---
  {
    // an av kill has to be recognised from the text alone: the only caller that
    // classifies real stderr is mapError, which cannot know it was postprocessing
    // when it reads the tail. so this entry is not gated to a stage - instead
    // every alternative names ffmpeg and requires a kill token within 80
    // characters of it on the same line.
    //
    // naming ffmpeg is what keeps the category meaning what it says. yt-dlp runs
    // other postprocessors (AtomicParsley for thumbnails, for one), so a kill
    // under the "Postprocessing:" heading is no evidence ffmpeg was the victim,
    // and a cancel worded "process killed" cannot match at all.
    //
    // our own cancels never reach here anyway: they carry an explicit CANCELLED
    // code, and mapError short-circuits on the cancelled flag before classifying.
    category: ERROR_CATEGORIES.FFMPEG_AV_BLOCKED,
    patterns: [
      // 137 is 128 + SIGKILL - nothing else exits ffmpeg that way
      /ffmpeg exited with code 137/i,
      /ffmpeg[^\n]{0,80}\b(?:killed|sigkill)\b/i,
      /\b(?:killed|sigkill)\b[^\n]{0,80}ffmpeg/i
    ]
  },
  {
    category: ERROR_CATEGORIES.FFMPEG_MISSING,
    patterns: [/ffmpeg not found/i, /ffmpeg is not installed/i]
  },
  {
    category: ERROR_CATEGORIES.FFMPEG_CORRUPT_STREAM,
    patterns: [/moov atom not found/i, /invalid data found when processing input/i]
  },

  // --- binaries / runtimes ---
  {
    category: ERROR_CATEGORIES.JS_RUNTIME_MISSING,
    patterns: [
      /no suitable javascript runtime/i,
      /deno.*not found/i,
      /js runtime/i
    ]
  },

  // --- filesystem: disk before permission, both before generic path ---
  {
    category: ERROR_CATEGORIES.DISK_FULL,
    patterns: [/no space left/i, /enospc/i, /disk full/i]
  },
  {
    category: ERROR_CATEGORIES.PERMISSION_ERROR,
    patterns: [
      /permission denied/i,
      /errno 13/i,
      /eacces/i,
      /eperm/i,
      /operation not permitted/i,
      /unable to open for writing/i
    ]
  },
  {
    category: ERROR_CATEGORIES.PATH_ERROR,
    patterns: [
      /filename too long/i,
      /enametoolong/i,
      /invalid argument.*path/i,
      /no such file or directory/i
    ]
  },

  // --- platform / content ---
  {
    category: ERROR_CATEGORIES.BOT_DETECTION,
    patterns: [
      /sign in to confirm you.{0,3}re not a bot/i,
      /confirm you.{0,3}re not a bot/i,
      /use --cookies/i,
      /cookies are no longer valid/i
    ]
  },
  {
    // must precede VIDEO_UNAVAILABLE - youtube phrases geo blocks similarly
    category: ERROR_CATEGORIES.GEO_BLOCKED,
    patterns: [
      /available in your country/i,
      /blocked it in your country/i,
      /not available from your location/i
    ]
  },
  {
    category: ERROR_CATEGORIES.VIDEO_UNAVAILABLE,
    patterns: [
      /video unavailable/i,
      /video is unavailable/i,
      /this video is not available/i,
      /not made this video available/i,
      /content is(?:n.?t| not) available/i,
      /private video/i,
      /this video is private/i,
      /sign in to confirm your age/i,
      /age.restricted/i,
      /members.only/i,
      /removed by the uploader/i,
      /has been terminated/i,
      /video has been removed/i,
      /join this channel/i
    ]
  },
  {
    category: ERROR_CATEGORIES.EXTRACTION_FAILED,
    patterns: [
      /unable to extract/i,
      /nsig extraction failed/i,
      /signature extraction failed/i,
      /failed to extract any player response/i,
      /player response/i,
      // yt-dlp downgrades to a client that cannot see every format - the
      // download either fails outright or silently loses the quality the user
      // picked, and an engine update is what fixes it
      /some web client https formats have been skipped/i
    ]
  },
  {
    category: ERROR_CATEGORIES.NETWORK_ERROR,
    patterns: [
      /unable to download webpage/i,
      /timed out/i,
      /timeout/i,
      /connection reset/i,
      /connection refused/i,
      /connection aborted/i,
      /network is unreachable/i,
      /temporary failure in name resolution/i,
      /getaddrinfo/i,
      /http error 5\d\d/i,
      /remote end closed connection/i
    ]
  },

  // --- generic ffmpeg last, so specific causes above win ---
  {
    category: ERROR_CATEGORIES.FFMPEG_ERROR,
    patterns: [/ffmpeg exited with code/i, /postprocessing:/i]
  }
]

// several modules import this table, so freeze it all the way down - a stray
// push or splice anywhere would quietly rewrite how the whole app classifies
// failures. the regexes themselves are left alone: none carry /g, so matching
// never touches lastIndex.
for (const entry of CATEGORY_PATTERNS) {
  Object.freeze(entry.patterns)
  if (entry.stages) Object.freeze(entry.stages)
  Object.freeze(entry)
}
Object.freeze(CATEGORY_PATTERNS)

const KNOWN_CATEGORY = new Set(Object.values(ERROR_CATEGORIES))

// pull comparable text out of whatever the caller had on hand
function toText(input) {
  if (!input) return ""
  if (typeof input === "string") return input
  if (input instanceof Error) return `${input.code || ""} ${input.message || ""}`
  if (typeof input === "object") {
    return `${input.code || ""} ${input.message || ""} ${input.details || ""}`
  }
  return String(input)
}

/**
 * whether a pattern entry is allowed to match at this stage
 *
 * an entry applies unless it names the stages it is limited to. no entry in
 * CATEGORY_PATTERNS is gated today - FFMPEG_AV_BLOCKED was, until it turned out
 * mapError reads a stderr tail without knowing which stage produced it. the
 * mechanism is kept for a caller that does know: the updater is always at
 * UPDATE, so it can gate an entry that would be a false positive anywhere else.
 *
 * @param {{stages?: string[]}} entry - a CATEGORY_PATTERNS entry
 * @param {string} stage - one of ERROR_STAGES
 * @returns {boolean}
 */
function appliesToStage(entry, stage) {
  return !entry.stages || entry.stages.includes(stage)
}

/**
 * classify an error into {category, stage}
 * @param {string|Error|{code?:string,message?:string,details?:string}} input
 * @param {string} stage - one of ERROR_STAGES
 * @returns {{category: string, stage: string}}
 */
function classify(input, stage) {
  const resolvedStage = Object.values(ERROR_STAGES).includes(stage)
    ? stage
    : ERROR_STAGES.DOWNLOAD

  // we run when something has already failed, so a caller handing us an object
  // that throws on read must not take the failure path down with it
  try {
    // an explicit code we already own wins over pattern guessing
    const code = input && typeof input === "object" ? input.code : null
    if (code && KNOWN_CATEGORY.has(code)) {
      return { category: code, stage: resolvedStage }
    }

    const text = toText(input)

    for (const entry of CATEGORY_PATTERNS) {
      if (
        appliesToStage(entry, resolvedStage) &&
        entry.patterns.some((pattern) => pattern.test(text))
      ) {
        return { category: entry.category, stage: resolvedStage }
      }
    }
  } catch {
    return { category: ERROR_CATEGORIES.UNKNOWN_ERROR, stage: resolvedStage }
  }

  return { category: ERROR_CATEGORIES.UNKNOWN_ERROR, stage: resolvedStage }
}

module.exports = {
  ERROR_CATEGORIES,
  ERROR_STAGES,
  CATEGORY_PATTERNS,
  // exported so the stage gate can be tested on its own: no production entry
  // uses it right now, and a fixture entry parked in the frozen table just to
  // give the test something to bite on would be worse than testing it directly
  appliesToStage,
  classify
}
