import { CompactPicker } from "@/components/ui/compact-picker"
import { motion } from "framer-motion"
import { Folder, Loader2, Send } from "lucide-react"
import type { UseFormReturn } from "react-hook-form"

import { track } from "@/lib/analytics"
import { MONO } from "@/lib/fonts"
import { useDownloadPath } from "@/lib/hooks/useDownloadPath"
import { useT, type Key } from "@/lib/i18n"
import { PLATFORM_LIST, PLATFORM_REGISTRY } from "@/lib/platform-config"
import { DEMO_PLAYLIST_URL } from "@/lib/playlistView"
import { useAppStore, type Platform } from "@/lib/stores/store"
import { cn } from "@/lib/utils"

interface URLInputProps {
  form: UseFormReturn<{ url: string }>
  onFocusChange: (focused: boolean) => void
  isLoading: boolean
  platform: Platform
}

export function URLInput({
  form,
  onFocusChange,
  isLoading,
  platform
}: URLInputProps) {
  const {
    register,
    formState: { errors },
    watch,
    setValue,
    setFocus
  } = form
  const t = useT()
  const { selectFolder, isLoading: folderLoading } = useDownloadPath()
  const { selectedPlatform, setSelectedPlatform, setShowMediaDetails } =
    useAppStore()

  const config = PLATFORM_REGISTRY[platform]
  const urlValue = watch("url")
  const hasError = !!errors.url
  const hasValue = urlValue && urlValue.length > 0

  const handlePlatformSelect = (p: Platform) => {
    if (isLoading) return

    if (p !== selectedPlatform) {
      setSelectedPlatform(p)
      Object.values(PLATFORM_REGISTRY).forEach((cfg) => cfg.store.reset())
      setShowMediaDetails(false)
    }
  }

  /**
   * hand somebody a playlist instead of only telling them playlists work
   *
   * the box is filled and focused and nothing is submitted: the user presses
   * Enter, which is the habit the box is already built around, and until they
   * do the link is sitting there to be read rather than a lookup somebody's
   * click spent for them.
   *
   * shouldValidate because the send button is disabled off the form's error
   * state, and a value written past the resolver would leave it disabled with a
   * perfectly good link in the box.
   */
  const fillWithDemoPlaylist = () => {
    setValue("url", DEMO_PLAYLIST_URL, {
      shouldDirty: true,
      shouldValidate: true
    })
    setFocus("url")

    // which platform, and nothing else: the link is ours, so there is nothing
    // here to report about what the user pasted
    track("playlist_hint_clicked", { platform: "youtube" })
  }

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">
      {/* main input container */}
      <div
        className={cn(
          "relative border transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
          "rounded-2xl has-[[aria-expanded=true]]:rounded-3xl",
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
            placeholder={t(config.placeholder)}
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
            title={t("url.selectFolder")}
            className={cn(
              "w-7 h-7 rounded-lg border transition-all duration-200 ease-out",
              "flex items-center justify-center flex-shrink-0 bg-transparent",
              "dark:border-slate-600/40 dark:hover:border-slate-500/50 dark:text-slate-400 dark:hover:text-slate-300",
              "border-slate-200/60 hover:border-slate-300/70 text-slate-600 hover:text-slate-700",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "focus:outline-none"
            )}
          >
            {folderLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Folder className="w-4 h-4" />
            )}
          </button>

          {/* right: platform picker + send */}
          <div className="flex items-center gap-2">
            <CompactPicker
              label={t("url.platform")}
              value={selectedPlatform}
              options={PLATFORM_LIST.map(p => ({ value: p.id, label: p.label, logo: p.logo }))}
              disabled={isLoading}
              title={isLoading ? t("url.pickerBusy") : undefined}
              onSelect={handlePlatformSelect}
            />

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
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
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
          <p
            className="text-sm text-red-600 dark:text-red-400 font-medium"
            style={{ fontFamily: MONO }}
          >
            {/* the form carries a translation key, put there by zod's schema
                or by the search hook */}
            {errors.url?.message && t(errors.url.message as Key)}
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
              {t(config.loadingText)}
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
          ) : (
            <p
              className="text-sm text-slate-600 dark:text-slate-500 text-center"
              style={{ fontFamily: MONO }}
            >
              {t(config.helperText)}
              {/* only youtube's line ends in a link, because youtube is the
                  only platform here with playlists to offer. the word keeps
                  the sentence's size and font and takes the palette's inline
                  link colours, so it reads as clickable mid-sentence rather
                  than as emphasis */}
              {platform === "youtube" && (
                <>
                  <button
                    type="button"
                    onClick={fillWithDemoPlaylist}
                    className={cn(
                      "text-cyan-600 dark:text-cyan-400 underline underline-offset-4",
                      "transition-colors duration-200",
                      "hover:text-cyan-500 dark:hover:text-cyan-300",
                      // the browser's default outline is dropped for the mouse
                      // and replaced for the keyboard: a tab stop with no ring
                      // is a link a keyboard user cannot find
                      "focus:outline-none rounded-sm",
                      "focus-visible:ring-2 focus-visible:ring-cyan-500/50"
                    )}
                  >
                    {t("url.youtubeHelperPlaylists")}
                  </button>
                  {t("url.youtubeHelperRest")}
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
