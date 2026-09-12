// starting a download again, from the panel, whatever kind it was

import {
  SIMPLE_QUALITY,
  audioQuality,
  isTrimmedRange,
  track,
  videoQuality,
  type AnalyticsProperties
} from "@/lib/analytics"
import {
  DownloadError,
  pinterestApi,
  playlistApi,
  tiktokApi,
  videoApi,
  type AudioDownloadRequest,
  type DownloadRequest,
  type PinterestDownloadRequest,
  type PlaylistDownloadRequest,
  type TikTokDownloadRequest,
  type VideoDownloadRequest
} from "@/lib/api"
import { localizeError, t } from "@/lib/i18n"
import { downloadsActions, type DownloadRow } from "@/lib/stores/downloadsStore"
import { reportActions } from "@/lib/stores/reportStore"
import { showDownloadErrorToast } from "@/lib/toast-utils"

/**
 * whether this row can be started again at all
 *
 * a history file written by an older version carries no request, and a row
 * with no request is a row that can be read but not re-sent. the button is
 * disabled rather than hidden, so the reason can be given in its title.
 */
export const canRetry = (row: DownloadRow): boolean => Boolean(row.request?.url)

/**
 * re-send what this row was started from, as a new download
 *
 * **not through the hook of its kind, which is what the ticket sketched.** two
 * of the four cannot be reached from here: `useSimplePlatformDownload` is built
 * around a platform screen's own store, and `usePlaylistDownload` builds its
 * request from whichever playlist is loaded, which is rarely the one being
 * retried and is nothing at all after a restart. What the hooks contribute to a
 * start is the store row, the `download_started` event and the request, and the
 * request is the thing this row already has - so this does those three itself
 * and sends it on the channel its kind belongs to.
 *
 * the old row is left where it is. it is a different download with a different
 * id, its failure is what a report would be filed about, and forgetting it here
 * would erase it from the history on disk without being asked. "Clear finished"
 * is how a panel full of attempts is tidied.
 */
export async function retryDownload(row: DownloadRow): Promise<void> {
  const request = row.request

  if (!request?.url) return

  /**
   * the same download, already back in flight.
   *
   * a retried row is terminal by definition, so this can only hit something
   * started elsewhere - the screen it came from, or a second click on Retry
   * before the first row appeared. either way two processes writing one `.part`
   * file corrupt each other, so the panel goes to the one that is running.
   */
  const existing = downloadsActions.findLive({
    kind: row.kind,
    label: row.label,
    request
  })

  if (existing) {
    downloadsActions.setHighlighted(existing.downloadId)
    downloadsActions.setPanelOpen(true)
    return
  }

  const downloadId = crypto.randomUUID()

  downloadsActions.add({
    ...row,
    downloadId,
    // main never sends this one: it is the gap between the click and the first
    // event, the same state the hooks add a row in
    status: "starting",
    progress: 0,
    startedAt: Date.now(),
    // everything the previous attempt learned about itself. a new row wearing
    // the old one's speed, size or failure would be describing a download that
    // has not run yet
    speed: undefined,
    eta: undefined,
    indeterminate: undefined,
    itemsCompleted: undefined,
    itemsSaved: undefined,
    itemsReused: undefined,
    itemsSkipped: undefined,
    filename: undefined,
    fileSize: undefined,
    error: undefined,
    category: undefined,
    finishedAt: undefined
  })

  // main reports this download's end, so it has to hear about its start:
  // completions with no starts is a funnel that shows the impossible
  track("download_started", startedProperties(row, request))

  try {
    await startDownload(row, request, downloadId)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start download"
    const category = error instanceof DownloadError ? error.category : undefined

    // main refused the start, so no event is ever coming for this row: it is
    // settled here rather than left at "starting" for the rest of the session
    downloadsActions.applyEvent({
      downloadId,
      status: "failed",
      progress: 0,
      error: message,
      category
    })

    /**
     * staged before the toast, because the toast is what offers to report it
     *
     * without this the Report action opens a dialog with no context at all
     * (`ReportIssueDialog` renders nothing without one), or - worse - whatever
     * failure was staged earlier in the session, which is a different download
     * and a different url. every other path to this toast stages first
     * (`onError` in `useMediaDownload`, `announceFailed` in `DownloadEvents`),
     * and this one has no progress event behind it to repair the omission.
     *
     * english on purpose, like every line of a report: the maintainer reading
     * the issue is not the user who filed it.
     */
    reportActions.stage({
      shortMessage: message,
      details: error instanceof DownloadError ? error.details : undefined,
      category,
      platform: row.platform,
      // the report knows two kinds of download; a playlist of audio is audio,
      // the same answer `DownloadEvents` gives for a row of its own
      downloadType: isAudioRequest(row, request) ? "audio" : "video",
      videoUrl: request.url
    })

    // the row carries the failure either way; this is so the user who pressed
    // Retry hears that nothing started, wherever they are looking
    showDownloadErrorToast(
      t("downloads.retryFailed"),
      localizeError({ message, category }).message,
      category,
      row.platform
    )
  }
}

