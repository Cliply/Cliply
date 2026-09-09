import { Button } from "@/components/ui/button"
import {
  ProgressBar,
  ProgressBarHeader,
  ProgressBarLabel,
  ProgressBarMeta,
  ProgressBarTrack,
  ProgressBarValue
} from "@/components/ui/progress-bar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AudioFormatDropdown } from "@/components/video/AudioFormatDropdown"
import type { usePlaylistDownload } from "@/lib/hooks/usePlaylistDownload"
import { usePlaylistStore } from "@/lib/playlistStore"
import { PLAYLIST_ABSENT, type PlaylistPhase } from "@/lib/playlistView"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { useState } from "react"
import { PlaylistCeilingDropdown } from "./PlaylistCeilingDropdown"
import { PlaylistSummary } from "./PlaylistSummary"

interface PlaylistDownloadCardProps {
  playlist: ReturnType<typeof usePlaylistDownload>
  phase: PlaylistPhase
  className?: string
}

export function PlaylistDownloadCard({
  playlist,
  phase,
  className
}: PlaylistDownloadCardProps) {
  const {
    activeTab,
    setActiveTab,
    selectedIndices,
    selectedAudioMode,
    setSelectedAudioMode
  } = usePlaylistStore()
  const [isQualityOpen, setIsQualityOpen] = useState(false)

  /**
   * deliberately no reset first.
   *
   * the hook replaces the whole download state on a successful start, so the
   * last run's counts cannot survive one - and a start it *refuses*, for a
   * selection it cannot send, leaves the previous summary standing, which is
   * the truthful thing to leave on screen when nothing new has begun.
   *
   * every terminal outcome, success or not, is reported by the hook's own
   * progress-event path: catching here is only so the rejection it settles
   * with is handled rather than thrown at the window.
   */
  const run = (options: { ignoreArchive?: boolean } = {}) => {
    playlist.mutateAsync(options).catch(() => {})
  }

  if (phase === "finished") {
    return (
      <PlaylistSummary
        state={playlist.downloadState}
        onRun={run}
        onRetry={(indices) => {
          const { selectNone, toggleIndex } = usePlaylistStore.getState()

          selectNone()
          for (const index of indices) toggleIndex(index)

          run()
        }}
        onPickAgain={() => {
          usePlaylistStore.getState().clearItemStatus()
          playlist.reset()
        }}
        className={className}
      />
    )
  }

  if (phase === "running") {
    return <PlaylistProgress playlist={playlist} className={className} />
  }

  const count = selectedIndices.size

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className={cn(
        "rounded-2xl border-2 transition-all duration-200",
        "dark:bg-slate-800/40 dark:border-slate-700/50 dark:backdrop-blur-sm",
        "bg-white/60 border-slate-300/50 backdrop-blur-sm",
        "shadow-xl font-space-grotesk",
        isQualityOpen && activeTab === "video" && "mb-80",
        className
      )}
    >
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as "video" | "audio")}
        className="w-full"
      >
        <div className="p-6 pb-0">
          <TabsList className="grid w-full grid-cols-2 bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200/50 dark:border-slate-700/50">
            <TabsTrigger
              value="video"
              className="flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:shadow-sm dark:data-[state=active]:bg-slate-700 dark:data-[state=active]:border-slate-600 transition-all duration-200"
            >
              🎬 Video
            </TabsTrigger>
            <TabsTrigger
              value="audio"
              className="flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:shadow-sm dark:data-[state=active]:bg-slate-700 dark:data-[state=active]:border-slate-600 transition-all duration-200"
            >
              🎵 Audio Only
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="video" className="p-6 pt-4 m-0">
          <div className="space-y-6">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              One quality for the whole playlist. Video and audio are merged
              automatically.
            </p>

            <PlaylistCeilingDropdown onOpenChange={setIsQualityOpen} />

            <Notes
              items={[
                PLAYLIST_ABSENT.container,
                PLAYLIST_ABSENT.dub,
                PLAYLIST_ABSENT.trim
              ]}
            />

            <DownloadButton
              count={count}
              label="videos"
              pending={playlist.isPending}
              onClick={() => run()}
            />
          </div>
        </TabsContent>

        <TabsContent value="audio" className="p-6 pt-4 m-0">
          <div className="space-y-6">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Take the audio from every video you picked, in one format.
            </p>

            <AudioFormatDropdown
              isVisible
              value={selectedAudioMode}
              onChange={setSelectedAudioMode}
            />

            <Notes items={[PLAYLIST_ABSENT.dub, PLAYLIST_ABSENT.trim]} />

            <DownloadButton
              count={count}
              label="tracks"
              pending={playlist.isPending}
              onClick={() => run()}
            />
          </div>
        </TabsContent>
      </Tabs>
    </motion.div>
  )
}

