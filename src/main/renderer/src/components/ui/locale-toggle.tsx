import { motion } from "framer-motion"

import { useLocale, type Locale } from "@/lib/i18n"
import { cn } from "@/lib/utils"

const MONO =
  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'

/**
 * two words rather than a flag or a globe: `en` and `ru` are the same two
 * letters in either language, so the control needs no label of its own and
 * nothing about it has to be translated.
 *
 * it wears the same chrome as ModeToggle because the two sit side by side.
 */
export function LocaleToggle() {
  const { locale, setLocale } = useLocale()

  const label = (code: Locale) => (
    <button
      type="button"
      onClick={() => setLocale(code)}
      aria-pressed={locale === code}
      className={cn(
        "text-sm transition-colors duration-200",
        // the colour alone says which locale is on, not which one the keyboard
        // is about to press, so the ring is the only focus signal there is.
        // rounded so it traces the label rather than boxing it
        "rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/50 focus-visible:ring-offset-0",
        locale === code
          ? "text-slate-700 dark:text-slate-300"
          : "text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-400"
      )}
    >
      {code}
    </button>
  )

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className={cn(
        "h-11 px-3.5 rounded-xl flex items-center gap-2 border",
        // Dark mode styles
        "dark:bg-slate-800/60 dark:border-slate-700/50",
        // Light mode styles
        "bg-white/80 border-slate-300/50",
        // Common styles
        "backdrop-blur-sm shadow-lg"
      )}
      style={{ fontFamily: MONO }}
    >
      {label("en")}
      <span className="text-sm text-slate-300 dark:text-slate-600">·</span>
      {label("ru")}
    </motion.div>
  )
}