/**
 * whether what was asked for is audio, which is not the same as its kind
 *
 * a playlist of audio is a playlist row and an audio download, and the request
 * is the only thing that knows which - the same way `usePlaylistDownload`
 * decides what to call its own failures.
 */
const isAudioRequest = (row: DownloadRow, request: DownloadRequest): boolean =>
  row.kind === "audio" ||
  (row.kind === "playlist" &&
    (request as PlaylistDownloadRequest).type === "audio")

/**
 * send the request on the channel its kind belongs to
 *
 * the casts are the price of one `DownloadRequest` union covering four shapes:
 * `kind` and `request` are separate fields on the row, so narrowing one does
 * not narrow the other. main validates what it receives whatever we believe
 * about it, and a mismatch settles the row through the catch above.
 *
 * `platform` is dropped because it is main's own annotation on a stored request
 * (see retryRequest in ipc-handlers.js), not part of any of the four requests.
 * the simple platforms read it from the row instead, which is where it is
 * always present - the preload injects the real one on the way out.
 */
function startDownload(
  row: DownloadRow,
  request: DownloadRequest,
  downloadId: string
): Promise<unknown> {
  const wire = { ...request }
  delete wire.platform

  switch (row.kind) {
    case "playlist":
      return playlistApi.download({
        ...(wire as PlaylistDownloadRequest),
        download_id: downloadId
      })

    case "audio":
      return videoApi.downloadAudio({
        ...(wire as AudioDownloadRequest),
        download_id: downloadId
      })

    case "simple":
      return row.platform === "tiktok"
        ? tiktokApi.download({
            ...(wire as TikTokDownloadRequest),
            download_id: downloadId
          })
        : pinterestApi.download({
            ...(wire as PinterestDownloadRequest),
            download_id: downloadId
          })

    default:
      return videoApi.downloadVideo({
        ...(wire as VideoDownloadRequest),
        download_id: downloadId
      })
  }
}

/**
 * the `download_started` a retry sends, in the vocabulary its kind always uses
 *
 * the same properties the four hooks send, read back off the stored request
 * rather than off a form nobody is looking at. a retry that reported itself
 * differently would split one funnel across two vocabularies.
 */
function startedProperties(
  row: DownloadRow,
  request: DownloadRequest
): AnalyticsProperties {
  if (row.kind === "playlist") {
    const playlist = request as PlaylistDownloadRequest

    return {
      platform: "youtube",
      is_playlist: true,
      item_count: playlist.entries?.length ?? 0,
      // the playlist operation accepts no range at all, so this is false by
      // construction rather than by choice
      is_trimmed: false,
      ...(playlist.type === "audio" && playlist.audio_mode
        ? {
            media_type: "audio",
            quality: audioQuality(playlist.audio_mode),
            audio_format: playlist.audio_mode
          }
        : {
            media_type: "video",
            quality: videoQuality(playlist.height)
          })
    }
  }

  if (row.kind === "audio") {
    const audio = request as AudioDownloadRequest

    return {
      platform: "youtube",
      media_type: "audio",
      quality: audio.audio_mode ? audioQuality(audio.audio_mode) : null,
      audio_format: audio.audio_mode,
      is_trimmed: isTrimmedRange(audio.time_range)
    }
  }

  if (row.kind === "simple") {
    return {
      platform: row.platform,
      media_type: "video",
      quality: SIMPLE_QUALITY,
      // no range is ever sent from those two screens
      is_trimmed: false
    }
  }

  const video = request as VideoDownloadRequest

  return {
    platform: "youtube",
    media_type: "video",
    quality: videoQuality(video.height),
    is_trimmed: isTrimmedRange(video.time_range)
  }
}
