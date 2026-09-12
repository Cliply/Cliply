// every download this session knows about, in one list

import { create } from "zustand"

import {
  downloadApi,
  type DownloadHistoryRow,
  type HistorySnapshot,
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
  /**
   * where the file landed, when main reported one
   *
   * kept so a finished row can reveal that file rather than only open the
   * download folder (`system:show-in-folder`). absent on a row read from a
   * history file an older version wrote, and on a playlist it names whichever
   * video landed last - which is still the right folder to open.
   */
  filePath?: string
  fileSize?: number
  error?: string
  category?: string
  startedAt: number
  finishedAt?: number
  /**
   * which of main's snapshots this row came out of
   *
   * `historyEpoch` in `ipc-handlers.js`: the number main moves every time a row
   * leaves the history. A row built from an event or by a hook has none, which
   * reads as `Infinity` - it is newer than any snapshot, and no reply about a
   * clear can be describing it.
   *
   * it is what lets a reply say which rows it covered without the panel having
   * to guess from its own clock or from the ids it happened to be holding.
   */
  epoch?: number
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

/** ...and the four it cannot */
const TERMINAL_STATUSES: ReadonlySet<DownloadRowStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
])

/**
 * whether a download is over, asked of a status rather than of a row
 *
 * named as the set it is rather than as "not live": a status main invents
 * tomorrow is a status nothing here can settle a row on, and the answer that
 * keeps a run cancellable is the conservative one. `interrupted` never arrives
 * on an event - it is derived by the history at load and at quit - and it is
 * listed because it is a status a row wears, and a reader asking this question
 * of one deserves the same answer wherever it came from.
 */
