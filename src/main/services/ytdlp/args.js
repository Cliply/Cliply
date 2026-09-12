/**
 * build a yt-dlp argv - one operation name plus its params in, the command
 * line out, with every value that reaches it whitelisted on the way
 */

// the playlist item cap is owned by the mappers, next to the output templates
// whose index padding is derived from it - see the playlists section below
const {
  PLAYLIST_MAX_ITEMS,
  escapeTemplateLiteral
} = require("../../utils/ytdlp-mappers")

const { ERROR_CODES } = require("./errors")
const {
  PROGRESS_TEMPLATE,
  FILE_TEMPLATE,
  STREAM_TEMPLATE,
  PLAYLIST_PROGRESS_TEMPLATE,
  PLAYLIST_STREAM_TEMPLATE,
  PLAYLIST_FILE_TEMPLATE,
  PLAYLIST_RECORD_TEMPLATE
} = require("./parsers")
const { buildPlaylistItemsSpec, playlistSelection } = require("./playlist")

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
// changes that.
//
// it rides on every single video too, not only on a playlist walk: a dash
// stream arrives in fragments whoever asked for it, and the runner now caps
// simultaneous downloads at MAX_CONCURRENT_DOWNLOADS, so the most fragment
// requests this app can have open is a number we choose rather than one the
// user's paste history decides. `simple` is left alone - a tiktok or pinterest
// download is one muxed file with no fragments to fetch in parallel
const CONCURRENT_FRAGMENTS = 4

// a playlist is mp4 at every height, unlike the per-tier container a single
// video gets. `-t mp4` does not fall back to 1080p h264 above 1080p - measured
// on a 4k video it takes the vp9 stream and remuxes it into mp4 - so one
// container buys a predictable extension for the whole folder at no cost
const PLAYLIST_CONTAINER = "mp4"

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
    String(CONCURRENT_FRAGMENTS)
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
      // safe here: the ORDER IS LOAD-BEARING pushes above are about -t against
      // -S, and -N takes part in neither
      args.push("-N", String(CONCURRENT_FRAGMENTS))
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
      // a converted mode hands the fetch to ffmpeg afterwards, but the fetch
      // itself is still yt-dlp's and still fragmented, so this earns its place
      // on audio as much as on video
      args.push("-N", String(CONCURRENT_FRAGMENTS))
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
 * the cookie half of the two youtube predicates: it decides only what gets
 * written back, so it takes youtube-nocookie too and asks nothing of the
 * scheme. Whether a request is allowed at all is isYouTubeRequestUrl's answer.
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
function isYouTubeCookieHost(url) {
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

module.exports = {
  buildCommonArgs,
  buildTrimArgs,
  buildArgs,
  normalizeAudioMode,
  normalizeAudioLanguage,
  normalizeQualityTier,
  expectedStreamCount,
  normalizeUrl,
  isYouTubeCookieHost,
  PLAYLIST_ERROR_BUDGET,
  PLAYLIST_SLEEP_REQUESTS,
  CONCURRENT_FRAGMENTS,
  // the name this was called while it only rode on a playlist walk, kept so
  // that nothing importing it has to change in the same commit that widened it
  PLAYLIST_FRAGMENTS: CONCURRENT_FRAGMENTS,
  PLAYLIST_CONTAINER
}
