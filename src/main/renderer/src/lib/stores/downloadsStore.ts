// every download this session knows about, in one list

import { create } from "zustand"

import {
  downloadApi,
  type DownloadHistoryRow,
  type DownloadListSnapshot,
  type DownloadKind,
  type DownloadProgress,
  type DownloadRequest,
  type DownloadRowStatus,
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
   * a row this window drew that main has not listed yet
   *
   * the hooks draw a row from the click rather than from the acknowledgement,
   * so for a moment there is a row main has never heard of. It is kept through
   * the pushes until one names the id, and a start main refused stays as the
   * failed row that refusal made: no list of main's will ever name a download
   * it did not accept.
   */
  local?: boolean
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
   * the last list main sent, by main's own count of them
   *
   * it pushes the whole list after every change to it and answers a read with
   * the same thing, each stamped with a number that only goes up. Anything at or
   * below this has been seen already, so a push that overtakes the reply to a
   * read - or a reply that lands after the push it provoked - changes nothing.
   */
  lastSeq: number
  /**
   * what the events know and a snapshot cannot
   *
   * main pushes the list when it changes - a reservation, a slot, a settle, a
   * clear, a removal - and never four times a second for a percentage. The bar,
   * the speed, the eta and the item counts arrive on `download:progress`
   * instead and are kept here, by id, so replacing the rows with a newer
   * snapshot does not send every bar back to where the download was accepted.
   *
   * a terminal event writes its outcome here too, so a row settles the moment
   * its download ends rather than when the push confirms it. An entry goes when
   * a snapshot lists that row as finished or stops listing it at all; an id no
   * snapshot has named yet keeps its overlay against the push that will,
   * bounded so a window that hears about downloads it has no rows for cannot
   * grow without end.
   */
  overlay: Record<string, DownloadOverlay>

  add: (row: DownloadRow) => void
  applyEvent: (event: DownloadProgress) => void
  applySnapshot: (snapshot: DownloadListSnapshot) => void
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
  lastSeq: 0,
  overlay: {},

  // newest first, which is the order the panel lists them in and the order the
  // history keeps them in
  add: (row) =>
    set((state) => ({
      rows: [
        { ...row, local: true },
        ...state.rows.filter((known) => known.downloadId !== row.downloadId)
      ]
    })),

  /**
   * fold one progress event into what this window knows
   *
   * the event is the fast half of the truth: main pushes the list when it
   * changes, and a bar moves far more often than that. So an event writes the
   * overlay for its id and the row it names takes what the overlay holds - and
   * the next push, which knows nothing about percentages, can replace the rows
   * without a single bar starting again.
   *
   * an event for an id this window has no row for is kept too: a window that
   * reloaded mid-download hears the progress before main's push arrives, and
   * the row it belongs to is the one that push brings.
   *
   * **a row that has finished is finished.** the outcome is written the moment
   * it arrives, so the toast and the inline bar do not wait for the push that
   * confirms it, and nothing later walks it back: a `downloading` after a
   * completion is an event its own download has overtaken.
   */
  applyEvent: (event) =>
    set((state) => {
      const overlay = mergeOverlay(state.overlay, event, state.rows)
      const lifetimeCompleted = adoptCount(
        state.lifetimeCompleted,
        event.lifetimeCompleted
      )

      const index = state.rows.findIndex(
        (row) => row.downloadId === event.downloadId
      )

      if (index === -1) return { overlay, lifetimeCompleted }

      const rows = [...state.rows]
      rows[index] = withOverlay(rows[index], overlay[event.downloadId])

      return { rows, overlay, lifetimeCompleted }
    }),

  /**
   * take main's list, whole
   *
   * this is the whole of the reconciliation. Main builds the list from its own
   * memory after every change to it and pushes it, so these rows replace what is
   * here rather than merging into it: there is no interleaving left to reason
   * about, and no question about which of two views of a download is the newer
   * one. Four rounds of review found one more ordering each time this was a
   * merge.
   *
   * what this side adds back is what main's list does not carry: the progress
   * the events have supplied, and the rows this window drew for a click main has
   * not answered for yet.
   *
   * an older snapshot is ignored outright, because a push can overtake the reply
   * to a read and both carry main's own count.
   */
  applySnapshot: (snapshot) =>
    set((state) => {
      if (snapshot.seq <= state.lastSeq) return state

      const listed = new Set(snapshot.rows.map((entry) => entry.download_id))
      const overlay = pruneOverlay(state.overlay, snapshot)

      const rows = snapshot.rows.map((entry) =>
        withOverlay(rowFromHistory(entry), overlay[entry.download_id])
      )

      // the rows this window drew for a click main has not listed yet, and the
      // ones whose start it refused: a download main never accepted is one no
      // list of main's will ever name
      for (const row of state.rows) {
        if (row.local && !listed.has(row.downloadId)) rows.push(row)
      }

      return {
        ...withHighlight(
          state,
          rows.sort((a, b) => b.startedAt - a.startedAt)
        ),
        overlay,
        lastSeq: snapshot.seq,
        hydrated: true,
        lifetimeCompleted: adoptCount(
          state.lifetimeCompleted,
          snapshot.lifetimeCompleted
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

    // main answers with the list as it stands afterwards and pushes the same
    // thing to every window: the reply is applied like any other snapshot, so
    // nothing here has to work out what it covered
    downloadApi
      .removeHistory(downloadId)
      .then((snapshot) => get().applySnapshot(snapshot))
      .catch((error: unknown) => {
        console.error("Failed to forget that download:", error)
      })
  },

  /**
   * "clear history": the rows with nothing left to happen to them go
   *
   * the list empties on the click rather than when main answers - the user asked
   * for it and there is nothing to wait for - and main's answer is the list as
   * it stands afterwards, applied like any other snapshot. A download that
   * finished between the click and main handling it is terminal on main's side
   * and absent from that answer, which is how the panel stops showing it.
   *
   * `lifetimeCompleted` is deliberately untouched. the number counts downloads
   * this install finished, not rows it still keeps, so emptying the list is not
   * a reason for it to move.
   */
  clearFinished: () => {
    set((state) => withHighlight(state, state.rows.filter(isLiveRow)))

    downloadApi
      .clearHistory()
      .then((snapshot) => get().applySnapshot(snapshot))
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
      // the list and what this window knew about it go together: nothing that
      // arrives after this belongs to the session that asked for it
      lastSeq: 0,
      overlay: {},
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
  applySnapshot: (snapshot: DownloadListSnapshot) =>
    useDownloadsStore.getState().applySnapshot(snapshot),
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
 * what one download's events have said that main's row does not carry
 *
 * main's list knows what a download is and how it ended; the events know where
 * it has got to. This is the second, kept per id so a snapshot can replace the
 * rows without the bars starting again.
 */
export interface DownloadOverlay {
  status?: DownloadRowStatus
  progress?: number
  speed?: string
  eta?: string
  indeterminate?: boolean
  itemsCompleted?: number
  itemsTotal?: number
  itemsSaved?: number
  itemsReused?: number
  itemsSkipped?: number
  filename?: string
  filePath?: string
  fileSize?: number
  error?: string
  category?: string
}

/**
 * how many ids with no row of their own may keep an overlay
 *
 * events arrive for downloads this window has no row for - it reloaded
 * mid-run, another window started them - and the push that names them is
 * usually a moment away. A cap, because "usually" is not "always".
 *
 * it counts those ids and no others. An overlay with a row behind it is the bar
 * on screen, and there are never more of them than there are rows.
 */
const ORPHAN_LIMIT = 200

/** what this event leaves behind, over whatever the id had already said */
function mergeOverlay(
  overlay: Record<string, DownloadOverlay>,
  event: DownloadProgress,
  rows: DownloadRow[]
): Record<string, DownloadOverlay> {
  const held = overlay[event.downloadId]

  // a download that has ended has ended: an event its own completion overtook
  // cannot put the bar back
  if (held?.status && isTerminalStatus(held.status)) return overlay

  const next: DownloadOverlay = {
    ...held,
    status: event.status,
    progress: event.progress || held?.progress,
    speed: event.speed,
    eta: event.eta,
    indeterminate: event.indeterminate,
    itemsCompleted: event.items_completed ?? held?.itemsCompleted,
    itemsTotal: event.items_total ?? held?.itemsTotal,
    itemsSaved: event.items_saved ?? held?.itemsSaved,
    itemsReused: event.items_reused ?? held?.itemsReused,
    itemsSkipped: event.items_skipped ?? held?.itemsSkipped,
    filename: event.filename ?? held?.filename,
    filePath: event.file_path ?? held?.filePath,
    fileSize: event.file_size ?? held?.fileSize,
    error: event.error,
    category: event.category
  }

  if (held) return { ...overlay, [event.downloadId]: next }

  /**
   * ...and the oldest orphan goes when there are too many of them.
   *
   * only an orphan: capping the whole map evicted the bar of a download that
   * was on screen and running - three running rows behind two hundred queued
   * ones sent one of them back to 0% and lost a trimmed run's indeterminate
   * flag, because a queued row's every event was a new entry.
   */
  const onScreen = new Set(rows.map((row) => row.downloadId))
  const orphans = Object.keys(overlay).filter(
    (downloadId) => !onScreen.has(downloadId)
  )

  if (orphans.length < ORPHAN_LIMIT) {
    return { ...overlay, [event.downloadId]: next }
  }

  const { [orphans[0]]: expired, ...rest } = overlay
  void expired

  return { ...rest, [event.downloadId]: next }
}

/**
 * the overlays worth keeping once main has spoken
 *
 * a row main lists as finished needs none: the snapshot carries the outcome and
 * the entry would only repeat it. What is kept is what is still running, and
 * what main has not mentioned yet.
 */
function pruneOverlay(
  overlay: Record<string, DownloadOverlay>,
  snapshot: DownloadListSnapshot
): Record<string, DownloadOverlay> {
  const settled = new Set(
    snapshot.rows
      .filter((entry) => isTerminalStatus(entry.status))
      .map((entry) => entry.download_id)
  )

  return Object.fromEntries(
    Object.entries(overlay).filter(([downloadId]) => !settled.has(downloadId))
  )
}

/**
 * one of main's rows, with what the events have added to it since
 *
 * main's word on a finished download wins over an overlay that was still
 * watching it run; an overlay that has seen a download end wins over a row main
 * wrote before it did.
 */
function withOverlay(row: DownloadRow, held?: DownloadOverlay): DownloadRow {
  if (!held) return row

  const settled = isTerminalStatus(row.status)
  const status = settled ? row.status : (held.status ?? row.status)
  const ended = isTerminalStatus(status)

  return {
    ...row,
    status,
    progress: settled
      ? row.progress
      : status === "completed"
        ? 100
        : (held.progress ?? row.progress),
    speed: ended ? undefined : held.speed,
    eta: ended ? undefined : held.eta,
    indeterminate: ended ? undefined : held.indeterminate,
    itemsCompleted: held.itemsCompleted ?? row.itemsCompleted,
    itemsTotal: row.itemsTotal ?? held.itemsTotal,
    itemsSaved: row.itemsSaved ?? held.itemsSaved,
    itemsReused: row.itemsReused ?? held.itemsReused,
    itemsSkipped: row.itemsSkipped ?? held.itemsSkipped,
    filename: row.filename ?? held.filename,
    filePath: row.filePath ?? held.filePath,
    fileSize: row.fileSize ?? held.fileSize,
    error: row.error ?? held.error,
    category: row.category ?? held.category
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
