// what each event may carry, and in what vocabulary.
//
// the allowlist, the kinds, the vocabularies and the grammars they are checked
// against. nothing here emits anything or reads the machine: it is the table
// half of services/analytics.js, kept apart from the code that consults it so
// that adding an event stays a change to a list.

const { SUPPORTED_PLATFORMS } = require("../../utils/constants")
const {
  ERROR_CATEGORIES,
  ERROR_STAGES
} = require("../../utils/error-taxonomy")

/**
 * every event we send, and every property it may carry. anything absent is
 * dropped rather than forwarded.
 *
 * this is the privacy contract, not documentation of it. a denylist would
 * only stop the leaks we thought of; this stops the ones a later caller
 * invents - a url, a title, a filename, a path - because it has to be added
 * here on purpose before it can leave. the renderer's events arrive over ipc
 * as an untrusted property bag, and this is what makes forwarding them safe.
 *
 * adding an event or a property here is a deliberate privacy decision. if a
 * later task finds this list in its way, that is the point of it.
 */
const ALLOWED_PROPERTIES = {
  app_launched: [
    "is_first_launch",
    "previous_version",
    "engine_version",
    // the standing figure: what share of installs are signed in right now,
    // as opposed to cookies_imported's "who ever imported"
    "cookies_signed_in"
  ],
  url_submitted: ["platform", "url_kind"],
  media_info_loaded: [
    "platform",
    "duration_bucket",
    "formats_count",
    "load_ms_bucket",
    "used_cookies",
    // a playlist listing instead of a video's: it has no duration and no format
    // list, and what it has instead is a length. bucketed, never raw
    "playlist_size"
  ],
  media_info_failed: [
    "platform",
    "error_category",
    "error_stage",
    "error_message",
    "used_cookies"
  ],
  /**
   * which half of a `watch?v=…&list=…` link the user meant.
   *
   * the one event this taxonomy owes to url_kind's "playlist" value, which
   * counts how often such a link is pasted and cannot say what was wanted. two
   * properties and no more: the answer, and how big the list they were choosing
   * about was.
   */
  playlist_prompt_answered: ["choice", "playlist_size"],
  /**
   * somebody took the helper line up on its offer of a playlist.
   *
   * the platform and nothing else, and the platform is a constant here: the
   * link is ours rather than one the user pasted, so there is nothing about it
   * to report. what it answers is whether telling people playlists exist is
   * what makes them try one, which is a count of clicks against the
   * url_kind: "playlist" submissions that follow.
   */
  playlist_hint_clicked: ["platform"],
  download_started: [
    "platform",
    "media_type",
    "quality",
    "is_trimmed",
    "audio_format",
    /**
     * a playlist is one download of n videos, so it extends this event rather
     * than sending one beside it: the same platform, media type and requested
     * quality, plus that it is a playlist and how many videos were ticked.
     *
     * absent rather than false on a single video. every existing event keeps
     * exactly the properties it has always had, which is what lets the two be
     * compared at all - and "not a playlist" is what no is_playlist means.
     */
    "is_playlist",
    "item_count"
  ],
  // download_started's properties plus the completion measures, which is what
  // makes the two ends of the funnel join on the same dimensions
  download_completed: [
    "platform",
    "media_type",
    "quality",
    "is_trimmed",
    "audio_format",
    "file_size_mb",
    "elapsed_bucket",
    "speed_bucket",
    "used_cookies",
    /**
     * what the playlist run actually did, and this is the event that can say.
     *
     * a run that saved eight of nine videos exits 1 and is a completion all the
     * same, so a non-zero `items_skipped` here is the normal shape of a partial
     * success rather than a failure in disguise. `items_reused` is its own
     * number and is never folded into `items_saved`: an archive skip records
     * that some earlier run wrote the file, not that this one did.
     */
    "is_playlist",
    "items_saved",
    "items_reused",
    "items_skipped",
    "items_total"
  ],
  // likewise download_started's properties plus its own. a schema consistent
  // on success and silent on failure would be worse than either answer applied
  // to both ends
  download_failed: [
    "platform",
    "media_type",
    "quality",
    "is_trimmed",
    "audio_format",
    "error_category",
    "error_stage",
    "error_message",
    "progress_at_failure",
    "used_cookies",
    /**
     * what a failed playlist had already written, which is the half a user can
     * still see on disk.
     *
     * two counts and not four, deliberately. a run that broke halfway never
     * reached the videos behind the break, so calling them skipped would be a
     * guess dressed as a measurement - and a reuse count is about an archive
     * that a run this broken may never have read.
     */
    "is_playlist",
    "items_saved",
    "items_total"
  ],
  // the same two counts, for the same reason: a cancel is a kill, and the
  // videos it had already finished are still there
  download_cancelled: [
    "platform",
    "media_type",
    "progress_at_cancel",
    "is_playlist",
    "items_saved",
    "items_total"
  ],
  engine_seeded: ["reason", "engine_version", "elapsed_bucket"],
  engine_updated: ["from_version", "to_version"],
  engine_update_failed: ["update_reason", "error_message"],
  cookies_imported: ["success", "has_youtube_cookies", "signed_in"],
  // the two halves of the coffee prompt: how many were shown one, and how many
  // acted on it. Both carry the milestone, so the answer can be read per step
  // rather than only in total - which is what says whether the later ones are
  // worth keeping
  support_prompt_shown: ["milestone"],
  support_prompt_clicked: ["milestone"]
}

