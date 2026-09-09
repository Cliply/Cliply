import { ModeToggle } from "@/components/ui/mode-toggle"
import { CompactSearch } from "@/components/video/CompactSearch"
import { usePlaylistStore } from "@/lib/playlistStore"
import { motion } from "framer-motion"

/**
 * where a playlist link lands
 *
 * the header a playlist listing supports and nothing else yet: the picker, the
 * per-row badges and the quality menu are the next ticket's, and the state they
 * read is already here. `count` is the playlist's true size and `listed` is how
 * many rows we hold, which differ whenever a link holds more than the hundred
 * we list.
 */
export function PlaylistLayout() {
  const { playlistInfo, selectedIndices } = usePlaylistStore()

  if (!playlistInfo) return null

  const { title, uploader, count, listed, truncated } = playlistInfo

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 dark:from-slate-900 dark:via-slate-800 dark:to-slate-900 flex flex-col">
      <div className="flex-shrink-0 p-4 lg:p-6 border-b border-slate-200/50 dark:border-slate-700/50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex-1 max-w-2xl mx-auto">
            <CompactSearch />
          </div>
          <div className="flex-shrink-0">
            <ModeToggle />
          </div>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex-1 p-4 lg:p-6"
      >
        <div className="max-w-3xl mx-auto space-y-2">
          <h1 className="text-xl font-medium text-slate-800 dark:text-slate-100">
            {title}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 font-space-grotesk">
            {uploader} &nbsp;•&nbsp;{" "}
            {truncated && count !== null
              ? `first ${listed} of ${count} videos`
              : `${listed} ${listed === 1 ? "video" : "videos"}`}{" "}
            &nbsp;•&nbsp; {selectedIndices.size} selected
          </p>
        </div>
      </motion.div>
    </div>
  )
}
