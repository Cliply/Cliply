import { Button } from "@/components/ui/button"
import { systemApi } from "@/lib/api"
import { DISCORD_INVITE_URL, FEEDBACK_URL } from "@/lib/community"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { MessageSquare } from "lucide-react"

interface FeedbackCardProps {
  className?: string
}

export function FeedbackCard({ className }: FeedbackCardProps) {
  const t = useT()

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
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan-100 dark:bg-cyan-800">
            <MessageSquare aria-hidden="true" className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
          </div>
          <div>
            <h3 className="font-medium text-cyan-900 dark:text-cyan-100">
              {t("feedback.title")}
            </h3>
            <p className="text-sm text-cyan-700 dark:text-cyan-300">
              {t("feedback.subtitle")}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            asChild
            size="sm"
            className="bg-cyan-600 text-sm font-medium text-white hover:bg-cyan-700"
          >
            <a
              href={DISCORD_INVITE_URL}
              onClick={(event) => {
                event.preventDefault()
                void systemApi.openExternal(DISCORD_INVITE_URL)
              }}
            >
              {t("feedback.cta")}
            </a>
          </Button>
          <a
            href={FEEDBACK_URL}
            onClick={(event) => {
              event.preventDefault()
              void systemApi.openExternal(FEEDBACK_URL)
            }}
            className="rounded-sm text-xs text-cyan-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-500 dark:text-cyan-300"
          >
            {t("feedback.alternative")}
          </a>
        </div>
      </div>
    </motion.div>
  )
}
