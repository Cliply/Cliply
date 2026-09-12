// the shapes that cross the ipc boundary, and the failures they arrive as

/**
 * one row of the quality menu, derived from the video's own format list
 *
 * `height` and `fps` are yt-dlp's. `container` is the one a download at that
 * height really produces, and `filesize` is the video stream plus the audio it
 * will be merged with in that container - both worked out from the format list,
 * and `filesize` is `null` whenever either half is unknown, which renders a row
 * with no size rather than one claiming a number it cannot stand behind.
 */
export interface QualityTier {
  height: number
  container: "mp4" | "mkv"
  filesize: number | null
  fps: number | null
}

// what the audio menu offers: converted mp3, converted m4a, or the stream
// youtube served with no re-encode at all
export type AudioMode = "mp3" | "m4a" | "original"

/**
 * one dubbed audio language the video carries
 *
 * `code` is yt-dlp's own BCP-47 tag ("hi", "zh-Hans") and is what the download
 * request sends back; `is_original` marks the track youtube recorded in.
 */
export interface AudioTrack {
  code: string
  is_original: boolean
}

/**
 * which of the four rows a downloads list is drawing
 *
 * not the same question as `type`: a playlist of audio fetches audio and is
 * still a playlist row, one that counts videos and whose stored request only
 * the playlist channel can re-send. main answers it the same way (see
 * historyKind in services/download-runner.js).
 */
export type DownloadKind = "video" | "audio" | "playlist" | "simple"

/**
 * every state a download can be found in
 *
 * two of these never travel as an event. `starting` is the renderer's own word
 * for the gap between the click and main's first event, and `interrupted` is
 * what the history rewrites a live row to when it finds one at launch.
 */
export type DownloadRowStatus =
  | "queued"
  | "starting"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

export interface DownloadProgress {
  downloadId: string
  // `queued` is sent once, by a download parked behind the concurrency cap
  status: "queued" | "downloading" | "completed" | "failed" | "cancelled"
  progress: number
  speed?: string
  eta?: string
  filename?: string
  /**
   * where the file went and how big it is, on a completed event only.
   *
   * the reservation is gone by the time this lands, so a consumer that missed
   * them here cannot ask for them afterwards. a playlist's `file_path` is
   * whichever video landed last rather than the run, which is why a playlist
   * row reads the item counts instead.
   */
  file_path?: string
  file_size?: number
  /**
   * how many downloads this install has finished, counting this one.
   *
   * on a completed event only, and main's own count rather than anything the
   * renderer works out for itself: it is the number the panel shows, and a
   * tally kept on this side cannot survive hydration replaying a completion
   * over a snapshot older than it. camelCase like the rest of the envelope
   * main writes, rather than the snake_case fields that came off the result.
   */
  lifetimeCompleted?: number
  error?: string
  // failures now arrive as events rather than a rejected invoke, so the report
  // payload's technical detail rides along with them
  details?: string
  category?: string
  /**
   * the stable name of a wording main chose over its category's own.
   *
   * a playlist run that cannot write its record of the download fails as a
   * PERMISSION_ERROR, exactly like a download folder we cannot write to, and
   * the two want opposite advice: one is Cliply's app data folder and the
   * other is the folder the user picked. only this tells them apart.
   */
  wordingCode?: string
  // trimmed downloads report one sweep at the end, so there is no meaningful
  // percentage to show while ffmpeg works
  indeterminate?: boolean
  // a failure that carries its own advice, rather than the generic retry
  // prompt: a playlist run refuses to start when Cliply cannot write its own
  // record of the download, which no amount of retrying fixes
  suggestion?: string

  /**
   * the second level, sent only by a playlist download.
   *
   * `progress` above is still the single 0-100 bar for the whole run, so a
   * consumer that only reads that keeps working. these say where inside it we
   * are: `item_index` is the video's place in this run's queue and
   * `playlist_index` its true position in the playlist, which differ for any
   * selection with a gap in it. there is no title here - main never sees one -
   * so the row is matched by index or by `video_id` against the listing.
   */
  item_progress?: number
  item_index?: number
  items_completed?: number
  items_total?: number
  playlist_index?: number | null
  video_id?: string | null

