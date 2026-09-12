// every download this session knows about, in one list

import { create } from "zustand"

import {
  downloadApi,
  type DownloadHistoryRow,
  type DownloadKind,
  type DownloadProgress,
  type DownloadRequest,
  type DownloadRowStatus,
  type DownloadStatus,
  type TimeRange
} from "@/lib/api"
import type { Platform } from "@/lib/stores/store"

/**
 * one download, whatever kind it is and whoever started it
 *
 * camelCase, unlike the history rows and the progress payloads it is built
 * from: this is renderer state, like the playlist hook's, and the snake_case
 * spelling stops at the two mappers below.
 */
export interface DownloadRow {
  downloadId: string
  kind: DownloadKind
  platform: Platform
  title: string
  /** "1080p mp4", "mp3", "12 videos" */
  label: string
  status: DownloadRowStatus
  progress: number
  speed?: string
  eta?: string
  // a trimmed download is one ffmpeg pass that reports at the end, so there is
  // no percentage to draw while it works
  indeterminate?: boolean
  // playlist rows only
  itemsCompleted?: number
  itemsTotal?: number
  itemsSaved?: number
  itemsReused?: number
  itemsSkipped?: number
  filename?: string
  fileSize?: number
  error?: string
  category?: string
  startedAt: number
  finishedAt?: number
  /**
   * what a retry re-sends, typed per kind.
   *
   * optional because a row is only as complete as what it was built from: a
   * history file written by an older version has none, and a row with no
   * request is a row that can be read but not started again.
   */
  request?: DownloadRequest
}

/** the statuses a download can still move on from */
const LIVE_STATUSES: ReadonlySet<DownloadRowStatus> = new Set([
  "queued",
  "starting",
  "downloading"
])

/** whether this row is one the user is still waiting on */
export const isLiveRow = (row?: DownloadRow): boolean =>
  Boolean(row && LIVE_STATUSES.has(row.status))

export const isTerminalStatus = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

/**
 * enough of a row to ask whether one like it is already running
 *
 * the hooks build the whole row before asking, so this is the row itself
 * rather than a request: the label is half the identity and only the caller
 * that built it knows what it is.
 */
export type DownloadIdentity = Pick<DownloadRow, "kind" | "label" | "request">

interface DownloadsState {
  rows: DownloadRow[]
  /** whether the one hydration read has landed. the panel has nothing to say
   * about an empty list until it has */
  hydrated: boolean
  /** the panel's own chrome, session-only: nothing about it is worth keeping */
  panelOpen: boolean
  highlightedId: string | null

