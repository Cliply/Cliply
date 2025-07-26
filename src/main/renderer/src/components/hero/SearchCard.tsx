import { zodResolver } from "@hookform/resolvers/zod"
import { motion } from "framer-motion"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

import { videoApi } from "@/lib/api"
import { useServerStatus } from "@/lib/hooks/useServerStatus"
import { useAppStore } from "@/lib/store"
import {
  showServerOverwhelmedToast,
  showServerStartingToast
} from "@/lib/toast-utils"
import { youtubeUrlSchema, type YouTubeUrlFormData } from "@/lib/validation"
import { URLInput } from "./URLInput"

export function SearchCard() {
  const {
    url,
    setUrl,
    setVideoInfo,
    setShowVideoDetails,
    isLoadingVideoInfo,
    setIsLoadingVideoInfo
  } = useAppStore()

  const serverStatus = useServerStatus()

  const form = useForm<YouTubeUrlFormData>({
    resolver: zodResolver(youtubeUrlSchema),
    defaultValues: { url }
  })

  const onSubmit = async (data: YouTubeUrlFormData) => {
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

    try {
      setIsLoadingVideoInfo(true)
      setUrl(data.url)

      const videoInfo = await videoApi.getVideoInfo(data.url)

      // Update store with video info
      setVideoInfo(videoInfo)
      setShowVideoDetails(true)

      toast.success("Video information loaded successfully!")
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to get video information"

      // Handle different types of errors
      if (errorMessage.includes("Invalid YouTube URL")) {
        toast.error("Please enter a valid YouTube URL")
        form.setError("url", { message: "Invalid YouTube URL" })
      } else if (
        errorMessage.includes("Video unavailable") ||
        errorMessage.includes("not found")
      ) {
        toast.error("This video is not available for download")
      } else if (errorMessage.includes("Download engine starting")) {
        showServerStartingToast()
      } else if (errorMessage.includes("Server overwhelmed")) {
        showServerOverwhelmedToast()
      } else {
        toast.error("Failed to get video information", {
          description: errorMessage
        })
      }

      console.error("Video info request failed:", error)
    } finally {
      setIsLoadingVideoInfo(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="w-full max-w-4xl mx-auto px-4"
    >
      <form onSubmit={form.handleSubmit(onSubmit)} className="w-full">
        <URLInput
          form={form}
          onFocusChange={() => {}}
          isLoading={isLoadingVideoInfo}
        />
      </form>
    </motion.div>
  )
}
