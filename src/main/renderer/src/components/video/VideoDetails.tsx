import type { VideoInfoResponse } from "@/lib/api"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Clock, User } from "lucide-react"

interface VideoDetailsProps {
  videoInfo: VideoInfoResponse
  className?: string
}

export function VideoDetails({ videoInfo, className }: VideoDetailsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className={cn("space-y-6", className)}
    >
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-white leading-tight">
          {videoInfo.title}
        </h1>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400">
          <User className="h-5 w-5 text-slate-500 dark:text-slate-500" />
          <span className="font-medium">{videoInfo.uploader}</span>
        </div>

        <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400">
          <Clock className="h-5 w-5 text-slate-500 dark:text-slate-500" />
          <span>{videoInfo.duration_string}</span>
        </div>
      </div>

      {videoInfo.thumbnail && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.4 }}
          className="rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800"
        >
          <img
            src={videoInfo.thumbnail}
            alt={`Thumbnail for ${videoInfo.title}`}
            className="w-full h-auto object-cover"
            loading="lazy"
          />
        </motion.div>
      )}

      <div className="border-t border-slate-200 dark:border-slate-700" />
    </motion.div>
  )
}