// built once, so a capture is a set lookup rather than a scan
const ALLOWED_BY_EVENT = new Map(
  Object.entries(ALLOWED_PROPERTIES).map(([event, keys]) => [
    event,
    new Set(keys)
  ])
)

/**
 * the shape each property is allowed to have. an allowed name is only half a
 * privacy boundary - `platform` set to a url would have left verbatim.
 *
 * see the note above the patterns below for why the string kinds are
 * vocabularies and numeric grammars rather than one general-purpose charset.
 */
const PROPERTY_KINDS = {
  // flags
  is_first_launch: "bool",
  is_trimmed: "bool",
  is_playlist: "bool",
  success: "bool",
  has_youtube_cookies: "bool",
  signed_in: "bool",
  cookies_signed_in: "bool",
  // youtube only, and on both ends of a download plus the lookup - the join
  // that answers whether cookies actually moved the refusal rate
  used_cookies: "bool",

  // counts and measures
  formats_count: "number",
  file_size_mb: "number",
  progress_at_failure: "number",
  progress_at_cancel: "number",
  // which step of the sequence a prompt was, so 5 and 100 stay distinguishable
  milestone: "number",

  /**
   * a playlist run's own arithmetic, and all five are raw rather than bucketed.
   *
   * they describe the operation rather than the person: "8 saved, 2 already
   * downloaded, 1 skipped of 11" is the outcome, and rounding it into buckets
   * would destroy exactly the arithmetic these exist for. how big the playlist
   * they came from was is a different question, and that one is NOT raw - see
   * playlist_size below.
   *
   * their own kind rather than "number", because the bound is real and knowable:
   * a run covers at most PLAYLIST_MAX_ITEMS videos, so a whole number from 0 to
   * the cap is the whole range, where the generic kind would take a fractional
   * 1e9. narrowing a kind to what the feature guarantees is the cheapest
   * validation there is, and the reviewer that asked for it is right that
   * "small integer" is not a claim a 0-to-a-billion check makes.
   */
  item_count: "count",
  items_saved: "count",
  items_reused: "count",
  items_skipped: "count",
  items_total: "count",

  // a controlled vocabulary that normalizes instead of dropping
  platform: "platform",

  // finite vocabularies, listed in PROPERTY_VOCABULARIES
  url_kind: "vocabulary",
  media_type: "vocabulary",
  audio_format: "vocabulary",
  choice: "vocabulary",

  /**
   * how many videos the pasted playlist holds, as one of four labels.
   *
   * a **vocabulary** and not a bucket, which was a correction: the generic
   * bucket grammar is "a digit or a comparison and a short unit", and it
   * forwarded "1984 film", a video-id-shaped "123456789abC" and the exact
   * length "5283 vids" untouched. that the renderer's own helper only produces
   * safe labels is not an argument this module accepts - the renderer is the
   * least-trusted caller here by construction, and its bag arrives over ipc.
   *
   * the values are ours and there are four of them, which is precisely the case
   * the note below says a vocabulary is for. bucketing it at all is still the
   * right call for the value itself: the exact length of a list, next to a
   * platform and a locale, is close to naming which list it was.
   */
  playlist_size: "vocabulary",
  reason: "vocabulary",
  update_reason: "vocabulary",
  error_category: "vocabulary",
  error_stage: "vocabulary",

  // part grammar, part vocabulary - see checkKind
  quality: "quality",

  // version strings, which must lead with a digit - that is what a filename
  // cannot do
  previous_version: "version",
  engine_version: "version",
  from_version: "version",
  to_version: "version",

  // pre-bucketed measurements, never a raw one
  duration_bucket: "bucket",
  elapsed_bucket: "bucket",
  speed_bucket: "bucket",
  load_ms_bucket: "bucket",

  // free text, scrubbed and clipped
  error_message: "text",

  /**
   * the super properties.
   *
   * these are never named in ALLOWED_PROPERTIES, because no caller may send
   * one - init() builds them and capture() spreads them last, over the
   * validated bag. they are kinded all the same: that placement is exactly
   * what makes them worth checking, since one of them rides every event this
   * app will ever send, and a leak there is the most amplified one available.
   */
  app_version: "version",
  os: "vocabulary",
  os_version: "version",
  arch: "vocabulary",
  locale: "locale",

  /**
   * whether this install can mint a PO token at all, which is two separate
   * questions: is there a js runtime to run the generator on, and is the
   * payload actually installed. neither is answerable from a single event -
   * they describe the machine, not the operation - and both have to ride every
   * event to be joinable against the failures they explain.
   *
   * media_info_failed is the one that matters: a renderer event, raised by the
   * half of the app that cannot see either of these facts.
   */
  deno_present: "bool",
  pot_provider: "bool",

  // two values, both ours, listed in PROPERTY_VOCABULARIES - a closed kind,
  // which is what a build indicator should be: it exists so a dev session is
  // filterable rather than indistinguishable, and nothing about that needs a
  // kind that admits anything else
  environment: "vocabulary"
}

