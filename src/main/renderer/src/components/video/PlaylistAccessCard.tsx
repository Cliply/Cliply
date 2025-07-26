import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Code, ExternalLink, List, Zap } from "lucide-react"

interface PlaylistAccessCardProps {
  className?: string
}

export function PlaylistAccessCard({ className }: PlaylistAccessCardProps) {
  const handleOpenApiDocs = () => {
    window.open("http://localhost:8888/docs", "_blank")
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "rounded-xl border-2 p-4 transition-all duration-200",
        // Cyan accent styling for API access
        "dark:bg-cyan-900/20 dark:border-cyan-700/50",
        "bg-cyan-50/80 border-cyan-300/50",
        // Common styles
        "backdrop-blur-sm shadow-lg",
        "font-space-grotesk",
        className
      )}
    >
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-100 dark:bg-cyan-800">
            <Code className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
          </div>
          <div>
            <h3 className="font-medium flex items-center gap-2 text-cyan-900 dark:text-cyan-100">
              Access the API
              <span className="text-xs px-1.5 py-0.5 rounded-md font-normal bg-cyan-100 text-cyan-700 dark:bg-cyan-800/50 dark:text-cyan-300">
                (beta)
              </span>
            </h3>
            <p className="text-sm text-cyan-700 dark:text-cyan-300">
              Programmatic access to playlist features
            </p>
          </div>
        </div>

        {/* Features */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <List className="h-4 w-4 flex-shrink-0 text-cyan-600 dark:text-cyan-400" />
            <span className="text-sm text-cyan-900 dark:text-cyan-100">
              Download playlists via API
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Zap className="h-4 w-4 flex-shrink-0 text-cyan-600 dark:text-cyan-400" />
            <span className="text-sm text-cyan-900 dark:text-cyan-100">
              Automate your workflows
            </span>
          </div>
        </div>

        {/* Action Button */}
        <Button
          onClick={handleOpenApiDocs}
          className={cn(
            "w-full h-10 text-sm font-medium transition-all duration-200",
            "bg-cyan-600 hover:bg-cyan-700 text-white"
          )}
        >
          <ExternalLink className="h-4 w-4 mr-2" />
          Open API Docs
        </Button>
      </div>
    </motion.div>
  )
}
