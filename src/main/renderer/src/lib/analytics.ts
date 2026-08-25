// the renderer's end of telemetry.
//
// nothing here decides whether anything is sent: the main process owns the
// opt-out gate, the per-event property allowlist and the redaction, and this
// side is the least-trusted caller by construction. what it does owe the other
// end is values it will accept - a label outside the validator's grammar is
// dropped behind a console.warn that production never surfaces, so a wrong one
// is invisible in the field rather than loud.
//
// the value sets below are therefore mirrors of specific main-process code, and
// each is noted with what it mirrors. src/main/services/analytics.js is where
// they are enforced.

import type { AudioMode, TimeRange } from "@/lib/api"

type AnalyticsValue = string | number | boolean

export type AnalyticsProperties = Record<
  string,
  AnalyticsValue | null | undefined
>

/**
 * fire-and-forget telemetry
 *
 * never throws into the ui and never waits: a measurement that can break the
 * thing it measures is worse than no measurement.
 *
 * @param event - one of the four events the main handler accepts
 * @param properties - the bag; an absent value is left out rather than nulled
 */
export function track(event: string, properties: AnalyticsProperties = {}): void {
  try {
    const sendable: Record<string, AnalyticsValue> = {}

    // main skips a null in silence, so sending one costs nothing there - but a
    // bag that says null claims we looked and found nothing, which is not what
    // an absent property means. `false` and `0` are values and stay.
    for (const [key, value] of Object.entries(properties)) {
      if (value === null || value === undefined) continue
      sendable[key] = value
    }

    window.electronAPI?.analytics?.track(event, sendable)?.catch(() => {})
  } catch {
    // telemetry must never break the ui
  }
}

/**
 * how long the media runs, as a label rather than a measurement
 *
 * the exact second is needlessly identifying - a duration and a platform is
 * most of a fingerprint for one video - and the question these answer is what
 * length of thing people take, which a bucket answers just as well.
 */
const DURATION_BUCKETS = [
  { under: 60, label: "<1 min" },
  { under: 300, label: "1-5 min" },
  { under: 1200, label: "5-20 min" },
  { under: 3600, label: "20-60 min" },
  { under: Number.POSITIVE_INFINITY, label: ">60 min" }
] as const

// exported so a bucket added above has to be added to the payload fixture the
// main suite validates, rather than discovered as a silent drop in production
export const DURATION_BUCKET_LABELS = DURATION_BUCKETS.map(
  (bucket) => bucket.label
)

/**
 * @param seconds - the media's duration, if anything reported one
 * @returns a bucket label, or null when there was nothing to bucket
 */
export function durationBucket(
  seconds: number | null | undefined
): string | null {
  // a live stream, a pin with no duration, a mapper that returned nothing.
  // "unknown" is not a bucket label - the validator's grammar wants a digit or
  // a comparison first - so absence is reported by leaving the property out
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null
  }

  return (
    DURATION_BUCKETS.find((bucket) => seconds < bucket.under)?.label ?? null
  )
}

/**
 * the kinds of link people paste.
 *
 * these are ours to invent, and they are the shape of the link and never the
 * link. "playlist" is the one that pays for the rest: we take the single video
 * out of a playlist url, and how often somebody expects otherwise is a question
 * nothing else here answers.
 *
 * every value must also appear in PROPERTY_VOCABULARIES.url_kind
 * (services/analytics.js) or it is dropped on arrival.
 */
export const URL_KINDS = {
  playlist: "playlist",
  shorts: "shorts",
  embed: "embed",
  shortLink: "short-link",
  video: "video"
} as const

// first match wins, and the order is the priority: a shorts link inside a
// playlist is reported as the playlist, because that is the surprising half
const URL_KIND_PATTERNS: [RegExp, string][] = [
  [/[?&]list=|\/playlist\b/i, URL_KINDS.playlist],
  [/\/shorts\//i, URL_KINDS.shorts],
  // youtube's /embed/ and /v/, and tiktok's /embed/
  [/\/(?:embed|v)\//i, URL_KINDS.embed],
  // the redirect hosts: youtu.be, pin.it, vm/vt.tiktok.com and tiktok.com/t
  [
    /(?:^|\/\/)(?:youtu\.be|pin\.it|vm\.tiktok\.com|vt\.tiktok\.com)\//i,
    URL_KINDS.shortLink
  ],
  [/\btiktok\.com\/t\//i, URL_KINDS.shortLink]
]

/**
 * @param url - what the user submitted, which never leaves the renderer
 * @returns one of URL_KINDS
 */
export function urlKind(url: string): string {
  const match = URL_KIND_PATTERNS.find(([pattern]) => pattern.test(url))

  // every url that reaches a call site has already passed its platform's
  // validator, so a shape none of the patterns place is a canonical link
  return match ? match[1] : URL_KINDS.video
}

/**
 * the quality of a video download, as the height the user picked
 *
 * main derives the same value for the same download's later events
 * (ipc-handlers.js:514), so the two can be joined on it.
 *
 * @param height - the menu row's height
 * @returns "1080p" and the like, or null for a height no row could produce
 */
export function videoQuality(height: number | null | undefined): string | null {
  if (typeof height !== "number" || !Number.isInteger(height)) return null

  // the validator takes two to four digits and a p (QUALITY_HEIGHT_PATTERN);
  // anything else would be dropped behind a warning nobody sees
  return height >= 10 && height <= 9999 ? `${height}p` : null
}

/**
 * the quality of an audio download.
 *
 * extractQuality maps the "original" mode to "original_audio"
 * (analytics-helpers.js:26) for the same download's later events, so passing
 * the mode through unmapped would split one download across two values.
 */
export const AUDIO_QUALITIES: Record<AudioMode, string> = {
  mp3: "mp3",
  m4a: "m4a",
  original: "original_audio"
}

export function audioQuality(mode: AudioMode): string {
  return AUDIO_QUALITIES[mode]
}

/**
 * the quality of a download from a platform that offers no choice at all
 *
 * pinterest and tiktok send no format id, so main's own falls back to the
 * platform name and extractQuality maps both of those to "best_available"
 * (analytics-helpers.js:23-32). the same download's later events say that, so
 * this one says it too.
 */
export const SIMPLE_QUALITY = "best_available"

/**
 * the quality of a transcript download
 *
 * a subtitle track has no quality ladder - it is whatever the uploader or the
 * machine wrote - so all three formats report the same label, and the format
 * itself travels as `transcript_format`. main derives the same value from the
 * format id for this download's later events (analytics-helpers.js knownIds),
 * so the two ends join on it.
 */
export const TRANSCRIPT_QUALITY = "transcript"

/**
 * whether this download is really a segment
 *
 * mirrors normalizeTimeRange (ipc-handlers.js:55), which throws away a range
 * that covers nothing: the store opens on {start: 0, end: 0}, and a truthiness
 * check here would report a trimmed download that main will run whole.
 */
export function isTrimmedRange(range: TimeRange | undefined): boolean {
  if (!range) return false

  const start = Number(range.start) || 0
  const end = Number(range.end) || 0

  return end > start
}