const KIND_BY_PROPERTY = new Map(Object.entries(PROPERTY_KINDS))

/**
 * there is no general-purpose grammar for a short label, and six rounds of
 * counterexamples were the proof. a charset wide enough for "1-5 min" admits
 * "My Holiday Video"; narrow it to a lowercase identifier and it still admits
 * "holiday". a single word is indistinguishable from a title by inspection,
 * because it may *be* one.
 *
 * so every string property is now one of three things, and none of them is a
 * general grammar:
 *
 *   - a vocabulary, when the values are ours and finite
 *   - a numerically anchored grammar, when the values genuinely grow but only
 *     along a numeric axis (heights, bitrates, versions, buckets)
 *   - redacted text, when the value is free prose and treated as such
 *
 * the enumeration cost is real, and it is the same cost ALLOWED_PROPERTIES
 * already pays on property names: a later task that sends something new has
 * to come here and say so. that friction is the feature.
 */

// heights and bitrates grow with the format list, so they are matched rather
// than listed - but both are anchored on digits, which "holiday" cannot fake
const QUALITY_HEIGHT_PATTERN = /^\d{2,4}p$/
const QUALITY_BITRATE_PATTERN = /^\d{1,4}kbps$/

// everything else extractQuality() can return (analytics-helpers.js). these
// are fixed outputs of its own branches, not values a format list supplies,
// so they are listed rather than matched
const QUALITY_VALUES = new Set([
  "audio",
  "best_audio",
  "best_available",
  "high_quality",
  "low_quality",
  "m4a",
  "medium_quality",
  "mp3",
  "original_audio",
  "unknown"
])

