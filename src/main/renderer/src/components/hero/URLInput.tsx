import { motion } from "framer-motion"
import { ChevronUp, Folder, Loader2, Send } from "lucide-react"
import { useEffect, useState } from "react"
import type { UseFormReturn } from "react-hook-form"

import { useDownloadPath } from "@/lib/hooks/useDownloadPath"
import {
  PLATFORM_LIST,
  PLATFORM_REGISTRY
} from "@/lib/platform-config"
import { useAppStore, type Platform } from "@/lib/store"
import { cn } from "@/lib/utils"

const MONO = 'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'

interface URLInputProps {
  form: UseFormReturn<{ url: string }>
  onFocusChange: (focused: boolean) => void
  isLoading: boolean
  platform: Platform
}

export function URLInput({ form, onFocusChange, isLoading, platform }: URLInputProps) {
  const { register, formState: { errors }, watch } = form
  const { selectFolder, isLoading: folderLoading } = useDownloadPath()
  const { selectedPlatform, setSelectedPlatform, setShowMediaDetails } = useAppStore()
  const [isOpen, setIsOpen] = useState(false)

  const config = PLATFORM_REGISTRY[platform]
  const currentPlatform = PLATFORM_LIST.find((p) => p.id === selectedPlatform) ?? PLATFORM_LIST[0]
  const urlValue = watch("url")
  const hasError = !!errors.url
  const hasValue = urlValue && urlValue.length > 0

  // switching platform resets every store, so a switch during an in-flight
  // fetch would clear the store its late resolve is about to write into
  useEffect(() => {
    if (isLoading) setIsOpen(false)
  }, [isLoading])

  const handleToggle = () => {
    if (isLoading) return
    setIsOpen((o) => !o)
  }

  const handlePlatformSelect = (p: Platform) => {
    if (isLoading) return

    if (p !== selectedPlatform) {
      setSelectedPlatform(p)
      Object.values(PLATFORM_REGISTRY).forEach((cfg) => cfg.store.reset())
      setShowMediaDetails(false)
    }
    setIsOpen(false)
  }

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">
      {/* main input container */}
      <div
        className={cn(
          "relative border transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
          isOpen ? "rounded-3xl" : "rounded-2xl",
          "dark:bg-slate-800/60 dark:border-slate-700/60 dark:backdrop-blur-sm",
          "dark:focus-within:border-slate-600/70 dark:hover:border-slate-600/70",
          "bg-white/90 border-slate-200/60 backdrop-blur-sm",
          "focus-within:border-slate-300/80 hover:border-slate-300/80",
          hasError && "border-red-500/60 focus-within:border-red-500/60",
          isLoading && "cursor-not-allowed opacity-70"
        )}
      >
        {/* url input area */}
        <div className="px-4 py-4">
          <input
            {...register("url")}
            type="text"
            placeholder={config.placeholder}
            disabled={isLoading}
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
            className={cn(
              "w-full text-sm bg-transparent border-0 outline-none transition-all duration-200 ease-out",
              "dark:text-white dark:placeholder:text-slate-500",
              "text-slate-900 placeholder:text-slate-500",
              isLoading && "cursor-not-allowed"
            )}
            style={{ fontFamily: MONO }}
          />
        </div>

        {/* action bar */}
        <div className="h-11 px-4 flex items-center justify-between">
          {/* folder selector */}
          <button
            type="button"
            onClick={selectFolder}
            disabled={folderLoading || isLoading}
            title="Select folder"
            className={cn(
              "w-7 h-7 rounded-lg border transition-all duration-200 ease-out",
              "flex items-center justify-center flex-shrink-0 bg-transparent",
              "dark:border-slate-600/40 dark:hover:border-slate-500/50 dark:text-slate-400 dark:hover:text-slate-300",
              "border-slate-200/60 hover:border-slate-300/70 text-slate-600 hover:text-slate-700",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "focus:outline-none"
            )}
          >
            {folderLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Folder className="w-4 h-4" />}
          </button>

          {/* right: platform picker + send */}
          <div className="flex items-center gap-2">

            {/* Platform dropdown */}
            <div
              data-testid="platform-picker"
              data-state={isOpen ? "open" : "closed"}
              className={cn(
                "select-none overflow-hidden",
                isLoading ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                "transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
                isOpen ? "rounded-2xl" : "rounded-xl",
                "border dark:border-slate-700/40 border-slate-200/50",
                "dark:bg-slate-800 bg-white"
              )}
              onClick={handleToggle}
            >
              {/* trigger row */}
              <div
                data-testid="platform-picker-trigger"
                aria-disabled={isLoading}
                title={isLoading ? "Wait for the current link to finish" : undefined}
                className="flex items-center gap-2 px-2.5 py-1.5"
              >
                <img
                  src={currentPlatform.logo}
                  alt={currentPlatform.label}
                  className="w-3.5 h-3.5 object-contain flex-shrink-0"
                />
                <span
                  className={cn(
                    "text-xs dark:text-slate-300 text-slate-600",
                    "transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
                    isOpen ? "opacity-0 max-w-0 overflow-hidden" : "opacity-100 max-w-[80px]"
                  )}
                  style={{ fontFamily: MONO }}
                >
                  {currentPlatform.label}
                </span>
                <ChevronUp
                  className={cn(
                    "w-3 h-3 dark:text-slate-400 text-slate-500",
                    "transition-transform duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
                    isOpen ? "rotate-0" : "rotate-180"
                  )}
                />
              </div>

              {/* expandable list */}
              <div
                className={cn(
                  "grid transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
                  isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                )}
              >
                <div className="overflow-hidden">
                  <div className="px-1.5 pb-1.5 space-y-0.5">
                    {PLATFORM_LIST.map((p, index) => (
                      <div
                        key={p.id}
                        onClick={(e) => { e.stopPropagation(); handlePlatformSelect(p.id) }}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer",
                          "transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
                          isOpen ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
                          p.id === selectedPlatform
                            ? "dark:bg-slate-700/80 bg-slate-100 dark:text-white text-slate-900"
                            : "dark:text-slate-400 text-slate-500 dark:hover:bg-slate-700/50 hover:bg-slate-50"
                        )}
                        style={{
                          transitionDelay: isOpen ? `${index * 75}ms` : "0ms",
                          fontFamily: MONO
                        }}
                      >
                        <img
                          src={p.logo}
                          alt={p.label}
                          className="w-3.5 h-3.5 object-contain flex-shrink-0"
                        />
                        <span className="text-xs">{p.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* submit button */}
            <button
              type="submit"
              disabled={isLoading || !hasValue || hasError}
              className={cn(
                "w-7 h-7 rounded-lg transition-colors duration-200 ease-out",
                "flex items-center justify-center flex-shrink-0",
                "bg-slate-900 hover:bg-slate-800 text-white",
                "dark:bg-slate-100 dark:hover:bg-slate-200 dark:text-slate-900",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "focus:outline-none"
              )}
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Error message */}
      {hasError && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="px-4"
        >
          <p className="text-sm text-red-600 dark:text-red-400 font-medium" style={{ fontFamily: MONO }}>
            {errors.url?.message}
          </p>
        </motion.div>
      )}

      {/* Helper / loading text */}
      {!hasError && (
        <div className="px-4 mt-10 flex justify-center">
          {isLoading ? (
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-sm text-slate-700 dark:text-slate-300 text-center tracking-wide"
              style={{ fontFamily: MONO }}
            >
              {config.loadingText}
              <motion.span
                animate={{ opacity: [0, 1, 0] }}
                transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                className="ml-1"
              >
                ...
              </motion.span>
            </motion.p>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-500 text-center" style={{ fontFamily: MONO }}>
              {config.helperText}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