  add: (row: DownloadRow) => void
  applyEvent: (event: DownloadProgress) => void
  hydrate: (active: DownloadStatus[], history: DownloadHistoryRow[]) => void
  remove: (downloadId: string) => void
  clearFinished: () => void
  setHighlighted: (downloadId: string | null) => void
  setPanelOpen: (open: boolean) => void
  findLive: (candidate: DownloadIdentity) => DownloadRow | undefined
  reset: () => void
}

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  rows: [],
  hydrated: false,
  panelOpen: false,
  highlightedId: null,

  // newest first, which is the order the panel lists them in and the order the
  // history keeps them in
  add: (row) =>
    set((state) => ({
      rows: [
        row,
        ...state.rows.filter((known) => known.downloadId !== row.downloadId)
      ]
    })),

  /**
   * fold one progress event into the row it names
   *
   * an event for an id we do not have creates nothing. it is a download from
   * before a reload, or one started by a window that is gone, and hydration is
   * what restores those - inventing a row here would give it no title, no
   * label and no request, which is a row that can be neither read nor retried.
   */
  applyEvent: (event) =>
    set((state) => {
      const index = state.rows.findIndex(
        (row) => row.downloadId === event.downloadId
      )

      if (index === -1) return state

      const rows = [...state.rows]
      rows[index] = mergeEvent(rows[index], event)

      return { rows }
    }),

  /**
   * build the list from what main knows, once, at startup
   *
   * main's answer wins for every id it mentions: it knows whether a download is
   * queued, running or long finished, and the only rows the renderer can have
   * by now are ones a hook added in the window between subscribing and this
   * landing. those are kept, because main has not heard of them yet.
   */
  hydrate: (active, history) =>
    set((state) => {
      const rows = [...active.map(rowFromStatus)]
      const seen = new Set(rows.map((row) => row.downloadId))

      for (const entry of history) {
        if (seen.has(entry.download_id)) continue
        seen.add(entry.download_id)
        rows.push(rowFromHistory(entry))
      }

      for (const row of state.rows) {
        if (!seen.has(row.downloadId)) rows.push(row)
      }

      return {
        rows: rows.sort((a, b) => b.startedAt - a.startedAt),
        hydrated: true
      }
    }),

  /**
   * forget one row here and on disk
   *
   * only ever called for a row with nothing left to happen to it: main refuses
   * to forget a live one, and its next status write would put it back. stopping
   * a queued download is `cancelDownload`, and the cancelled row it leaves
   * behind is removable like any other.
   */
  remove: (downloadId) => {
    set((state) => ({
      rows: state.rows.filter((row) => row.downloadId !== downloadId),
      highlightedId:
        state.highlightedId === downloadId ? null : state.highlightedId
    }))

    downloadApi.removeHistory(downloadId).catch((error: unknown) => {
      console.error("Failed to forget that download:", error)
    })
  },

  /**
   * "clear finished": the rows with nothing left to happen to them go
   *
   * main answers with what is left, which is the same set this keeps, so the
   * answer is not read back: adopting it would overwrite a row a hook added a
   * moment ago and main has not heard of yet.
   */
  clearFinished: () => {
    set((state) => {
      const rows = state.rows.filter((row) => isLiveRow(row))

      return {
        rows,
        highlightedId: rows.some(
          (row) => row.downloadId === state.highlightedId
        )
          ? state.highlightedId
          : null
      }
    })

    downloadApi.clearHistory().catch((error: unknown) => {
      console.error("Failed to clear the download history:", error)
    })
  },

  setHighlighted: (downloadId) => set({ highlightedId: downloadId }),
  setPanelOpen: (open) => set({ panelOpen: open }),

  /**
   * the download already in flight that this one would duplicate
   *
   * two processes writing the same `.part` file corrupt each other, so a second
   * click on an identical request opens the panel at the first one instead of
   * spawning. identity is the kind, the url, the label (which carries the
   * quality, the container or the mode) and the range - the four things that
   * decide which file lands where.
   *
   * a candidate with no url matches nothing: there is nothing to be identical
   * to, and refusing to start would be worse than starting twice.
   */
  findLive: (candidate) => {
    const url = urlOf(candidate.request)

    if (!url) return undefined

    return get().rows.find(
      (row) =>
        isLiveRow(row) &&
        row.kind === candidate.kind &&
        row.label === candidate.label &&
        urlOf(row.request) === url &&
        sameTimeRange(timeRangeOf(row.request), timeRangeOf(candidate.request))
    )
  },

  reset: () =>
    set({ rows: [], hydrated: false, panelOpen: false, highlightedId: null })
}))

/** for the hooks and the event handler, which are not components */
export const downloadsActions = {
  add: (row: DownloadRow) => useDownloadsStore.getState().add(row),
  applyEvent: (event: DownloadProgress) =>
    useDownloadsStore.getState().applyEvent(event),
  hydrate: (active: DownloadStatus[], history: DownloadHistoryRow[]) =>
    useDownloadsStore.getState().hydrate(active, history),
  findLive: (candidate: DownloadIdentity) =>
    useDownloadsStore.getState().findLive(candidate),
  setHighlighted: (downloadId: string | null) =>
    useDownloadsStore.getState().setHighlighted(downloadId),
  setPanelOpen: (open: boolean) =>
    useDownloadsStore.getState().setPanelOpen(open),
  rowOf: (downloadId?: string) =>
    downloadId
      ? useDownloadsStore
          .getState()
          .rows.find((row) => row.downloadId === downloadId)
      : undefined
}

/** the row this id names, or nothing while it names none */
export const useDownloadRow = (downloadId?: string): DownloadRow | undefined =>
  useDownloadsStore((state) =>
    downloadId
      ? state.rows.find((row) => row.downloadId === downloadId)
      : undefined
  )

export const useDownloadRows = (): DownloadRow[] =>
  useDownloadsStore((state) => state.rows)

/** how many downloads the user is still waiting on, for the toggle's badge */
export const useActiveCount = (): number =>
  useDownloadsStore(
    (state) => state.rows.filter((row) => isLiveRow(row)).length
  )

