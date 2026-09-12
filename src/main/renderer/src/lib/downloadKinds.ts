// what each kind of download is called, and what its row says beside the title

import type { DownloadKind } from "@/lib/api"
import type { Key } from "@/lib/i18n"

/** the sentences that name one kind of download's outcome to the user */
export interface DownloadWording {
  completed: Key
  failed: Key
  cancelled: Key
}

/**
 * the copy, per kind of download
 *
 * this used to live inside `useMediaDownload`, which was also the only thing
 * that said "completed" or "failed" out loud. the terminal toasts are now one
 * subscription's job (see `DownloadEvents`) and the hook still says "cancelled"
 * when the user asks for it, so the table is out here where both read the same
 * one rather than each holding half of it.
 *
 * `playlist` is deliberately absent: its hook keeps its own listener and its
 * own sentences, which count videos rather than describing a file.
 */
export const DOWNLOAD_WORDING: Record<
  Exclude<DownloadKind, "playlist">,
  DownloadWording
> = {
  video: {
    completed: "download.videoCompleted",
    failed: "download.videoFailed",
    cancelled: "download.videoCancelled"
  },
  audio: {
    completed: "download.audioCompleted",
    failed: "download.audioFailed",
    cancelled: "download.audioCancelled"
  },
  /**
   * tiktok and pinterest, which offer no choice of anything.
   *
   * the same three sentences they have always used, which say "download"
   * rather than "video download": there is only one kind of download on those
   * screens, so naming it would be telling the user nothing.
   */
  simple: {
    completed: "download.complete",
    failed: "download.failed",
    cancelled: "download.cancelled"
  }
}

/**
 * the label a row wears beside its title, worked out from the request
 *
 * main computes one of its own at reserve (see the reserve calls in
 * ipc-handlers.js) and it is the same string, but the row exists before main
 * has answered - and the label is half of what tells two downloads apart (see
 * `findLive`), so it cannot wait for the acknowledgement.
 *
 * not translated. it is a quality and a container, which read the same in
 * every language, and the panel draws its own chip from the kind and the
 * request rather than from this.
 */
export const videoLabel = (height: number, container: string) =>
  `${height}p ${container}`

export const playlistLabel = (count: number) =>
  `${count} ${count === 1 ? "video" : "videos"}`