// digits and dots, with an optional prerelease tail. leading with a digit was
// not enough on its own: "2024.mp4" leads with one too.
//
// letters are confined to the prerelease's *first* segment; every later
// dot-segment is numeric. an earlier version of this allowed dots inside the
// tail, which let "1-holiday.mp4" through - "1" satisfied the head and the
// extension rode along behind the dash.
const VERSION_PATTERN =
  /^[0-9][0-9.]{0,30}(?:-[A-Za-z0-9]{1,16}(?:\.[0-9]+)*)?$/

// a pre-bucketed measurement: leads with a digit or a comparison, ends in a
// short unit. "1-5 min", "<1m", "10-50 MB", "60+ min"
//
// the trailing `+` is admitted because an open-ended top bucket is written
// that way more often than any other, and a grammar that forbids the reflex
// spelling buys nothing: ">60 min" carries the identical information, so the
// only thing rejecting "60+ min" achieves is a dropped event behind a warning
// production never shows anyone. still anchored on a digit or a comparison,
// so no title or filename becomes reachable.
//
// the unit is required, not optional: without it a bare "2024" was a valid
// bucket, and a unitless label is unreadable in a chart anyway - so demanding
// one tightens the boundary and improves the data at the same time.
const BUCKET_PATTERN = /^[<>]?[0-9]+(-[0-9]+)?\+?\s?[a-zA-Z]{1,4}$/

/**
 * a bcp-47 language tag, anchored on case and length.
 *
 * this one is neither a vocabulary nor numerically anchored, and the reason is
 * that the values are chromium's rather than ours: app.getLocale() returns
 * whichever ui locale it resolved, and that set grows with electron upgrades.
 * a listed set would silently stop reporting the locale of everybody who ran
 * the version that added one - a drop nobody triggered and nobody would see,
 * which is a different thing from the deliberate friction the other lists buy.
 *
 * so it is anchored on shape, but on a shape prose does not have: two or three
 * lowercase letters, then at most a titlecase four-letter script and a
 * two-letter uppercase or three-digit region. "my-video" fails on the second
 * segment's case and "holiday" on the first one's length, which is the pair
 * that defeated every general-purpose slug grammar tried before this.
 */
const LOCALE_PATTERN =
  /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/

// what readLocale() reports when electron is not there to ask
const LOCALE_UNKNOWN = "unknown"

// the two builds that exist: one somebody installed, and one run from source
// with the dev opt-in set. see the environment vocabulary below
const ENVIRONMENT_PRODUCTION = "production"
const ENVIRONMENT_DEVELOPMENT = "development"

/**
 * the finite vocabularies, one per property.
 *
 * the two error vocabularies are read from the taxonomy module rather than
 * copied, so a category added there is accepted here for free. the rest are
 * listed because their sources are scattered literals rather than an exported
 * table - each is noted with where it comes from, so it can be re-derived.
 *
 * an empty set is a deliberate state, not an oversight: it means the values
 * do not exist yet, and the first task to send one has to come here first.
 */
