import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Heart, MessageSquare } from "lucide-react"

interface FeedbackCardProps {
  className?: string
}

export function FeedbackCard({ className }: FeedbackCardProps) {
  const handleFeedback = () => {
    // Open cliply.space/hey page
    window.open("https://cliply.space/hey", "_blank")
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "rounded-xl border-2 p-4 transition-all duration-200",
        // Dark mode styles with cyan accent - matching other components
        "dark:bg-cyan-900/20 dark:border-cyan-700/50",
        // Light mode styles with cyan accent - matching other components
        "bg-cyan-50/80 border-cyan-300/50",
        // Common styles
        "backdrop-blur-sm shadow-lg",
        "font-space-grotesk",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-100 dark:bg-cyan-800">
            <Heart className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
          </div>
          <div>
            <h3 className="font-medium text-cyan-900 dark:text-cyan-100">
              Help us improve
            </h3>
            <p className="text-sm text-cyan-700 dark:text-cyan-300">
              Request a feature
            </p>
          </div>
        </div>

        <Button
          onClick={handleFeedback}
          size="sm"
          className={cn(
            "text-sm font-medium transition-all duration-200",
            "bg-cyan-600 hover:bg-cyan-700 text-white"
          )}
        >
          <MessageSquare className="h-4 w-4 mr-01" />
          tap me :)
        </Button>
      </div>
    </motion.div>
  )
}
