// runner and handler vocabulary to the analytics property bag

/**
 * the only events the renderer may report.
 *
 * these are the ones it knows first-hand: what was pasted, what came back, what
 * was answered about it, and that a download was asked for. everything after
 * that is main's own - it watches the engine, and a renderer that could name
 * download_completed could report a download that never happened.
 *
 * the mixed-link answer belongs on this side of the line for the same reason:
 * the question is asked, answered and acted on entirely in the renderer, and
 * main never sees a link it was asked about unless the answer was "the
 * playlist".
 *
 * this is not the property allowlist. that lives in services/analytics.js and
 * runs on every bag regardless, which is what makes forwarding the renderer's
 * properties wholesale safe.
 */
const RENDERER_EVENTS = new Set([
  "url_submitted",
  "media_info_loaded",
  "media_info_failed",
  "playlist_prompt_answered",
  // a click on the helper line's playlist link, which happens in the hero and
  // nowhere main can see
  "playlist_hint_clicked",
  "download_started",
  // the outcome of the coffee prompt. which button someone pressed is a
  // renderer-side fact by definition - main sends the prompt and hears nothing
  // more - so it belongs to the same category as the six above
  "support_prompt_clicked"
])

/**
 * the downloads that earn a coffee ask, and the fact that there are only three
 *
 * front-loaded so the first one lands while the app is still new to somebody,
 * then spaced further apart each time, then done. The widening gap is the
 * point: a recurring ask is the thing that makes people resent an app they
 * otherwise like, and someone on their five hundredth download has answered
 * already.
 */
const SUPPORT_MILESTONES = [5, 15, 40, 60, 100]

/**
 * what the runner calls a download, in the words the taxonomy answers in.
 *
 * the runner says "combined" for a merged video+audio download and never
 * "video" - an ffmpeg detail about how the file was assembled, where analytics
 * answers what the user took away. anything else is left out rather than
 * guessed at: absence is silent, and a value outside the vocabulary is not.
 */
const MEDIA_TYPES = { combined: "video", video: "video", audio: "audio" }

/**
 * the counts each terminal event may carry, in the order they read in.
 *
 * this is a mirror of ALLOWED_PROPERTIES (services/analytics.js) and it exists
 * because that list is enforced by silence: a count sent to an event that did
 * not declare it is dropped behind a console.warn production never surfaces, so
 * "send them all and let the boundary sort it out" is how a playlist ends up
 * with three quarters of its telemetry and no sign anything is wrong.
 *
 * a completion knows all four. a failure and a cancel know two: what landed on
 * disk, and how many were asked for. neither knows how many were *skipped* -
 * a run that broke or was killed never reached the videos behind it, and
 * counting those as skips is a guess wearing a measurement's clothes.
 */
const PLAYLIST_EVENT_COUNTS = {
  download_completed: [
    "items_saved",
    "items_reused",
    "items_skipped",
    "items_total"
  ],
  download_failed: ["items_saved", "items_total"],
  download_cancelled: ["items_saved", "items_total"]
}

/**
 * what a playlist adds to one of its terminal events
 *
 * absent in its entirety for a single video, `is_playlist` included: every
 * existing event keeps exactly the properties it has always had, and an
 * `is_playlist: false` on all of them would be a schema change on the
 * single-video funnel that nothing asked for.
 *
 * @param {string} event - the analytics event being built
 * @param {Object} payload - what the runner knows about the download
 * @returns {Object|null} the properties to add, or null for a single video
 */
function playlistProperties(event, payload) {
  if (!payload.playlist) return null

  const available = {
    items_saved: payload.itemsSaved,
    items_reused: payload.itemsReused,
    items_skipped: payload.itemsSkipped,
    items_total: payload.itemsTotal
  }

  const properties = { is_playlist: true }

  for (const key of PLAYLIST_EVENT_COUNTS[event] || []) {
    // a count the engine never supplied is left out rather than sent as a zero.
    // a run that failed before it counted anything did not save none of them -
    // it does not know, and a zero would read as "it saved nothing"
    if (Number.isFinite(available[key])) {
      properties[key] = available[key]
    }
  }

  return properties
}

// an error message may arrive as "<short user message>\n\n<full technical>".
// the first paragraph is what the user is shown; the rest travels as details.
// analytics no longer reads this path at all - it takes the runner's payload.
const shortErrorMessage = (message) =>
  (message || "").split(/\n\s*\n/, 1)[0].trim() || "Download failed"

module.exports = {
  RENDERER_EVENTS,
  SUPPORT_MILESTONES,
  MEDIA_TYPES,
  PLAYLIST_EVENT_COUNTS,
  playlistProperties,
  shortErrorMessage
}