export const isTerminalStatus = (status: string): boolean =>
  TERMINAL_STATUSES.has(status as DownloadRowStatus)

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
  /**
   * how many downloads this install has ever finished
   *
   * main's counter and only main's: read once beside the history, and then
   * updated by the number every completed event carries, so the panel's total
   * moves as a download lands without this side ever counting anything itself.
   * it never goes down, and clearing the history leaves it alone - it counts
   * downloads, not rows.
   */
  lifetimeCompleted: number
  /** the panel's own chrome, session-only: nothing about it is worth keeping */
  panelOpen: boolean
  highlightedId: string | null
  /**
   * the downloads a Stop was pressed on before main could take it
   *
   * main reserves an id only after it has prepared the download folder, so a
   * cancel arriving before that is answered `false` against nothing at all -
   * while the row has been on screen, with a Stop on it, since the click. the
   * intent is kept here and issued at the first moment the id is known to
   * exist: the start acknowledgement, or an event that says main has it. the
   * rules for that are `lib/cancelIntent.ts`, which is the only thing that
   * should be writing to this. the playlist screen keeps its own version for
   * its own Cancel (see `cancelIntentRef` in `usePlaylistDownload`); this is
   * the panel's, for every kind of row.
   */
  cancelIntents: string[]
  /**
   * the downloads main has acknowledged, which their rows cannot say
   *
   * a row stays `starting` from the click until main's first event, and for a
   * download that takes a free slot and then says nothing - a trimmed one is
   * one ffmpeg pass, silent until it finishes - that first event is the
   * completion. so `starting` covers both "main has never heard of this id" and
   * "main has it and has not spoken yet", and the reply to a Stop cannot tell
   * those apart from the row alone. this is the difference, written down at the
   * acknowledgement, and it is why a Stop whose reply comes back after it is
   * not left waiting for an event that may never arrive.
   */
  admittedIds: string[]
  /**
   * the newest epoch a clear or a removal has answered with
   *
   * main moves `historyEpoch` whenever a row leaves the history and stamps it on
   * every answer about it, so a snapshot below this number was read before a
   * clear the user has since made: its rows describe a history that no longer
   * exists. Everything else in such a reply is still true, so it still lands -
   * the lifetime count, and at startup the flag - and only its rows are left
   * out, with a fresh read taking their place.
   *
   * this is the fourth attempt at the question and the first that does not
   * guess: a version counter of this window's own, a set of the ids it happened
   * to be holding, and a comparison of two clocks each missed an ordering,
   * because only main knows whether a snapshot was taken before its clear or
   * after it.
   */
  clearedEpoch: number

  add: (row: DownloadRow) => void
  applyEvent: (event: DownloadProgress) => void
  hydrate: (
    active: DownloadStatus[],
    history: DownloadHistoryRow[],
    lifetimeCompleted?: number,
    epoch?: number
  ) => void
  adopt: (
    active: DownloadStatus[],
    history: DownloadHistoryRow[],
    epoch?: number
  ) => void
  remove: (downloadId: string) => void
  clearFinished: () => void
  setHighlighted: (downloadId: string | null) => void
  setPanelOpen: (open: boolean) => void
  rememberCancelIntent: (downloadId: string) => void
  takeCancelIntent: (downloadId: string) => boolean
  markAdmitted: (downloadId: string) => void
  isAdmitted: (downloadId: string) => boolean
  forgetAdmitted: (downloadId: string) => void
  findLive: (candidate: DownloadIdentity) => DownloadRow | undefined
  reset: () => void
}

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  rows: [],
  hydrated: false,
  lifetimeCompleted: 0,
  panelOpen: false,
  highlightedId: null,
  cancelIntents: [],
  admittedIds: [],
  clearedEpoch: 0,

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
   *
   * the lifetime number it carries is taken even then: a download this window
   * never had a row for is still a download this install finished, and the
   * count read at hydration may have been taken before it landed.
   *
   * **a row that has finished is finished.** events are replayed - over the
   * hydration snapshot, and over a row a re-read of main's list has just
   * brought in - and the row they are replayed onto is sometimes newer than
   * they are. A `downloading` applied to a completed row puts a Stop back on a
   * file that is already on disk and a bar back on a download nobody is
   * waiting for, and a second completion is not a second download. So a
   * terminal row takes nothing from an event but the count.
   */
  applyEvent: (event) =>
    set((state) => {
      const lifetimeCompleted = adoptCount(
        state.lifetimeCompleted,
        event.lifetimeCompleted
      )

      const index = state.rows.findIndex(
        (row) => row.downloadId === event.downloadId
      )

      const settled = index >= 0 && isTerminalStatus(state.rows[index].status)

      if (index === -1 || settled) {
        return lifetimeCompleted === state.lifetimeCompleted
          ? state
          : { lifetimeCompleted }
      }

      const rows = [...state.rows]
      rows[index] = mergeEvent(rows[index], event)

      /**
       * ...and the lifetime number is whatever main says it is.
       *
       * main counts the completion before it sends the event and stamps the
       * new total onto it (`sendDownloadEvent` in ipc-handlers.js), so nothing
       * here has to work out whether this download has been counted already.
       * Counting on this side was the bug: hydration replaces a row's status
       * with a snapshot older than the completion and `DownloadEvents` replays
       * the event over it, so any tally derived from the rows ends the session
       * one too high or one too low.
       *
       * the larger of the two, because main's number only goes up: a replay of
       * an older event cannot walk the panel's total backwards.
       */
      return { rows, lifetimeCompleted }
    }),

  /**
   * build the list from what main knows, once, at startup
   *
   * main's answer wins for every id it mentions: it knows whether a download is
   * queued, running or long finished, and the only rows the renderer can have
   * by now are ones a hook added in the window between subscribing and this
   * landing. those are kept, because main has not heard of them yet.
   *
   * a reply read before a clear the user has since made brings no rows at all,
   * active or history: they describe a history that is gone. What it does bring
   * is the count and this flag, which no clear touches and which the panel
   * cannot do without - and `DownloadEvents` asks again straight away.
   */
  hydrate: (active, history, lifetimeCompleted, epoch) =>
    set((state) => {
      const stale = staleEpoch(state, epoch)
      const rows = stale
        ? []
        : active.map((status) => rowFromStatus(status, epoch))
      const seen = new Set(rows.map((row) => row.downloadId))

      for (const entry of stale ? [] : history) {
        if (seen.has(entry.download_id)) continue
        seen.add(entry.download_id)
        rows.push(rowFromHistory(entry, epoch))
      }

      for (const row of state.rows) {
        if (!seen.has(row.downloadId)) rows.push(row)
      }

      return {
        rows: rows.sort((a, b) => b.startedAt - a.startedAt),
        hydrated: true,
        /**
         * the larger of the two, for the same reason as above
         *
         * main answers this read from the same counter its events carry, so the
         * two can only disagree by a download that finished between them - and
         * whichever of the two saw it is the one to keep.
         */
        lifetimeCompleted: adoptCount(
          state.lifetimeCompleted,
          lifetimeCompleted
        )
      }
    }),

  /**
   * take the rows main knows that this list does not, and nothing else
   *
   * the answer to a download admitted after hydration: main reserved it while
   * this window was reading, or after it, so the only way its row can appear is
   * to ask again. Add-only, which is the whole difference from `hydrate`:
   * main's snapshot wins at startup because the store has nothing better, and
   * loses here because every row it already holds has been kept current by the
   * events since.
   *
   * a reply read before a clear the user has since made adds nothing: every row
   * in it, running or finished, describes a history that is gone. The ids that
   * were waiting on it stay waiting, and the next read - issued under the newer
   * epoch - is the one that answers for them.
   */
  adopt: (active, history, epoch) =>
    set((state) => {
      if (staleEpoch(state, epoch)) return state

      const seen = new Set(state.rows.map((row) => row.downloadId))
      const added: DownloadRow[] = []

      for (const status of active) {
        if (seen.has(status.downloadId)) continue
        seen.add(status.downloadId)
        added.push(rowFromStatus(status, epoch))
      }

      for (const entry of history) {
        if (seen.has(entry.download_id)) continue
        seen.add(entry.download_id)
        added.push(rowFromHistory(entry, epoch))
      }

      if (added.length === 0) return state

      return {
        rows: [...state.rows, ...added].sort(
          (a, b) => b.startedAt - a.startedAt
        )
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
    set((state) =>
      withHighlight(
        state,
        state.rows.filter((row) => row.downloadId !== downloadId)
      )
    )

    // ...and main's answer says which snapshots this removal covers, exactly as
    // a clear's does: a read still in flight would otherwise bring the row back
    downloadApi
      .removeHistory(downloadId)
      .then((left) => set((state) => settleRemoval(state, left)))
      .catch((error: unknown) => {
        console.error("Failed to forget that download:", error)
      })
  },

  /**
   * "clear history": the rows with nothing left to happen to them go
   *
   * the list empties on the click rather than when main answers - the user
   * asked for it and there is nothing to wait for - and then main's answer is
   * read, because the two do not always agree about which rows those were. A
   * download that finishes between the click and main handling the clear is
   * terminal by the time main gets there and live by the time this ran: main
   * drops it, this keeps it, and the row sits in the panel until the next
   * launch loses it. So a row that was here when the clear was sent, is not
   * live now, and is not in main's answer goes too.
   *
   * a row that arrived after the clear was sent is kept whatever the answer
   * says: main had not heard of it when it built that list.
   *
   * main's answer says which snapshots this covers: it carries the epoch the
   * clear happened at, and every row still in flight from before it describes a
   * history that no longer exists. That is the whole of the reconciliation now -
   * no clock, no set of ids this window happened to be holding.
   *
   * `lifetimeCompleted` is deliberately untouched. the number counts downloads
   * this install finished, not rows it still keeps, so emptying the list is not
   * a reason for it to move.
   */
  clearFinished: () => {
    // the ids this side was holding when the clear went out. anything else is
    // younger than the request and cannot be something main meant to remove
    const sent = new Set(get().rows.map((row) => row.downloadId))

    set((state) => withHighlight(state, state.rows.filter(isLiveRow)))

    downloadApi
      .clearHistory()
      .then((left) => set((state) => settleRemoval(state, left, sent)))
      .catch((error: unknown) => {
        // the rows are already gone from the panel and main either cleared its
        // file or did not. nothing here can put that right, and asking again
        // would be a second clear the user did not ask for
        console.error("Failed to clear the download history:", error)
      })
  },

  setHighlighted: (downloadId) => set({ highlightedId: downloadId }),
  setPanelOpen: (open) => set({ panelOpen: open }),

  // the state half of it only. whether an intent is kept at all, and what makes
  // it go out, is `lib/cancelIntent.ts`
  rememberCancelIntent: (downloadId) =>
    set((state) =>
      state.cancelIntents.includes(downloadId)
        ? state
        : { cancelIntents: [...state.cancelIntents, downloadId] }
    ),

  /**
   * take the intent back, and say whether there was one
   *
   * read and clear together so the same intent cannot be issued twice by two
   * events arriving in one batch: a cancel asked for once is asked for once.
   */
  takeCancelIntent: (downloadId) => {
    const held = get().cancelIntents.includes(downloadId)

    if (held) {
      set((state) => ({
        cancelIntents: state.cancelIntents.filter((id) => id !== downloadId)
      }))
    }

    return held
  },

  // written down once, at the acknowledgement, and read by the reply to a Stop
  // that was still in flight then. `lib/cancelIntent.ts` owns all three
  markAdmitted: (downloadId) =>
    set((state) =>
      state.admittedIds.includes(downloadId)
        ? state
        : { admittedIds: [...state.admittedIds, downloadId] }
    ),

  isAdmitted: (downloadId) => get().admittedIds.includes(downloadId),

  // an id nothing will ask about again. dropped when its download ends, so a
  // long session does not carry every id it ever started
  forgetAdmitted: (downloadId) =>
    set((state) =>
      state.admittedIds.includes(downloadId)
        ? { admittedIds: state.admittedIds.filter((id) => id !== downloadId) }
        : state
    ),

  /**
   * the download already in flight that this one would duplicate
   *
   * two processes writing the same `.part` file corrupt each other, so a second
   * click on an identical request opens the panel at the first one instead of
   * spawning. identity is the kind, the url, the label (which carries the
   * quality, the container or the mode), the range and what the request asks
   * for - the things that decide which file lands where.
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
        outputOf(row.request) === outputOf(candidate.request) &&
        sameTimeRange(timeRangeOf(row.request), timeRangeOf(candidate.request))
    )
  },

  reset: () =>
    set(() => ({
      rows: [],
      // the clears go with the list they belong to: nothing that comes back
      // after this belongs to the session that counted them
      clearedEpoch: 0,
      hydrated: false,
      lifetimeCompleted: 0,
      panelOpen: false,
      highlightedId: null,
      cancelIntents: [],
      admittedIds: []
    }))
}))

/** for the hooks and the event handler, which are not components */
export const downloadsActions = {
  add: (row: DownloadRow) => useDownloadsStore.getState().add(row),
  applyEvent: (event: DownloadProgress) =>
    useDownloadsStore.getState().applyEvent(event),
  hydrate: (
    active: DownloadStatus[],
    history: DownloadHistoryRow[],
    lifetimeCompleted?: number,
    epoch?: number
  ) =>
    useDownloadsStore
      .getState()
      .hydrate(active, history, lifetimeCompleted, epoch),
  adopt: (
    active: DownloadStatus[],
    history: DownloadHistoryRow[],
    epoch?: number
  ) => useDownloadsStore.getState().adopt(active, history, epoch),
  /** whether a reply read at this epoch describes a history that is gone */
  staleSnapshot: (epoch: number) =>
    epoch < useDownloadsStore.getState().clearedEpoch,
  findLive: (candidate: DownloadIdentity) =>
    useDownloadsStore.getState().findLive(candidate),
  setHighlighted: (downloadId: string | null) =>
    useDownloadsStore.getState().setHighlighted(downloadId),
  setPanelOpen: (open: boolean) =>
    useDownloadsStore.getState().setPanelOpen(open),
  rememberCancelIntent: (downloadId: string) =>
    useDownloadsStore.getState().rememberCancelIntent(downloadId),
  takeCancelIntent: (downloadId: string) =>
    useDownloadsStore.getState().takeCancelIntent(downloadId),
  markAdmitted: (downloadId: string) =>
    useDownloadsStore.getState().markAdmitted(downloadId),
  isAdmitted: (downloadId: string) =>
    useDownloadsStore.getState().isAdmitted(downloadId),
  forgetAdmitted: (downloadId: string) =>
    useDownloadsStore.getState().forgetAdmitted(downloadId),
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

/** the one number at the top of the panel: downloads finished since install */
export const useLifetimeCompleted = (): number =>
  useDownloadsStore((state) => state.lifetimeCompleted)

/** how many downloads the user is still waiting on, for the toggle's badge */
export const useActiveCount = (): number =>
  useDownloadsStore(
    (state) => state.rows.filter((row) => isLiveRow(row)).length
  )

/**
 * whether this reply was read before a clear the user has since made
 *
 * a reply with no epoch at all is one from a build that does not stamp them, or
 * a caller that is not reading main (the tests): there is nothing to judge it
 * against, so it is current.
 */
const staleEpoch = (state: DownloadsState, epoch?: number): boolean =>
  typeof epoch === "number" && epoch < state.clearedEpoch

/** which snapshot a row came from, or `Infinity` for one no snapshot made */
const epochOf = (row: DownloadRow): number =>
  typeof row.epoch === "number" ? row.epoch : Number.POSITIVE_INFINITY

/**
 * what is left after a clear or a removal, given main's answer
 *
 * the rows main still has are the rows that stay, and everything else that was
 * built from a snapshot older than this answer goes: those rows are what the
 * user removed, whether or not this window ever saw them.
 *
 * `sent` is the ids this window was holding when a clear went out. A row from
 * that set which has finished since is one main removed while the renderer
 * still thought it was running, and it goes too. Anything younger than the
 * request - a hook's row, a download admitted since - is kept whatever the
 * answer says: main had not heard of it when it built that list.
 */
function settleRemoval(
  state: DownloadsState,
  left: HistorySnapshot,
  sent?: Set<string>
): Partial<DownloadsState> {
  const kept = new Set(left.rows.map((entry) => entry.download_id))

  const rows = state.rows.filter(
    (row) =>
      isLiveRow(row) ||
      kept.has(row.downloadId) ||
      (epochOf(row) >= left.epoch && !sent?.has(row.downloadId))
  )

  return {
    ...withHighlight(state, rows),
    clearedEpoch: Math.max(state.clearedEpoch, left.epoch)
  }
}

/**
 * the rows, and the highlight only if it still names one of them
 *
 * a ring pointing at a row that has been cleared away would reappear on the
 * next row to take its id, which is never, so it would simply never clear.
 */
function withHighlight(
  state: DownloadsState,
  rows: DownloadRow[]
): Partial<DownloadsState> {
  return {
    rows,
    highlightedId: rows.some((row) => row.downloadId === state.highlightedId)
      ? state.highlightedId
      : null
  }
}

/**
 * the lifetime count, given what main just said about it
 *
 * main owns the number and only ever raises it, so anything smaller is an older
 * message overtaking a newer one - a replayed event, or a read taken before the
 * completion that arrived first. a message carrying no number at all (an event
 * that is not a completion, a preload too old to send one) leaves it alone.
 */
const adoptCount = (held: number, arrived?: number): number =>
  typeof arrived === "number" ? Math.max(held, arrived) : held

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
    filePath: event.file_path ?? row.filePath,
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
function rowFromStatus(status: DownloadStatus, epoch?: number): DownloadRow {
  const kind = kindOf(status)

  return {
    epoch,
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
function rowFromHistory(
  entry: DownloadHistoryRow,
  epoch?: number
): DownloadRow {
  return {
    epoch,
    downloadId: entry.download_id,
    kind: entry.kind || "video",
    platform: platformOf(entry.platform),
    title: entry.title || "",
    label: entry.label || "",
    status: entry.status,
    // the history keeps no percentages: a finished download is at 100 and
    // everything else stopped somewhere nobody wrote down
    progress: entry.status === "completed" ? 100 : 0,
    // main writes the total at reserve, so a row from this version has one. a
    // row from a history file written before it does not, and the selection it
    // stored is the same number - which is what a Retry of an interrupted
    // playlist then counts from, rather than counting from nothing until the
    // first event arrives
    itemsTotal: entry.items_total ?? entryCount(entry.request),
    itemsSaved: entry.items_saved,
    itemsReused: entry.items_reused,
    itemsSkipped: entry.items_skipped,
    filename: entry.filename,
    filePath: entry.file_path,
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
 * what a request asks for, beyond which link it is
 *
 * the label already carries part of this for a single download - "1080p mp4",
 * "mp3" - and carries none of it for a playlist, whose label counts videos. so
 * the request is read directly, and three things it says are what separate two
 * runs of the same link:
 *
 * - **what the files are.** the same playlist as video and as audio writes two
 *   different sets of files, and the second click must start rather than be
 *   sent to the first run.
 * - **which videos.** a playlist's selection is not its size: entry 1 alone and
 *   entry 2 alone are both "1 video" at the same height, and they are different
 *   downloads. the positions are compared, sorted, because the same selection
 *   ticked in a different order is the same run.
 * - **which soundtrack.** the same video at the same height with a dub and
 *   without one are two files, and no label mentions the language.
 *
 * `precise_cut` stays out on purpose: it changes how the range is cut, not what
 * the run is of, and `time_range` beside this is what actually decides the
 * file. `ignore_archive` stays out too - a playlist run that ignores the
 * archive writes the same files as one that does not, so starting both would be
 * two processes over one set of paths, which is what this check exists to
 * prevent.
 *
 * read through a cast for the same reason the range below is: the caller may
 * not know which of the four request shapes it is holding, and a key none of
 * them has is absent on both sides of the comparison.
 *
 * @returns the fields joined, so "absent" and "absent" compare equal
 */
const outputOf = (request?: DownloadRequest): string => {
  const asked = request as
    | {
        type?: string
        height?: number
        container?: string
        audio_mode?: string
        audio_language?: string
        entries?: { index?: number; id?: string | null }[]
      }
    | undefined

  return [
    asked?.type,
    asked?.height,
    asked?.container,
    asked?.audio_mode,
    asked?.audio_language,
    selectionOf(asked?.entries)
  ].join("|")
}

/**
 * which videos of a playlist a run was asked for
 *
 * by position rather than by id: the index is what the request is built from
 * and what main archives against, and a listing row can arrive with a null id
 * (an unavailable video) where the position is always there. sorted so the
 * order the boxes were ticked in is not part of the identity.
 *
 * @param entries the selection a playlist request carries, if it is one
 * @returns the positions joined, or "" for a request with no selection at all
 */
const selectionOf = (
  entries?: { index?: number; id?: string | null }[]
): string => {
  if (!Array.isArray(entries)) return ""

  return entries
    .map((entry) => String(entry?.index ?? entry?.id ?? ""))
    .sort()
    .join(",")
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