/**
 * merge one event into a row
 *
 * `progress` keeps what it had when the event reports none: a failure and a
 * cancel both report 0, and a download that got 60% of the way did not
 * un-download it. `error` and `category` are overwritten rather than merged,
 * because a repaired retry emits `downloading` again and the row should stop
 * carrying the failure that provoked the update.
 */
function mergeEvent(row: DownloadRow, event: DownloadProgress): DownloadRow {
  const terminal = isTerminalStatus(event.status)

  return {
    ...row,
    status: event.status,
    progress: event.progress || row.progress,
    speed: event.speed,
    eta: event.eta,
    indeterminate: event.indeterminate,
    itemsCompleted: event.items_completed ?? row.itemsCompleted,
    itemsTotal: event.items_total ?? row.itemsTotal,
    itemsSaved: event.items_saved ?? row.itemsSaved,
    itemsReused: event.items_reused ?? row.itemsReused,
    itemsSkipped: event.items_skipped ?? row.itemsSkipped,
    filename: event.filename ?? row.filename,
    fileSize: event.file_size ?? row.fileSize,
    error: event.error,
    category: event.category,
    finishedAt: terminal ? Date.now() : row.finishedAt
  }
}

/**
 * a row from a download main still has in flight
 *
 * `type` says what is being fetched and is not the same question as which row
 * to draw: a playlist of audio fetches audio and is still a playlist. main
 * decides it the same way (see historyKind in services/download-runner.js).
 */
function rowFromStatus(status: DownloadStatus): DownloadRow {
  const kind = kindOf(status)

  return {
    downloadId: status.downloadId,
    kind,
    platform: platformOf(status.platform),
    title: status.title || "",
    label: status.label || "",
    status: status.status,
    progress: status.progress || 0,
    filename: status.filename,
    error: status.error,
    startedAt: status.startTime || Date.now(),
    request: status.request,
    // a playlist that is still queued has run nothing and counted nothing, so
    // the only total there is is the selection its request carries
    ...(kind === "playlist" ? { itemsTotal: entryCount(status.request) } : null)
  }
}

/** a row from a download that is over, or was when this install last ran */
function rowFromHistory(entry: DownloadHistoryRow): DownloadRow {
  return {
    downloadId: entry.download_id,
    kind: entry.kind || "video",
    platform: platformOf(entry.platform),
    title: entry.title || "",
    label: entry.label || "",
    status: entry.status,
    // the history keeps no percentages: a finished download is at 100 and
    // everything else stopped somewhere nobody wrote down
    progress: entry.status === "completed" ? 100 : 0,
    itemsTotal: entry.items_total,
    itemsSaved: entry.items_saved,
    itemsReused: entry.items_reused,
    itemsSkipped: entry.items_skipped,
    filename: entry.filename,
    fileSize: entry.file_size,
    error: entry.error,
    category: entry.category,
    startedAt: entry.started_at || 0,
    finishedAt: entry.finished_at,
    request: entry.request
  }
}

function kindOf(status: DownloadStatus): DownloadKind {
  if (status.playlist) return "playlist"
  if (status.type === "audio") return "audio"
  if (status.platform === "tiktok" || status.platform === "pinterest") {
    return "simple"
  }

  return "video"
}

const platformOf = (platform?: string): Platform =>
  platform === "tiktok" || platform === "pinterest" ? platform : "youtube"

const urlOf = (request?: DownloadRequest): string | undefined => request?.url

const entryCount = (request?: DownloadRequest): number | undefined => {
  const entries = (request as { entries?: unknown[] } | undefined)?.entries

  return Array.isArray(entries) ? entries.length : undefined
}

/**
 * the range a request asked for, if its kind has one at all
 *
 * read through a cast rather than a `kind` check because the caller may not
 * know which of the four requests it is holding: a playlist and a simple
 * platform accept no range, and absent is the right answer for both.
 */
const timeRangeOf = (request?: DownloadRequest): TimeRange | undefined =>
  (request as { time_range?: TimeRange } | undefined)?.time_range

const sameTimeRange = (a?: TimeRange, b?: TimeRange): boolean => {
  if (!a || !b) return !a && !b

  return a.start === b.start && a.end === b.end
}
