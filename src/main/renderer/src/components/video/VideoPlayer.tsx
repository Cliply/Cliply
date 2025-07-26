

import { extractVideoId } from "@/lib/api"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"

interface VideoPlayerProps {
  url: string
  title?: string
  className?: string
}

export function VideoPlayer({ url, title, className }: VideoPlayerProps) {
  const videoId = extractVideoId(url)

  if (!videoId) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className={cn(
          "aspect-video w-full rounded-2xl bg-slate-100 dark:bg-slate-800",
          "flex items-center justify-center",
          className
        )}
      >
        <p className="text-slate-500 dark:text-slate-400">Invalid video URL</p>
      </motion.div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={cn("w-full", className)}
    >
      <div className="relative aspect-video overflow-hidden rounded-2xl shadow-2xl">
        <iframe
          src={`https://www.youtube.com/embed/${videoId}?rel=0&showinfo=0&modestbranding=1`}
          title={title || "YouTube video"}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
          loading="lazy"
        />
      </div>
    </motion.div>
  )
}