  /**
   * what a finished playlist run actually did, on its terminal event.
   *
   * a partial playlist is `completed`, not a fourth status: "some items were
   * skipped" is a property of a finished job. `items_reused` is the archive's
   * doing - videos this destination already has, which read as "already
   * downloaded" and are **never** a save this run made.
   */
  files?: string[]
  items_saved?: number
  items_reused?: number
  items_skipped?: number

  /**
   * which positions the archive accounted for.
   *
   * yt-dlp never announces an archive-skipped item: no stream marker, no
   * progress line, no file. so these rows are indistinguishable from rows the
   * run never reached unless the run says which they were, and the engine
   * knows because it works reuse out from the archive before spawning.
   */
  reused_indices?: number[]
}

export interface DownloadStatus {
  downloadId: string
  status: "queued" | "downloading" | "completed" | "failed" | "cancelled"
  progress: number
  filename?: string
  error?: string
  startTime?: number
  endTime?: number
  // what this download fetches: "combined" or "audio"
  type?: string
  title?: string
  platform?: string
  // a playlist is one row covering n videos, downloaded one after another; a
  // single video is one row and nothing else. `type` says what is being
  // fetched, which is the same answer for both, so this is what tells a
  // downloads list which of the two shapes to draw
  playlist?: boolean
  /**
   * what a renderer that reloaded mid-download rebuilds a whole row from: the
   * words to put beside the title, and the request a retry would re-send. main
   * keeps the request exactly as the renderer sent it, so it is snake_case and
   * it carries the `platform` main added to it.
   */
  label?: string
  request?: DownloadRequest
}

/**
 * the request each kind of download was started from
 *
 * keyed by kind because that is how a retry has to read it: only the playlist
 * channel can re-send a list of entries, and only the audio channel a mode.
 */
export interface DownloadRequestsByKind {
  video: VideoDownloadRequest
  audio: AudioDownloadRequest
  playlist: PlaylistDownloadRequest
  simple: PinterestDownloadRequest | TikTokDownloadRequest
}

/**
 * any of them, as it comes back from main
 *
 * `platform` is main's addition (see retryRequest in ipc-handlers.js): the
 * request is stored so it can be re-sent, and which channel to send it on is
 * not otherwise recoverable from a url.
 */
export type DownloadRequest =
  DownloadRequestsByKind[keyof DownloadRequestsByKind] & {
    platform?: string
  }

/**
 * one row of the history main keeps on disk
 *
 * snake_case throughout, because a row is the wire payloads written down
 * rather than a shape of main's own. only `download_id` and `status` are
 * promised: a row assembled from a settle alone, or read back from a file an
 * older version wrote, can be missing any of the rest.
 */
export interface DownloadHistoryRow {
  download_id: string
  status: DownloadRowStatus
  kind?: DownloadKind
  platform?: string
  title?: string
  label?: string
  started_at?: number
  finished_at?: number
  filename?: string
  file_path?: string
  file_size?: number
  error?: string
  category?: string
  request?: DownloadRequest
  // playlist rows only: the total is written at reserve and then again, better
  // known, when the run settles
  items_total?: number
  items_saved?: number
  items_reused?: number
  items_skipped?: number
}

export interface SystemHealth {
  timestamp: string
  engine: {
    binaryPath: string
    version: string | null
    ready: boolean
    ffmpeg: boolean
    deno: boolean
  }
  cookies: { hasValid: boolean; fileSize: number }
  downloads: { active: number; total: number }
  performance: { uptime: number; memory: number }
}

export interface DownloadPathInfo {
  path: string
  exists: boolean
  writable: boolean
}

/**
 * what the cookie jar on disk holds
 *
 * `signedIn` is yt-dlp's own authentication test - LOGIN_INFO alongside a
 * SAPISID cookie - not "there are youtube cookies in the file". The two differ
 * for a jar exported without signing in, and for one youtube has since rotated
 * out, which is why both fields are here rather than one.
 */
