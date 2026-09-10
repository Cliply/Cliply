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
import { useT } from "@/lib/i18n"
import { usePlaylistStore } from "@/lib/playlistStore"
import { playlistAudioNote, type PlaylistPhase } from "@/lib/playlistView"
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
  const t = useT()
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
              🎬 {t("playlist.tabVideo")}
            </TabsTrigger>
            <TabsTrigger
              value="audio"
              className="flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:shadow-sm dark:data-[state=active]:bg-slate-700 dark:data-[state=active]:border-slate-600 transition-all duration-200"
            >
              🎵 {t("card.tabAudio")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="video" className="p-6 pt-4 m-0">
          <div className="space-y-6">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {t("playlist.videoIntro")}
            </p>

            {/* the one line about what a run does is the picker's own footer,
                where it can follow the ceiling that is actually selected */}
            <PlaylistCeilingDropdown onOpenChange={setIsQualityOpen} />

            <DownloadButton
              count={count}
              kind="videos"
              pending={playlist.isPending}
              onClick={() => run()}
            />
          </div>
        </TabsContent>

        <TabsContent value="audio" className="p-6 pt-4 m-0">
          <div className="space-y-6">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {t("playlist.audioIntro")}
            </p>

            <AudioFormatDropdown
              isVisible
              value={selectedAudioMode}
              onChange={setSelectedAudioMode}
            />

            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-500">
              {playlistAudioNote()}
            </p>

            <DownloadButton
              count={count}
              kind="tracks"
              pending={playlist.isPending}
              onClick={() => run()}
            />
          </div>
        </TabsContent>
      </Tabs>
    </motion.div>
  )
}

/**
 * the tab decides which noun is counted, and the dictionary declines it
 *
 * `kind` is what the tab downloads rather than the word for it: english takes
 * the plural off by dropping an s, and no other language does
 */
function DownloadButton({
  count,
  kind,
  pending,
  onClick
}: {
  count: number
  kind: "videos" | "tracks"
  pending: boolean
  onClick: () => void
}) {
  const t = useT()
  const videos = kind === "videos"

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
        {count === 0
          ? t(videos ? "playlist.pickVideosFirst" : "playlist.pickTracksFirst")
          : t(videos ? "playlist.downloadVideos" : "playlist.downloadTracks", {
              n: count
            })}
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
  const t = useT()
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
              ? t("progress.startingUp")
              : t("playlist.videoOf", {
                  current: Math.min(current, total),
                  total
                })}
          </ProgressBarLabel>
          <ProgressBarValue />
        </ProgressBarHeader>
        <ProgressBarTrack />
        <ProgressBarMeta>{currentTitle}</ProgressBarMeta>
      </ProgressBar>

      <ProgressBar value={state.itemProgress ?? 0} isIndeterminate={starting}>
        <ProgressBarHeader>
          <ProgressBarLabel>{t("playlist.thisVideo")}</ProgressBarLabel>
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
          {t("playlist.cancelRemaining")}
        </Button>
        <p className="text-xs text-slate-500 dark:text-slate-500">
          {t("playlist.cancelKeepsHint")}
        </p>
      </div>
    </motion.div>
  )
}
