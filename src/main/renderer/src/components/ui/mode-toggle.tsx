

import { motion } from "framer-motion"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ModeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <div className="w-11 h-11 rounded-xl bg-white/80 border border-slate-300/50 dark:bg-slate-800/60 dark:border-slate-700/50" />
    )
  }

  const isDark = theme === "dark"

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(isDark ? "light" : "dark")}
        className={cn(
          "w-11 h-11 rounded-xl transition-all duration-200 border",
          // Dark mode styles
          "dark:bg-slate-800/60 dark:border-slate-700/50 dark:hover:bg-slate-700/70",
          // Light mode styles
          "bg-white/80 border-slate-300/50 hover:bg-slate-100/80",
          // Common styles
          "focus:outline-none focus:ring-2 focus:ring-slate-400/50 focus:ring-offset-0",
          "backdrop-blur-sm shadow-lg"
        )}
      >
        <motion.div
          key={theme}
          initial={{ rotate: -90, opacity: 0 }}
          animate={{ rotate: 0, opacity: 1 }}
          exit={{ rotate: 90, opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {isDark ? (
            <Sun className="h-5 w-5 text-slate-700 dark:text-slate-300" />
          ) : (
            <Moon className="h-5 w-5 text-slate-700 dark:text-slate-300" />
          )}
        </motion.div>
        <span className="sr-only">Toggle theme</span>
      </Button>
    </motion.div>
  )
}