function Notes({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-500">
      {items.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  )
}

function DownloadButton({
  count,
  label,
  pending,
  onClick
}: {
  count: number
  label: "videos" | "tracks"
  pending: boolean
  onClick: () => void
}) {
  const noun = count === 1 ? label.slice(0, -1) : label

  return (
    <div className="space-y-2">
      <Button
        onClick={onClick}
        disabled={pending || count === 0}
        className={cn(
          "w-full h-12 text-base font-semibold rounded-xl transition-all duration-200",
          "bg-cyan-600 hover:bg-cyan-700 text-white border-2 border-cyan-600 hover:border-cyan-700",
          "disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
        )}
      >
        {count === 0 ? `Pick some ${label} first` : `Download ${count} ${noun}`}
      </Button>
    </div>
  )
}

/**
 * two bars, because a playlist has two things to be partway through
 *
 * the run's own bar answers "how much of this is left", and the item's answers
 * "why has nothing moved for a minute" for a large video in the middle of it.
 * one bar would have to pick one of those questions and drop the other.
 */
function PlaylistProgress({
  playlist,
  className
}: {
  playlist: ReturnType<typeof usePlaylistDownload>
  className?: string
}) {
  const { playlistInfo } = usePlaylistStore()
  const state = playlist.downloadState

  const total = state.itemsTotal ?? 0
  const current = state.itemIndex ?? (state.itemsCompleted ?? 0) + 1
  const currentTitle =
    playlistInfo?.entries.find((entry) => entry.index === state.playlistIndex)
      ?.title ?? ""

  const starting = state.status === "starting"

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn(
        "rounded-2xl border-2 p-5 space-y-5 font-space-grotesk",
        "dark:bg-slate-800/40 dark:border-slate-700/50 dark:backdrop-blur-sm",
        "bg-white/60 border-slate-300/50 backdrop-blur-sm shadow-xl",
        className
      )}
    >
      <ProgressBar value={state.progress} isIndeterminate={starting}>
        <ProgressBarHeader>
          <ProgressBarLabel>
            {starting || total === 0
              ? "Starting up"
              : `Video ${Math.min(current, total)} of ${total}`}
          </ProgressBarLabel>
          <ProgressBarValue />
        </ProgressBarHeader>
        <ProgressBarTrack />
        <ProgressBarMeta>{currentTitle}</ProgressBarMeta>
      </ProgressBar>

      <ProgressBar value={state.itemProgress ?? 0} isIndeterminate={starting}>
        <ProgressBarHeader>
          <ProgressBarLabel>This video</ProgressBarLabel>
          <ProgressBarValue />
        </ProgressBarHeader>
        <ProgressBarTrack />
        <ProgressBarMeta>
          {[state.speed, state.eta && `ETA ${state.eta}`]
            .filter(Boolean)
            .join("  ·  ")}
        </ProgressBarMeta>
      </ProgressBar>

      <div className="space-y-2">
        <Button
          variant="outline"
          onClick={playlist.cancelDownload}
          disabled={!state.downloadId}
          className="w-full"
        >
          Cancel remaining
        </Button>
        <p className="text-xs text-slate-500 dark:text-slate-500">
          Videos already saved are kept. Running it again skips them.
        </p>
      </div>
    </motion.div>
  )
}
