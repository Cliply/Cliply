// a Stop the user pressed before main was in a position to take it

import { downloadApi, type DownloadProgress } from "@/lib/api"
import {
  downloadsActions,
  isLiveRow,
  isTerminalStatus
} from "@/lib/stores/downloadsStore"

/**
 * why any of this exists
 *
 * a row is on screen, with a Stop on it, from the moment the user clicks
 * Download - and main reserves the id only after it has prepared the download
 * folder. a Stop pressed in that window is answered `false` against an id main
 * has never heard of, and the download it was meant to stop starts a moment
 * later. so the ask is kept and carried out at the first moment it can be.
 *
 * three moments can settle it, in the order they are likely to arrive:
 *
 * - the start acknowledgement (`stopIfRequested`, called by every start path),
 *   which is the reliable one: main reserves the id before it answers
 * - the first event that says main has the id (`reconcileCancelIntent`), for a
 *   row this window's own acknowledgement never reaches - a panel Retry the
 *   user navigated away from, a reload
 * - the reply to the Stop itself, when the acknowledgement or one of main's
 *   own events beat it home and proved the id exists (`keepCancelIntent`)
 *
 * which is why the acknowledgement is written down rather than only acted on:
 * two of those three can happen in either order, and the row says `starting`
 * through both of them.
 *
 * waiting for engine progress is what none of them does. a trimmed download is
 * one ffmpeg pass that reports nothing until it finishes, and a Stop that waits
 * for a progress line on one of those is a Stop that never happens.
 *
 * the playlist screen keeps its own version of this for its own Cancel button
 * (`cancelIntentRef` in `usePlaylistDownload`); this one is by download id, for
 * the panel, and covers every kind of row.
 */

/**
 * stop this download, now or as soon as main is in a position to
 *
 * the acknowledgement is not the outcome either way: the row is settled by the
 * `cancelled` event, as it always was.
 *
 * @param downloadId the row's id, which is the id main was given
 */
export async function requestStop(downloadId: string): Promise<void> {
  try {
    if (await downloadApi.cancelDownload(downloadId)) return

    keepCancelIntent(downloadId)
  } catch (error) {
    console.error("Failed to cancel download:", error)
  }
}

/**
 * hold on to a Stop main would not take, or ask again if it can be taken now
 *
 * `false` has two meanings and this is where they are told apart. a row that is
 * no longer live means the download finished while the click was in flight, and
 * asking again would be asking main to stop a file that is on disk. anything
 * else means main has the id by now, and the ask is repeated at once rather
 * than kept for an event that may never come: a queued row emits nothing until
 * it takes a slot, and a trimmed one nothing until it is finished.
 *
 * "main has the id by now" is two different observations, and both are needed:
 * the row's own status, when an event has arrived, and `isAdmitted` when the
 * start acknowledgement was processed while this reply was in flight. that
 * second case leaves the row at `starting` with nothing wrong with it, which is
 * exactly the shape of the download this whole file exists for.
 *
 * so only a `starting` row main has not acknowledged is kept, which is the one
 * state where there is genuinely nothing to cancel yet.
 *
 * @param downloadId the row's id
 */
export function keepCancelIntent(downloadId: string): void {
  const row = downloadsActions.rowOf(downloadId)

  if (!isLiveRow(row)) return

  if (row?.status === "starting" && !downloadsActions.isAdmitted(downloadId)) {
    downloadsActions.rememberCancelIntent(downloadId)
    return
  }

  // asked once more and not re-examined: this is the answer to a `false` that
  // raced an acknowledgement or an event, not a loop that keeps asking until
  // main says yes
  void issueStop(downloadId)
}

/**
 * main has taken this download: a Stop that was waiting for it can go now
 *
 * called by every start path at its acknowledgement, which is the first moment
 * the id is certainly reserved.
 *
 * the admission is written down whether or not anybody has pressed Stop, and
 * that is the point of it rather than an aside: a Stop pressed a moment ago may
 * still be waiting on a reply that lands after this, and the row it will read
 * then says `starting` either way. there is nothing to carry out here in almost
 * every download, and one id is what it costs.
 *
 * @param downloadId the id the start was sent under
 */
export function stopIfRequested(downloadId: string): void {
  downloadsActions.markAdmitted(downloadId)

  if (!downloadsActions.takeCancelIntent(downloadId)) return

  void issueStop(downloadId)
}

/**
 * the same, for a row whose acknowledgement this window never saw
 *
 * a terminal event drops the intent instead: the download is over, and the row
 * keeps whatever ending it actually had rather than being asked to stop.
 *
 * @param event one `download:progress` payload
 */
export function reconcileCancelIntent(event: DownloadProgress): void {
  if (isTerminalStatus(event.status)) {
    downloadsActions.takeCancelIntent(event.downloadId)
    // nothing will ask about this id again, so the session stops carrying it
    downloadsActions.forgetAdmitted(event.downloadId)
    return
  }

  if (event.status !== "queued" && event.status !== "downloading") return

  stopIfRequested(event.downloadId)
}

function issueStop(downloadId: string): Promise<void> {
  return downloadApi.cancelDownload(downloadId).then(
    () => undefined,
    (error: unknown) => {
      console.error("Failed to cancel download:", error)
    }
  )
}
