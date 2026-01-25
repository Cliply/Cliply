import { Button } from "@/components/ui/button"
import { pinterestApi, videoApi } from "@/lib/api"
import { useServerStatus } from "@/lib/hooks/useServerStatus"
import { usePinterestStore } from "@/lib/pinterestStore"
import { useAppStore, type Platform } from "@/lib/store"
import { useYouTubeStore } from "@/lib/youtubeStore"
import {
  showServerOverwhelmedToast,
  showServerStartingToast
} from "@/lib/toast-utils"
import { cn } from "@/lib/utils"
import {
  pinterestUrlSchema,
  type PinterestUrlFormData,
  youtubeUrlSchema,
  type YouTubeUrlFormData
} from "@/lib/validation"
import { zodResolver } from "@hookform/resolvers/zod"
import { motion } from "framer-motion"
import { Loader2, Search, Send, X } from "lucide-react"
import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

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
  const { setShowMediaDetails } = useAppStore()
  const {
    url: youtubeUrl,
    setUrl: setYouTubeUrl,
    setVideoInfo,
    setIsLoadingVideoInfo,
    isLoadingVideoInfo,
    reset: resetYouTube
  } = useYouTubeStore()
  const {
    url: pinterestUrl,
    setUrl: setPinterestUrl,
    setPinInfo,
    setIsLoadingPinInfo,
    isLoadingPinInfo,
    reset: resetPinterest
  } = usePinterestStore()

  const serverStatus = useServerStatus()
  const isLoading =
    externalLoading ||
    (platform === "youtube" ? isLoadingVideoInfo : isLoadingPinInfo)

  const schema =
    platform === "youtube" ? youtubeUrlSchema : pinterestUrlSchema

  const form = useForm<YouTubeUrlFormData | PinterestUrlFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      url: platform === "youtube" ? youtubeUrl : pinterestUrl
    }
  })

  useEffect(() => {
    form.reset({
      url: platform === "youtube" ? youtubeUrl : pinterestUrl
    })
  }, [form, pinterestUrl, platform, youtubeUrl])

  const handleSubmit = async (
    data: YouTubeUrlFormData | PinterestUrlFormData
  ) => {
    // If an external onSearch handler is provided, use it
    if (onSearch) {
      onSearch(data.url)
      return
    }

    // Check server status before making request
    if (serverStatus.isStarting) {
      showServerStartingToast()
      return
    }

    if (!serverStatus.isReady && !serverStatus.isUnknown) {
      toast.error("Download engine not ready", {
        description: "Please wait for the download engine to start"
      })
      return
    }

    const isYouTube = platform === "youtube"

    // Otherwise, handle the search internally
    try {
      if (isYouTube) {
        setIsLoadingVideoInfo(true)
        setYouTubeUrl(data.url)

        const newVideoInfo = await videoApi.getVideoInfo(data.url)

        setVideoInfo(newVideoInfo)
        setShowMediaDetails(true)

        toast.success("Video information loaded!")
      } else {
        setIsLoadingPinInfo(true)
        setPinterestUrl(data.url)

        const newPinInfo = await pinterestApi.getInfo(data.url)

        setPinInfo(newPinInfo)
        setShowMediaDetails(true)

        toast.success("Pin information loaded!")
      }
    } catch (error) {
      // Handle different types of errors
      const errorMessage =
        error instanceof Error
          ? error.message
          : isYouTube
            ? "Failed to get video information"
            : "Failed to get pin information"

      if (
        errorMessage.includes(
          isYouTube ? "Invalid YouTube URL" : "Invalid Pinterest URL"
        )
      ) {
        toast.error(
          isYouTube
            ? "Please enter a valid YouTube URL"
            : "Please enter a valid Pinterest URL"
        )
      } else if (
        errorMessage.includes("Video unavailable") ||
        errorMessage.includes("Pin unavailable") ||
        errorMessage.includes("not found")
      ) {
        toast.error(
          isYouTube
            ? "This video is not available for download"
            : "This pin is not available for download"
        )
      } else if (errorMessage.includes("Download engine starting")) {
        showServerStartingToast()
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("fetch")
      ) {
        showServerOverwhelmedToast()
      } else {
        showServerOverwhelmedToast()
      }
    } finally {
      if (isYouTube) {
        setIsLoadingVideoInfo(false)
      } else {
        setIsLoadingPinInfo(false)
      }
    }
  }

  const handleClear = () => {
    form.reset({ url: "" })
    if (platform === "youtube") {
      resetYouTube()
    } else {
      resetPinterest()
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn("w-full", "font-space-grotesk", className)}
    >
      <form onSubmit={form.handleSubmit(handleSubmit)} className="relative">
        <div className="relative flex items-center">
          {/* Search Icon */}
          <Search className="absolute left-4 h-5 w-5 text-slate-600 dark:text-slate-500" />

          {/* Input Field */}
          <input
            {...form.register("url")}
            type="text"
            placeholder={
              platform === "youtube"
                ? "Enter new YouTube URL..."
                : "Enter new Pinterest URL..."
            }
            disabled={isLoading}
            className={cn(
              "w-full h-12 pl-12 pr-16 rounded-xl border transition-all duration-200",
              // Dark mode styles
              "dark:bg-slate-800/60 dark:border-slate-700/50 dark:text-white dark:placeholder:text-slate-500",
              "dark:focus:bg-slate-700/70 dark:focus:border-slate-600",
              // Light mode styles
              "bg-white/80 border-slate-300/50 text-slate-900 placeholder:text-slate-500",
              "focus:bg-white focus:border-slate-400",
              // Common styles
              "focus:outline-none backdrop-blur-sm",
              isLoading && "cursor-not-allowed opacity-50"
            )}
          />

          {/* action buttons */}
          <div className="absolute right-2 flex items-center gap-1">
            {/* clear button */}
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

            {/* submit button */}
            <button
              type="submit"
              disabled={isLoading || !form.watch("url")}
              className={cn(
                "h-8 w-8 rounded-lg transition-all duration-200 ease-out",
                "flex items-center justify-center shadow-md",
                // Dark mode styles
                "dark:bg-white dark:hover:bg-gray-100 dark:text-slate-800",
                // Light mode styles
                "bg-slate-900 hover:bg-slate-800 text-white",
                // Common styles
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

        {/* Error Message */}
        {form.formState.errors.url && (
          <motion.p
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-2 text-sm text-red-600 dark:text-red-400"
          >
            {form.formState.errors.url.message}
          </motion.p>
        )}
      </form>
    </motion.div>
  )
}
