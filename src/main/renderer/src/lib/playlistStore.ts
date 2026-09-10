import type { AudioMode, PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import { useMixedLinkStore } from "@/lib/mixedLinkStore"

import { create } from "zustand"

/**
 * the quality menu is a fixed ceiling picker rather than a list derived from
 * the video, because a flat listing carries no formats at all. 1080p is the row
 * it opens on: it is the height most people want, and yt-dlp reads it as "best
 * available up to this" per video rather than as a filter, so nothing is ever
 * skipped for lacking it.
 */
export const PLAYLIST_DEFAULT_CEILING = 1080

export type PlaylistTab = "video" | "audio"

/**
 * what one row is doing, in the only terms the events actually support.
 *
 * `saved` is claimed only when the run reported the item's file landing - the
 * engine's rule is that it may undercount a save and never overcount one, and
 * this follows it. `skipped` is a row the run started and left without a file.
 * `reused` is a video this destination already has: yt-dlp never announces one
 * at all, so the positions come from the run's own terminal event, which is
 * where the "already downloaded" count comes from too. a row the run never
 * reached stays `pending`.
 */
export type PlaylistItemState =
  | "pending"
  | "downloading"
  | "saved"
  | "reused"
  | "skipped"

export interface PlaylistItemStatus {
  state: PlaylistItemState
  progress: number
  /**
   * the height this row's file really came down at, once there is a file.
   *
   * absent until the run ends, and absent afterwards for a row whose name
   * carried none - an audio download has no resolution to report. a ceiling is
   * resolved per video, so this is the only place the answer ever appears.
   */
  height?: number
}

/** what a finished run says about the rows, beyond its counts */
export interface PlaylistRunOutcome {
  /** position -> delivered height, or null when the file named none */
  delivered?: Map<number, number | null>
  /** the positions the resume archive already held */
  reusedIndices?: number[]
}

/**
 * can this row be downloaded at all?
 *
 * two reasons it might not be. `unavailable` is a deleted or private video, and
 * each attempt at one spends one of yt-dlp's five allowed failures before it
 * gives up on the rest of the playlist. an absent id is the other: the id
 * travels with the selection and is what the resume archive is matched on, so
 * main refuses a request carrying a row without one.
 */
export const isSelectableEntry = (entry: PlaylistEntry): boolean =>
  !entry.unavailable && typeof entry.id === "string" && entry.id.length > 0

const selectableIndices = (info: PlaylistInfoResponse | null): Set<number> =>
  new Set(
    (info?.entries ?? []).filter(isSelectableEntry).map((entry) => entry.index)
  )

interface PlaylistState {
  /**
   * the link that produced the listing below, and only ever that.
   *
   * it is deliberately not the text in the search box: the box holds a draft
   * the user is still editing, and a draft paired with a loaded listing is how
   * one playlist's selection gets sent under another playlist's url. there is
   * no `setUrl` for the same reason - the pair is written by
   * `setLoadedPlaylist` or not at all.
   */
  url: string

  playlistInfo: PlaylistInfoResponse | null
  setLoadedPlaylist: (url: string, info: PlaylistInfoResponse) => void

  isLoadingPlaylistInfo: boolean
  setIsLoadingPlaylistInfo: (loading: boolean) => void

  /**
   * which lookup the state is allowed to come from.
   *
   * a listing takes a second or two to arrive, and in that time the user can
   * submit another link or clear the box. the token says which request is still
   * the current one: every other answer, however it turns out, is dropped
   * rather than written over the newer one.
   */
  lookupToken: number
  beginLookup: () => number
  isCurrentLookup: (token: number) => boolean

  // the ticked rows, by their true position in the playlist. the ids the
  // request also needs are joined on from `playlistInfo` when it is built, so
  // there is one copy of the listing and this cannot disagree with it
  selectedIndices: Set<number>
  toggleIndex: (index: number) => void
  selectAll: () => void
  selectNone: () => void

  // one quality instruction for the whole playlist, per tab
  selectedCeiling: number
  setSelectedCeiling: (height: number) => void
  selectedAudioMode: AudioMode
  setSelectedAudioMode: (mode: AudioMode) => void
  activeTab: PlaylistTab
  setActiveTab: (tab: PlaylistTab) => void

  // keyed by playlist position, which is what the progress events name
  itemStatus: Map<number, PlaylistItemStatus>
  setItemStatus: (index: number, status: PlaylistItemStatus) => void
  applyRunOutcome: (outcome: PlaylistRunOutcome) => void
  settleInFlightItems: (state: PlaylistItemState) => void
  clearItemStatus: () => void

  isDownloading: boolean
  setIsDownloading: (downloading: boolean) => void

  reset: () => void
}

// everything a new playlist replaces. the lookup token is deliberately not in
// here: it only ever counts up, so that clearing the view invalidates the
// lookups that were in flight when it was cleared rather than re-admitting them
const initialState = {
  url: "",
  playlistInfo: null,
  isLoadingPlaylistInfo: false,
  selectedIndices: new Set<number>(),
  selectedCeiling: PLAYLIST_DEFAULT_CEILING,
  // mp3 for the same reason the single-video store opens on it: it is the one
  // every device and every editor opens
  selectedAudioMode: "mp3" as AudioMode,
  activeTab: "video" as PlaylistTab,
  itemStatus: new Map<number, PlaylistItemStatus>(),
  isDownloading: false
}

export const usePlaylistStore = create<PlaylistState>((set, get) => ({
  ...initialState,
  lookupToken: 0,

  /**
   * a new listing is a new playlist, and the selection describes the old one.
   *
   * following the same reasoning as `youtubeStore.setVideoInfo`: position 3 in
   * this playlist is a different video from position 3 in the last one, and a
   * carried-over selection would download it with nothing on screen saying so.
   * the per-row badges go for the same reason - they describe a run that
   * happened against other videos.
   *
   * everything available starts ticked, which is what "download this playlist"
   * means; the rows that cannot be downloaded are the ones left out.
   *
   * **the url is written in the same `set` as the listing**, and there is no
   * way to write one without the other. main takes the link and the playlist id
   * as two separate fields and cross-checks neither, so a url that arrived here
   * ahead of its listing - a lookup that failed, or two that answered out of
   * order - would send one playlist's positions against another playlist's
   * link and file the result under the wrong resume archive.
   */
  setLoadedPlaylist: (url, info) => {
    const state = get()

    /**
     * ...and re-pasting the link already on screen is a refresh, not that.
     *
     * every lookup returns a fresh response object, so comparing objects says
     * "new playlist" for the same link every single time. the same url and the
     * same playlist id is the same playlist: position 3 is the same video it
     * was a moment ago, the ticks describe it, and a run may still be walking
     * it. both halves have to match, because main takes the link and the id as
     * two separate fields and cross-checks neither.
     *
     * the listing itself is still replaced - that is what a refresh is for -
     * and a row it now reports as unavailable drops out of the selection,
     * because the rule that a selection never holds one of those is absolute.
     * a row that was not there before is left unticked: what is preserved is
     * the choice the user made, not a new default applied behind them.
     */
    if (
      state.playlistInfo !== null &&
      state.url === url &&
      state.playlistInfo.playlist_id === info.playlist_id
    ) {
      const selectable = selectableIndices(info)

      set({
        url,
        playlistInfo: info,
        selectedIndices: new Set(
          [...state.selectedIndices].filter((index) => selectable.has(index))
        )
      })

      return
    }

    set({
      url,
      playlistInfo: info,
      selectedIndices: selectableIndices(info),
      itemStatus: new Map()
    })
  },

  setIsLoadingPlaylistInfo: (loading) => set({ isLoadingPlaylistInfo: loading }),

  beginLookup: () => {
    const token = get().lookupToken + 1
    set({ lookupToken: token })
    return token
  },

  isCurrentLookup: (token) => get().lookupToken === token,

  toggleIndex: (index) => {
    const { playlistInfo, selectedIndices } = get()
    const entry = playlistInfo?.entries.find((row) => row.index === index)

    // an unavailable row, or one this listing does not hold at all
    if (!entry || !isSelectableEntry(entry)) {
      return
    }

    const next = new Set(selectedIndices)

    if (next.has(index)) {
      next.delete(index)
    } else {
      next.add(index)
    }

    set({ selectedIndices: next })
  },

  selectAll: () => set({ selectedIndices: selectableIndices(get().playlistInfo) }),
  selectNone: () => set({ selectedIndices: new Set() }),

  setSelectedCeiling: (height) => set({ selectedCeiling: height }),
  setSelectedAudioMode: (mode) => set({ selectedAudioMode: mode }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  setItemStatus: (index, status) => {
    const next = new Map(get().itemStatus)
    next.set(index, status)
    set({ itemStatus: next })
  },

  /**
   * what the terminal event knows that no progress event could.
   *
   * two facts arrive only at the end, and both of them describe rows rather
   * than the run. the files it wrote name the video and the height it really
   * came down at, which is the answer to "up to 1080p" for that one video; and
   * the positions the archive already held are the only way to tell a video
   * the user already has from one the run never got to.
   *
   * a file wins over an archive record wherever they disagree: a file this run
   * put on disk is the stronger claim, and the archive only ever says that a
   * download once succeeded.
   */
  applyRunOutcome: ({ delivered, reusedIndices }) => {
    const next = new Map(get().itemStatus)
    let changed = false

    for (const index of reusedIndices ?? []) {
      next.set(index, { state: "reused", progress: 100 })
      changed = true
    }

    for (const [index, height] of delivered ?? []) {
      next.set(index, {
        state: "saved",
        progress: 100,
        ...(typeof height === "number" ? { height } : {})
      })
      changed = true
    }

    if (changed) {
      set({ itemStatus: next })
    }
  },

  /**
   * the run ended while a row was still in flight.
   *
   * only that row moves: a row already reported saved stays saved, and a row
   * the run never reached stays pending. what the run saved, reused and skipped
   * in total is reported by the terminal event's own counts, not by adding
   * these up.
   */
  settleInFlightItems: (state) => {
    const next = new Map(get().itemStatus)
    let changed = false

    for (const [index, status] of next) {
      if (status.state === "downloading") {
        next.set(index, { state, progress: status.progress })
        changed = true
      }
    }

    if (changed) {
      set({ itemStatus: next })
    }
  },

  clearItemStatus: () => set({ itemStatus: new Map() }),

  setIsDownloading: (downloading) => set({ isDownloading: downloading }),

  /**
   * clearing the view also abandons whatever lookup was in flight: the token
   * moves on, so a listing that arrives after Clear cannot repopulate the
   * screen the user just emptied.
   *
   * a question still on screen goes with it, for the same reason and one more.
   * it is about a link that is no longer in the box, so it has nothing left to
   * ask about; and while its answer could not write over the emptied screen
   * either way, it would still be remembered, and the next paste of that link
   * would silently follow a decision this reset threw away.
   */
  reset: () => {
    useMixedLinkStore.getState().dismiss()

    set({
      ...initialState,
      lookupToken: get().lookupToken + 1,
      selectedIndices: new Set<number>(),
      itemStatus: new Map<number, PlaylistItemStatus>()
    })
  }
}))