const PROPERTY_VOCABULARIES = {
  error_category: new Set(Object.values(ERROR_CATEGORIES)),
  error_stage: new Set(Object.values(ERROR_STAGES)),

  // node's whole documented range for process.platform and process.arch. both
  // are genuinely finite and genuinely not ours to invent, and node adds to
  // them about once a decade - which is the case a list is for. the app runs
  // on three of these; the rest are here because this set claims to be the
  // whole list, and a drop on an unusual platform would take that install's
  // os off every event it ever sends
  os: new Set([
    "aix",
    "android",
    "cygwin",
    "darwin",
    "freebsd",
    "haiku",
    "linux",
    "netbsd",
    "openbsd",
    "sunos",
    "win32"
  ]),
  arch: new Set([
    "arm",
    "arm64",
    "ia32",
    "loong64",
    "mips",
    "mipsel",
    "ppc",
    "ppc64",
    "riscv64",
    "s390",
    "s390x",
    "x64"
  ]),

  // the runner emits "combined" for a video download - an ffmpeg detail
  // meaning two streams were merged - and task 6 normalizes that to "video"
  // before sending. the raw term is deliberately absent rather than missing:
  // this taxonomy answers whether people take video or audio, and should not
  // carry a word that describes how the engine assembled the file
  media_type: new Set(["video", "audio"]),

  // the keys of AUDIO_MODE_PRESETS - normalizeAudioMode returns the key, not
  // the codec it maps to (both in ytdlp-engine.js)
  audio_format: new Set(["mp3", "m4a", "original"]),

  // every reason ytdlp-updater can report: its `reason:` literals, the three
  // passed positionally to installDirectory(), and "download-failed", which is
  // written as a ternary arm in downloadAndUnpack (ytdlp-updater.js) and so is
  // invisible to a grep for the keyword. engine_seeded only ever sends the
  // three positional ones - the rest are here because this set claims to be
  // the whole list
  reason: new Set([
    "asset-layout-unexpected",
    "bundled-newer",
    "busy",
    "cancelled",
    "check-failed",
    "checksum-mismatch",
    "checksum-missing",
    "completed",
    "copy-failed",
    "corrupt",
    "corrupt-and-no-bundle",
    "download-failed",
    "engine-dir-failed",
    "missing",
    "no-binary-available",
    "probe-failed",
    "repaired",
    "swap-failed",
    "swap-stranded",
    "unsupported-platform",
    "up-to-date",
    "version-mismatch"
  ]),

  // why an engine update did not happen: every reason checkForUpdate() can
  // return except the two that mean nothing went wrong, "up-to-date" and
  // "completed", which index.js sends no event for at all. read off its return
  // sites rather than seed()'s - the seeding-only reasons (missing, corrupt,
  // bundled-newer, copy-failed, engine-dir-failed, corrupt-and-no-bundle)
  // cannot reach this property, because runUpdateLocked ignores what
  // seedLocked said and returns its own.
  //
  // "busy" is one of these on purpose: the check refused because a download
  // held the engine gate, so it never ran - and an install whose engine
  // therefore never updates is exactly what this event exists to find
  update_reason: new Set([
    "asset-layout-unexpected",
    "busy",
    "cancelled",
    "check-failed",
    "checksum-mismatch",
    "checksum-missing",
    "download-failed",
    "no-binary-available",
    "probe-failed",
    "repaired",
    "swap-failed",
    "swap-stranded",
    "unsupported-platform",
    "version-mismatch",

    // the one value the updater does not produce. checkForUpdate() can reject
    // rather than return - runUpdateLocked leaves probeVersion and the
    // recovery renames unguarded - and index.js names that itself. kept apart
    // from "check-failed", which is the tag lookup failing and returning
    // normally: merging them would hide a bug in our own code inside the
    // commonest network blip there is
    "check-rejected"
  ]),

  /**
   * which half of an ambiguous link the user meant.
   *
   * the two values of MixedLinkChoice (renderer/src/lib/mixedLinkStore.ts), and
   * there cannot be a third: the question has two buttons, and closing it
   * without pressing either sends nothing at all - an abandoned paste teaches
   * us nothing and is not an answer.
   *
   * named `choice` rather than `playlist_choice` because the event already says
   * what was being chosen, and it is a closed vocabulary either way: nothing a
   * later caller invents can reach this property without being listed here.
   */
  choice: new Set(["video", "playlist"]),

  /**
   * how big the pasted playlist is, as one of four labels.
   *
   * these are PLAYLIST_SIZE_BUCKET_LABELS in renderer/src/lib/analytics.ts,
   * written out here rather than derived because there is no way to import them:
   * they live in the renderer's own build. so this is the mirror, and it is the
   * authority - a label the renderer adds without adding it here is dropped, and
   * that is the direction this list is meant to fail in.
   *
   * the two boundaries that are load-bearing are the item cap (100) and the fact
   * that the top bucket is open: a channel of 5,283 videos and a channel of
   * 300 are the same answer to "did somebody paste something enormous", and one
   * exact figure would say which channel.
   */
  playlist_size: new Set([
    "1-5 vids",
    "6-25 vids",
    "26-100 vids",
    ">100 vids"
  ]),

  // the shape of a submitted link, named by urlKind() in the renderer's
  // lib/analytics.ts - these are ours to invent, and this is the whole list.
  //
  // "playlist" is the one that pays for the rest: we take the single video out
  // of a playlist url, and how often somebody expected otherwise is a question
  // nothing else here answers. "short-link" is the redirect hosts (youtu.be,
  // pin.it, vm/vt.tiktok.com, tiktok.com/t), which cost a resolution step
  // before anything else can happen
  url_kind: new Set(["video", "shorts", "playlist", "short-link", "embed"]),

  /**
   * which kind of build sent the event.
   *
   * "development" is a session somebody opted into with CLIPLY_ANALYTICS_DEV=1
   * - a packaged build is always "production", whatever its environment says,
   * because app.isPackaged is what both this and the gate above read.
   *
   * it is here because the gate failing shut is invisible without it: a
   * dashboard receiving nothing from real installs looks exactly like a
   * dashboard receiving nothing at all, and that is how a build that had sent
   * zero events since the feature landed went unnoticed through nine rounds of
   * review. one dimension makes the two distinguishable.
   */
  environment: new Set([ENVIRONMENT_PRODUCTION, ENVIRONMENT_DEVELOPMENT])
}

