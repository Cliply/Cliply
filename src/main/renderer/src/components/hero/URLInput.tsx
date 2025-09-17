import { motion } from "framer-motion"
import { Folder, Loader2, Send } from "lucide-react"
import type { UseFormReturn } from "react-hook-form"

import { useDownloadPath } from "@/lib/hooks/useDownloadPath"
import { cn } from "@/lib/utils"
import type { YouTubeUrlFormData } from "@/lib/validation"

interface URLInputProps {
  form: UseFormReturn<YouTubeUrlFormData>
  onFocusChange: (focused: boolean) => void
  isLoading: boolean
}

export function URLInput({ form, onFocusChange, isLoading }: URLInputProps) {
  const {
    register,
    formState: { errors },
    watch
  } = form

  const { selectFolder, isLoading: folderLoading, serverReady } = useDownloadPath()

  const urlValue = watch("url")
  const hasError = !!errors.url
  const hasValue = urlValue && urlValue.length > 0


  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">
      {/* main input container */}
      <div className={cn(
        "relative border rounded-2xl transition-all duration-200 ease-out overflow-hidden",
        // Dark mode styles matching Claude
        "dark:bg-slate-800/60 dark:border-slate-700/60 dark:backdrop-blur-sm",
        "dark:focus-within:border-slate-600/70 dark:hover:border-slate-600/70",
        // Light mode styles matching Claude
        "bg-white/90 border-slate-200/60 backdrop-blur-sm",
        "focus-within:border-slate-300/80 hover:border-slate-300/80",
        // Error states
        hasError && "border-red-500/60 focus-within:border-red-500/60",
        isLoading && "cursor-not-allowed opacity-70"
      )}>
        {/* url input area */}
        <div className="px-4 py-4">
          <input
            {...register("url")}
            type="text"
            placeholder="paste video url here..."
            disabled={isLoading}
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
            className={cn(
              "w-full text-sm bg-transparent border-0 outline-none transition-all duration-200 ease-out font-mono",
              // Dark mode styles
              "dark:text-white dark:placeholder:text-slate-500",
              // Light mode styles  
              "text-slate-900 placeholder:text-slate-500",
              isLoading && "cursor-not-allowed"
            )}
            style={{
              fontFamily:
                'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
            }}
          />
        </div>

        {/* action buttons */}
        <div className="h-11 px-4 flex items-center justify-between">
          {/* folder selector */}
          <button
            type="button"
            onClick={selectFolder}
            disabled={!serverReady || folderLoading || isLoading}
            title="Select folder"
            className={cn(
              "w-7 h-7 rounded-lg border transition-all duration-200 ease-out",
              "flex items-center justify-center flex-shrink-0 bg-transparent",
              // Dark mode styles - transparent with sleek border only
              "dark:border-slate-600/40 dark:hover:border-slate-500/50 dark:text-slate-400 dark:hover:text-slate-300",
              // Light mode styles - transparent with sleek border only
              "border-slate-200/60 hover:border-slate-300/70 text-slate-600 hover:text-slate-700",
              // Common styles
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "focus:outline-none focus:ring-1 focus:ring-slate-300/30"
            )}
          >
            {folderLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Folder className="w-4 h-4" />
            )}
          </button>

          {/* submit button */}
          <button
            type="submit"
            disabled={isLoading || !hasValue || hasError}
            className={cn(
              "w-7 h-7 rounded-lg transition-colors duration-200 ease-out",
              "flex items-center justify-center flex-shrink-0",
              // Original send button styling
              "bg-slate-900 hover:bg-slate-800 text-white",
              "dark:bg-slate-100 dark:hover:bg-slate-200 dark:text-slate-900",
              // Common styles
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 dark:focus:ring-offset-slate-900"
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

      {/* Error message */}
      {hasError && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          transition={{ duration: 0.2 }}
          className="px-4"
        >
          <p className="text-sm text-red-600 dark:text-red-400 font-medium">
            {errors.url?.message}
          </p>
        </motion.div>
      )}

      {/* Helper text or loading message */}
      {!hasError && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="px-4 mt-6"
        >
          {isLoading ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="flex justify-center"
            >
              {/* Loading Text with whale emoji only */}
              <motion.p
                className="text-sm text-slate-700 dark:text-slate-300 font-mono text-center tracking-wide"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2, duration: 0.4 }}
                style={{
                  fontFamily:
                    'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
                }}
              >
                🐋 getting video information
                <motion.span
                  animate={{ opacity: [0, 1, 0] }}
                  transition={{
                    duration: 1,
                    repeat: Infinity,
                    ease: "easeInOut"
                  }}
                  className="ml-1"
                >
                  ...
                </motion.span>
              </motion.p>
            </motion.div>
          ) : (
            <p
              className="text-sm text-slate-600 dark:text-slate-500 font-mono text-center"
              style={{
                fontFamily:
                  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
              }}
            >
              supports youtube <span className="text-cyan-500">videos</span> & <span className="text-cyan-500">shorts</span> from youtube.com and youtu.be
            </p>
          )}
        </motion.div>
      )}
    </div>
  )
}
