import { DownloadsToggle } from "@/components/downloads/DownloadsToggle"
import { ModeToggle } from "@/components/ui/mode-toggle"
import { CompactSearch } from "@/components/video/CompactSearch"
import { usePlaylistDownload } from "@/lib/hooks/usePlaylistDownload"
import { usePlaylistStore } from "@/lib/stores/playlistStore"
import { phaseOf } from "@/lib/playlistView"
import { useYouTubeStore } from "@/lib/stores/youtubeStore"
import { motion } from "framer-motion"
import { useEffect, useRef } from "react"
import { PlaylistDownloadCard } from "./PlaylistDownloadCard"
import { PlaylistHeader } from "./PlaylistHeader"
import { PlaylistList } from "./PlaylistList"

/**
 * where a playlist link lands
 *
 * the same two-column frame as `VideoLayout`, because it is the same screen
 * doing the same job: what was pasted on the left, what to do with it on the
 * right. the left column is a list rather than a player, since a playlist has
 * nothing to preview and eleven things to choose between.
 *
 * one download hook for the whole screen. it owns the run, and the phase it is
 * in is what decides whether the rows carry checkboxes or badges, so it cannot
 * live inside the card that only draws one of the three states.
 */
export function PlaylistLayout() {
  const { playlistInfo, url } = usePlaylistStore()
  const playlist = usePlaylistDownload()

  /**
   * a different playlist arrives without this screen ever unmounting.
   *
   * pasting another link replaces the listing in place, so nothing tears the
   * view down between the two, and the last run's outcome would otherwise be
   * the first thing the new playlist showed, over rows it says nothing about.
   * `reset` also drops the progress listener, so a run still going is left to
   * the engine and finishes on its own, which is what closing the view does.
   *
   * **which is why the comparison cannot be on the response object.** every
   * lookup returns a fresh one, so re-pasting the link already on screen would
   * detach a run the user is still watching: the bars would vanish, Cancel
   * would go with them, and the job would carry on unreachable. identity is
   * the link and the playlist id, the same pair the store refreshes in place.
   */
  const identity = playlistInfo
    ? `${playlistInfo.playlist_id ?? ""}\0${url}`
    : null
  const shownIdentity = useRef(identity)

  useEffect(() => {
    if (shownIdentity.current === identity) return

    shownIdentity.current = identity
    playlist.reset()
  }, [identity, playlist])

  if (!playlistInfo) return null

  const phase = phaseOf(playlist.downloadState.status)

  return (
    <div className="min-h-screen xl:h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 dark:from-slate-900 dark:via-slate-800 dark:to-slate-900 flex flex-col xl:overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 p-4 lg:p-6 border-b border-slate-200/50 dark:border-slate-700/50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-shrink-0">
            <span
              className="hidden lg:block text-lg font-light text-slate-700 dark:text-slate-300 tracking-tight cursor-pointer hover:text-slate-900 dark:hover:text-slate-100 transition-colors duration-300"
              onClick={() => {
                useYouTubeStore.getState().reset()
                usePlaylistStore.getState().reset()
              }}
              style={{
                fontFamily:
                  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
              }}
            >
              cliply
            </span>
          </div>

          <div className="flex-1 max-w-2xl mx-auto">
            <CompactSearch />
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <DownloadsToggle />
            <ModeToggle />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col xl:flex-row xl:overflow-hidden">
        {/* Left Column - the playlist itself */}
        <div className="w-full xl:w-2/3 flex flex-col p-3 lg:p-4 xl:overflow-hidden">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex-1 flex flex-col space-y-3 min-h-0 xl:overflow-hidden"
          >
            {/* the header keeps its own height and the list takes the rest:
                the scroll lives in the list at `xl`, not around the pair of
                them, so the rows run to the bottom of the window */}
            <PlaylistHeader
              info={playlistInfo}
              phase={phase}
              className="shrink-0"
            />
            <PlaylistList phase={phase} />
          </motion.div>
        </div>

        {/* Right Column - what to do with it */}
        <div className="w-full xl:w-1/3 border-t xl:border-t-0 xl:border-l border-slate-200/50 dark:border-slate-700/50 flex flex-col xl:overflow-hidden">
          <div className="flex-1 xl:overflow-y-auto">
            <div className="p-4 lg:p-6">
              <PlaylistDownloadCard playlist={playlist} phase={phase} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