const VOCABULARY_BY_PROPERTY = new Map(Object.entries(PROPERTY_VOCABULARIES))

// what an unrecognised platform becomes. it is not a drop - the event still
// arrives, tagged - so the bucket counts how often people try a site we do not
// support. it does not say which sites those are: every unrecognised value
// collapses to this one literal, and no hostname is kept anywhere, which is
// what the no-url rule requires. an aggregate, not a list.
const PLATFORM_UNSUPPORTED = "unsupported"

/**
 * the platforms a value may name.
 *
 * SUPPORTED_PLATFORMS is imported rather than copied, but it is not the whole
 * set: it lists youtube, instagram and tiktok, while the engine's own
 * download list (SUPPORTED_DOWNLOAD_PLATFORMS in ipc/validators.js) lists
 * youtube, pinterest and tiktok. the two are not mirrors. pinterest is fully
 * supported - it has dedicated handling in ipc-handlers and its own
 * extractQuality mapping - so validating against SUPPORTED_PLATFORMS alone
 * would relabel a real platform as unsupported.
 *
 * pinterest is therefore the one name written out here. that list used to be
 * module-local to ipc-handlers and genuinely unreachable from here; it is now
 * exported from ipc/validators.js, which pulls in no electron and would not
 * cycle, so the obstacle is gone and only the duplication is left. the real
 * fix is one list instead of two, which is still not this file's to make -
 * merging them changes which values this property accepts, and that is a
 * privacy decision rather than a tidy-up.
 */
const KNOWN_PLATFORMS = new Set([
  ...Object.keys(SUPPORTED_PLATFORMS).map((key) => key.toLowerCase()),
  "pinterest",
  "unknown",
  PLATFORM_UNSUPPORTED
])

module.exports = {
  ALLOWED_PROPERTIES,
  ALLOWED_BY_EVENT,
  PROPERTY_KINDS,
  KIND_BY_PROPERTY,
  QUALITY_HEIGHT_PATTERN,
  QUALITY_BITRATE_PATTERN,
  QUALITY_VALUES,
  VERSION_PATTERN,
  BUCKET_PATTERN,
  LOCALE_PATTERN,
  LOCALE_UNKNOWN,
  ENVIRONMENT_PRODUCTION,
  ENVIRONMENT_DEVELOPMENT,
  PROPERTY_VOCABULARIES,
  VOCABULARY_BY_PROPERTY,
  PLATFORM_UNSUPPORTED,
  KNOWN_PLATFORMS
}
