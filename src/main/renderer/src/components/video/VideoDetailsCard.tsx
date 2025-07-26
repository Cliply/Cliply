import type { VideoInfoResponse } from "@/lib/api"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Clock, User } from "lucide-react"

interface VideoDetailsCardProps {
  videoInfo: VideoInfoResponse
  className?: string
}

export function VideoDetailsCard({
  videoInfo,
  className
}: VideoDetailsCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn(
        "w-full p-3 lg:p-4 xl:p-3 rounded-xl border-2 transition-all duration-200",
        // Dark mode styles
        "dark:bg-slate-800/60 dark:border-slate-700/50 dark:backdrop-blur-sm",
        // Light mode styles
        "bg-white/80 border-slate-300/50 backdrop-blur-sm",
        // Common styles
        "shadow-xl shadow-black/10",
        "font-space-grotesk",
        className
      )}
    >
      {/* Video Title */}
      <div className="mb-2 xl:mb-2">
        <h1 className="text-base lg:text-lg xl:text-base font-medium text-slate-900 dark:text-white leading-tight line-clamp-2">
          {videoInfo.title}
        </h1>
      </div>

      {/* Video Meta Information */}
      <div className="space-y-1.5 xl:space-y-1">
        {/* Channel */}
        <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
          <User className="h-3.5 w-3.5 xl:h-3 xl:w-3 text-slate-500 dark:text-slate-500 flex-shrink-0" />
          <span className="text-xs xl:text-xs font-medium truncate">
            {videoInfo.uploader}
          </span>
        </div>

        {/* Duration */}
        <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
          <Clock className="h-3.5 w-3.5 xl:h-3 xl:w-3 text-slate-500 dark:text-slate-500 flex-shrink-0" />
          <span className="text-xs xl:text-xs font-medium">
            {videoInfo.duration_string}
          </span>
        </div>
      </div>
    </motion.div>
  )
}