export interface CookieFileInfo {
  exists: boolean
  size: number
  modified: string | null
  cookieCount: number
  youtubeCookieCount?: number
  expiredCookieCount?: number
  /** a SAPISID cookie is present - signed in, or signed out and not yet re-exported */
  hasSid: boolean
  signedIn: boolean
  /** set when yt-dlp would refuse the whole file, which reads as an empty jar otherwise */
  loadError?: string | null
  valid: boolean
}

export interface CookieStatus {
  fileInfo: CookieFileInfo
  hasValidCookies: boolean
  /** why the jar is unusable, written by main. null when it works */
  problem: string | null
  /** the same verdict as a stable `JAR_*` code, so it can be said in russian */
  problemCode?: string | null
  status: { lastImport?: string | null; lastTest?: string | null }
}

export interface CookieImportResult {
  /**
   * whether what landed is a jar yt-dlp would authenticate with, which is the
   * only thing the dialog asks. `imported` and `signedIn` used to sit here too:
   * the first was never false, since a refusal throws, and the second said the
   * same thing as this one
   */
  hasValidCookies: boolean
}

/**
 * deliberately two facts rather than a verdict: extracting a public video with
 * the jar attached proves extraction worked, not that youtube honoured the
 * cookies - the same probe passes with none at all.
 */
export interface CookieTestResult {
  cookiesLoaded: boolean
  extractionCheck: string
  /** youtube turned the cookies down while they were being sent - the one strong negative */
  rejected?: boolean
  note: string
  /** the note as a stable `JAR_*` or `PROBE_*` code, for the same reason */
  noteCode?: string | null
}

export interface VideoInfoResponse {
  title: string
  duration: number
  duration_string: string
  thumbnail?: string | null
  uploader: string
  quality_tiers: QualityTier[]
  audio_tracks: AudioTrack[]
}

export interface PinterestVideoInfoResponse {
  title: string
  duration: number
  duration_string: string
  thumbnail: string | null
  uploader: string
}

export interface PinterestDownloadRequest {
  url: string
  format_id?: string
  // keeps the media title in the output filename
  title?: string
  // see AudioDownloadRequest.download_id. these two send one now for the same
  // reason every other kind does: the download reports through progress events
  download_id?: string
}

/**
 * the acknowledgement a simple-platform download answers with
 *
 * it used to be the finished file: main awaited the whole download and replied
 * with the filename, the path and the size. with a queue in front of it that
 * invoke would sit open for as long as the row waited, so pinterest and tiktok
 * now start and report through `download:progress` like every other kind, and
 * this is only "we have it, here is the id to follow".
 */
export interface SimpleDownloadResponse {
  download_id: string
  status: string
  type: string
}

export interface TikTokVideoInfoResponse {
  title: string
  duration: number
  duration_string: string
  thumbnail: string | null
  uploader: string
}

export interface TikTokDownloadRequest {
  url: string
  format_id?: string
  // keeps the media title in the output filename
  title?: string
  // see PinterestDownloadRequest.download_id
  download_id?: string
}

/**
 * one row of a playlist listing
 *
 * `index` is the video's 1-based position in the playlist and is what a
 * download selection sends back. `duration` is null for a row that has none -
 * a live stream, or a video that is gone - rather than a zero that would read
 * as a video of no length.
 *
 * `unavailable` marks a deleted or private video. it cannot be downloaded, and
 * each attempt spends one of yt-dlp's five allowed failures before it gives up
 * on the rest of the playlist, so these rows must not be selectable.
 */
export interface PlaylistEntry {
  index: number
  id: string | null
  title: string
  duration: number | null
  duration_string: string | null
  thumbnail: string | null
  unavailable: boolean
}

/**
 * what a playlist link holds
 *
 * `count` is the playlist's true size and is null when the platform does not
 * report one (a channel feed paginates lazily and never says). `listed` is how
 * many rows came back, capped at 100, and `truncated` is the only honest way
 * to say "there is more of this than we are showing you".
 *
 * there are no quality tiers and no file sizes here, and there cannot be: the
 * listing is flat, so it carries no formats. that is why a playlist's quality
 * menu is a fixed ceiling rather than one derived from the video.
 */
