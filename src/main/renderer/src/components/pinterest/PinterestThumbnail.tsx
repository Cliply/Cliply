import { systemApi } from "@/lib/api"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { ExternalLink } from "lucide-react"
import { toast } from "sonner"

interface PinterestThumbnailProps {
  thumbnailUrl: string | null
  pinUrl: string
  title: string
  className?: string
}

export function PinterestThumbnail({
  thumbnailUrl,
  pinUrl,
  title,
  className
}: PinterestThumbnailProps) {
  const handleOpenPin = async () => {
    try {
      await systemApi.openExternal(pinUrl)
    } catch (error) {
      console.error("Failed to open Pinterest link:", error)
      toast.error("Could not open Pinterest link")
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className={cn(
        "w-full p-1 rounded-2xl border-2 transition-all duration-200",
        "dark:bg-slate-800/60 dark:border-slate-700/50 dark:backdrop-blur-sm",
        "bg-white/80 border-slate-300/50 backdrop-blur-sm",
        "shadow-xl shadow-black/10 font-space-grotesk",
        className
      )}
    >
      <div className="relative overflow-hidden rounded-xl aspect-[4/5] bg-slate-100/60 dark:bg-slate-900/40">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={title}
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Thumbnail unavailable
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={handleOpenPin}
          className={cn(
            "absolute left-3 right-3 bottom-3 inline-flex items-center justify-center gap-2",
            "rounded-lg px-3 py-2 text-xs font-medium transition-all duration-200",
            "bg-slate-900/90 text-white hover:bg-slate-900",
            "dark:bg-white/90 dark:text-slate-900 dark:hover:bg-white"
          )}
        >
          <ExternalLink className="h-4 w-4" />
          View on Pinterest
        </button>
      </div>
    </motion.div>
  )
}
