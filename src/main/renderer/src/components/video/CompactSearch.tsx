import { Button } from "@/components/ui/button"
import { useMediaSearch } from "@/lib/hooks/useMediaSearch"
import { useT, type Key } from "@/lib/i18n"
import type { Platform } from "@/lib/store"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Loader2, Search, Send, X } from "lucide-react"

interface CompactSearchProps {
  onSearch?: (url: string) => void
  isLoading?: boolean
  className?: string
  platform?: Platform
}

export function CompactSearch({
  onSearch,
  isLoading: externalLoading,
  className,
  platform = "youtube"
}: CompactSearchProps) {
  const {
    form,
    isLoading: storeLoading,
    onSubmit,
    handleClear
  } = useMediaSearch(platform, { onSearch })
  const t = useT()

  const isLoading = externalLoading || storeLoading

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn("w-full", "font-space-grotesk", className)}
    >
      <form onSubmit={form.handleSubmit(onSubmit)} className="relative">
        <div className="relative flex items-center">
          <Search className="absolute left-4 h-5 w-5 text-slate-600 dark:text-slate-500" />

          <input
            {...form.register("url")}
            type="text"
            placeholder={t("url.replacePlaceholder")}
            disabled={isLoading}
            className={cn(
              "w-full h-12 pl-12 pr-16 rounded-xl border transition-all duration-200",
              "dark:bg-slate-800/60 dark:border-slate-700/50 dark:text-white dark:placeholder:text-slate-500",
              "dark:focus:bg-slate-700/70 dark:focus:border-slate-600",
              "bg-white/80 border-slate-300/50 text-slate-900 placeholder:text-slate-500",
              "focus:bg-white focus:border-slate-400",
              "focus:outline-none backdrop-blur-sm",
              isLoading && "cursor-not-allowed opacity-50"
            )}
          />

          <div className="absolute right-2 flex items-center gap-1">
            {form.watch("url") && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClear}
                className="h-8 w-8 p-0 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                <X className="h-4 w-4" />
              </Button>
            )}

            <button
              type="submit"
              disabled={isLoading || !form.watch("url")}
              className={cn(
                "h-8 w-8 rounded-lg transition-all duration-200 ease-out",
                "flex items-center justify-center shadow-md",
                "dark:bg-white dark:hover:bg-gray-100 dark:text-slate-800",
                "bg-slate-900 hover:bg-slate-800 text-white",
                "disabled:opacity-30 disabled:cursor-not-allowed",
                "focus:outline-none focus:ring-2 focus:ring-slate-400/50"
              )}
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {form.formState.errors.url?.message && (
          <motion.p
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-2 text-sm text-red-600 dark:text-red-400"
          >
            {t(form.formState.errors.url.message as Key)}
          </motion.p>
        )}
      </form>
    </motion.div>
  )
}