export interface PlaylistInfoResponse {
  playlist_id: string | null
  title: string
  uploader: string
  count: number | null
  listed: number
  truncated: boolean
  entries: PlaylistEntry[]
}

/**
 * a playlist download request
 *
 * `entries` are the ticked rows, sent as the {index, id} pairs the listing
 * gave: main derives yt-dlp's selection from the indices and decides what the
 * resume archive already holds from the ids. `height` is a ceiling ("best
 * available up to this"), never a filter, so nothing is skipped for lacking it.
 *
 * `ignore_archive` is the "download everything again" affordance for a user
 * who deleted the files: it drops the archive for one run, and only a literal
 * true does it.
 */
export interface PlaylistDownloadRequest {
  url: string
  playlist_id: string
  entries: { index: number; id: string }[]
  type?: "video" | "audio"
  height?: number
  audio_mode?: AudioMode
  ignore_archive?: boolean
  // see AudioDownloadRequest.download_id - one id covers the whole playlist
  download_id?: string
  title?: string
}

export interface TimeRange {
  start: number // seconds
  end: number // seconds
}

export interface AudioDownloadRequest {
  url: string
  audio_mode: AudioMode
  // the dub the user picked, sent only by a video that offered a choice - its
  // absence is what leaves the download on the original track
  audio_language?: string
  // renderer-generated correlation id, so progress events can be filtered from
  // the moment the listener subscribes
  download_id?: string
  // omitted when the selection covers the whole video: yt-dlp only reports a
  // single progress sweep for a section download, and re-muxing the full video
  // through ffmpeg is slower than just downloading it
  time_range?: TimeRange
  precise_cut?: boolean
  title?: string
  output_path?: string
}

export interface VideoDownloadRequest {
  url: string
  height: number
  // the container of the row that was *displayed*, echoed back so the label the
  // user read can never disagree with the file they get
  container: "mp4" | "mkv"
  // see AudioDownloadRequest.audio_language
  audio_language?: string
  // see AudioDownloadRequest.download_id
  download_id?: string
  // see AudioDownloadRequest.time_range
  time_range?: TimeRange
  precise_cut?: boolean
  title?: string
  output_path?: string
}

export interface ApiError {
  type?: string
  message: string
  suggestion?: string
  details?: string
  category?: string
  /** main's own code for the failure, "GENERAL_ERROR" when it has none */
  code?: string
  /** see `DownloadProgress.wordingCode`: a refusal that named itself */
  wordingCode?: string
}

/**
 * a failure carrying what main knew about it
 *
 * `details` is the technical text issue reports quote, and `category` is main's
 * own taxonomy answer - the field to read, because `code` beside it in the same
 * payload is either the engine's code or the "GENERAL_ERROR" placeholder, which
 * is not a taxonomy value.
 *
 * named for downloads because that is where it started; the info requests throw
 * it too, since a failure that arrives as a bare Error has thrown both fields
 * away before any caller can see them.
 */
export class DownloadError extends Error {
  details?: string
  category?: string
  /** see `DownloadProgress.wordingCode`: a refusal that named itself */
  wordingCode?: string

  constructor(message: string, error?: ApiError) {
    super(message)
    this.name = "DownloadError"
    this.details = error?.details
    this.category = error?.category
    this.wordingCode = error?.wordingCode
  }
}

/**
 * an import main refused, carrying the code it refused it under
 *
 * a bare Error threw the code away, and the dialog would have had to match
 * main's english sentence to know which refusal it was holding.
 */
export class CookieError extends Error {
  code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = "CookieError"
    this.code = code
  }
}

// Auto-updater types
export interface UpdateInfo {
  version: string
  releaseNotes?: string
  releaseDate?: string
  autoDownloading?: boolean
  autoInstallOnQuit?: boolean
  requiresManualDownload?: boolean
  platform?: string
}

export interface UpdateProgress {
  percent: number
  bytesPerSecond?: number
  total?: number
  transferred?: number
}

export interface UpdateStatus {
  checking?: boolean
  available?: boolean
  version?: string
  downloading?: boolean
  downloaded?: boolean
  error?: string
}
