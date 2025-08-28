import { motion } from "framer-motion"
import { Loader2, Send } from "lucide-react"
import type { UseFormReturn } from "react-hook-form"

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

  const urlValue = watch("url")
  const hasError = !!errors.url
  const hasValue = urlValue && urlValue.length > 0

  return (
    <div className="w-full space-y-4">
      {/* Input container */}
      <div className="relative">
        {/* Input field */}
        <input
          {...register("url")}
          type="text"
          placeholder="paste video url here..."
          disabled={isLoading}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          className={cn(
            "w-full h-20 px-8 pr-20 text-xl border-2 rounded-3xl font-mono transition-all duration-200 ease-out",
            // Dark mode styles
            "dark:bg-slate-800 dark:border-slate-700 dark:text-white dark:placeholder:text-slate-500",
            "dark:focus:bg-slate-700 dark:focus:border-slate-600 dark:hover:border-slate-600",
            // Light mode styles
            "bg-white border-slate-300 text-slate-900 placeholder:text-slate-500",
            "focus:bg-slate-50 focus:border-slate-400 hover:border-slate-400",
            // Common styles
            "focus:outline-none focus:ring-0 shadow-xl shadow-black/10",
            hasError && "border-red-500 focus:border-red-500",
            isLoading && "cursor-not-allowed opacity-70"
          )}
          style={{
            fontFamily:
              'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
          }}
        />

        {/* Send button */}
        <button
          type="submit"
          disabled={isLoading || !hasValue || hasError}
          className={cn(
            "absolute right-4 top-1/2 -translate-y-1/2",
            "w-12 h-12 rounded-2xl transition-all duration-200 ease-out",
            "flex items-center justify-center shadow-lg",
            // Dark mode styles
            "dark:bg-white dark:hover:bg-gray-100 dark:text-slate-800",
            // Light mode styles
            "bg-slate-900 hover:bg-slate-800 text-white",
            // Common styles
            "disabled:opacity-30 disabled:cursor-not-allowed",
            "focus:outline-none focus:ring-2 focus:ring-slate-400/50 focus:ring-offset-0"
          )}
        >
          {isLoading ? (
            <Loader2 className="w-6 h-6 animate-spin" />
          ) : (
            <Send className="w-6 h-6" />
          )}
        </button>
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
