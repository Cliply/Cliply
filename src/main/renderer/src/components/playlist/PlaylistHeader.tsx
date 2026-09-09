import type { PlaylistInfoResponse } from "@/lib/api"
import { countLine, totalDuration, type PlaylistPhase } from "@/lib/playlistView"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"

interface PlaylistHeaderProps {
  info: PlaylistInfoResponse
  phase: PlaylistPhase
  className?: string
}

/** what was pasted: the playlist, its channel, its size and its length */
export function PlaylistHeader({ info, phase, className }: PlaylistHeaderProps) {
  const meta = [info.uploader, countLine(info), totalDuration(info.entries)].filter(
    Boolean
  )

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className={cn(
        "w-full p-3 lg:p-4 rounded-xl border-2 transition-all duration-200",
        "dark:bg-slate-800/60 dark:border-slate-700/50 dark:backdrop-blur-sm",
        "bg-white/80 border-slate-300/50 backdrop-blur-sm",
        "shadow-xl shadow-black/10 font-space-grotesk",
        className
      )}
    >
      <div className="flex gap-3">
        {info.entries[0]?.thumbnail ? (
          <img
            src={info.entries[0].thumbnail}
            alt=""
            className="h-[59px] w-[104px] shrink-0 rounded-lg object-cover bg-slate-200 dark:bg-slate-700"
          />
        ) : (
          <div className="h-[59px] w-[104px] shrink-0 rounded-lg bg-gradient-to-br from-slate-500 to-slate-400 dark:from-slate-700 dark:to-slate-600" />
        )}

        <div className="min-w-0">
          <h1 className="text-base lg:text-lg font-medium text-slate-900 dark:text-white leading-tight line-clamp-2">
            {info.title}
          </h1>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
            {meta.join("  ·  ")}
          </p>
          {phase !== "picking" && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-500">
              Saved to ~/Downloads/Cliply
            </p>
          )}
        </div>
      </div>
    </motion.div>
  )
}
