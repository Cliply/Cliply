import { extractVideoId } from "@/lib/api"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"

interface VideoPlayerFrameProps {
  url: string
  title?: string
  className?: string
}

export function VideoPlayerFrame({
  url,
  title,
  className
}: VideoPlayerFrameProps) {
  const videoId = extractVideoId(url)

  if (!videoId) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className={cn(
          "w-full p-6 rounded-2xl border-2 transition-all duration-200",
          // Dark mode styles
          "dark:bg-slate-800/60 dark:border-slate-700/50 dark:backdrop-blur-sm",
          // Light mode styles
          "bg-white/80 border-slate-300/50 backdrop-blur-sm",
          // Common styles
          "shadow-xl shadow-black/10",
          "font-space-grotesk",
          "aspect-video flex items-center justify-center",
          className
        )}
      >
        <p className="text-slate-500 dark:text-slate-400">Invalid video URL</p>
      </motion.div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className={cn(
        "w-full p-1 rounded-2xl border-2 transition-all duration-200",
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
      <div className="relative aspect-[16/10] overflow-hidden rounded-xl">
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
