import { motion } from "framer-motion"
import { Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MONO } from "@/lib/fonts"
import { useT } from "@/lib/i18n"
import { useActiveCount, useDownloadsStore } from "@/lib/stores/downloadsStore"
import { cn } from "@/lib/utils"

/**
 * the way into the downloads panel, beside the theme toggle on every screen
 *
 * it wears `ModeToggle`'s chrome down to the border and the blur, because the
 * two sit next to each other in all five headers and a second button drawn any
 * other way would read as belonging to something else.
 *
 * the badge counts what the user is still waiting on - queued, starting and
 * downloading - and is absent rather than a zero when there is nothing: a "0"
 * beside the icon is a number nobody needs and the first thing the eye lands
 * on. it is not hidden from assistive tech, so the count is part of the
 * button's name rather than something only sighted users get.
 */
export function DownloadsToggle() {
  const t = useT()
  const count = useActiveCount()
  const open = useDownloadsStore((state) => state.panelOpen)
  const setPanelOpen = useDownloadsStore((state) => state.setPanelOpen)

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setPanelOpen(!open)}
        aria-expanded={open}
        className={cn(
          "relative w-11 h-11 rounded-xl transition-all duration-200 border",
          "dark:bg-slate-800/60 dark:border-slate-700/50 dark:hover:bg-slate-700/70",
          "bg-white/80 border-slate-300/50 hover:bg-slate-100/80",
          "focus:outline-none focus:ring-2 focus:ring-slate-400/50 focus:ring-offset-0",
          "backdrop-blur-sm shadow-lg"
        )}
      >
        <Download className="h-5 w-5 text-slate-700 dark:text-slate-300" />
        <span className="sr-only">{t("downloads.toggle")}</span>

        {count > 0 && (
          <span
            style={{ fontFamily: MONO }}
            className={cn(
              "absolute -right-1 -top-1 flex h-[18px] min-w-[18px]",
              "items-center justify-center rounded-full px-1",
              "bg-cyan-600 text-[10px] leading-none tabular-nums text-white",
              "shadow-sm"
            )}
          >
            {count}
          </span>
        )}
      </Button>
    </motion.div>
  )
}
