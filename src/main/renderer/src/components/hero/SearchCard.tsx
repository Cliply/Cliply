import { zodResolver } from "@hookform/resolvers/zod"
import { motion } from "framer-motion"
import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"

import { pinterestApi, videoApi } from "@/lib/api"
import { useServerStatus } from "@/lib/hooks/useServerStatus"
import { useAppStore, type Platform } from "@/lib/store"
import { usePinterestStore } from "@/lib/pinterestStore"
import { useYouTubeStore } from "@/lib/youtubeStore"
import {
  showServerOverwhelmedToast,
  showServerStartingToast
} from "@/lib/toast-utils"
import {
  pinterestUrlSchema,
  type PinterestUrlFormData,
  youtubeUrlSchema,
  type YouTubeUrlFormData
} from "@/lib/validation"
import { URLInput } from "./URLInput"

interface SearchCardProps {
  platform: Platform
}

export function SearchCard({ platform }: SearchCardProps) {
  const { setShowMediaDetails } = useAppStore()
  const {
    url: youtubeUrl,
    setUrl: setYouTubeUrl,
    setVideoInfo,
    isLoadingVideoInfo,
    setIsLoadingVideoInfo
  } = useYouTubeStore()
  const {
    url: pinterestUrl,
    setUrl: setPinterestUrl,
    setPinInfo,
    isLoadingPinInfo,
    setIsLoadingPinInfo
  } = usePinterestStore()

  const serverStatus = useServerStatus()

  const schema = platform === "youtube" ? youtubeUrlSchema : pinterestUrlSchema

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

  const onSubmit = async (data: YouTubeUrlFormData | PinterestUrlFormData) => {
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

    try {
      if (isYouTube) {
        setIsLoadingVideoInfo(true)
        setYouTubeUrl(data.url)

        const videoInfo = await videoApi.getVideoInfo(data.url)

        // Update store with video info
        setVideoInfo(videoInfo)
        setShowMediaDetails(true)

        toast.success("Video information loaded successfully!")
      } else {
        setIsLoadingPinInfo(true)
        setPinterestUrl(data.url)

        const pinInfo = await pinterestApi.getInfo(data.url)

        setPinInfo(pinInfo)
        setShowMediaDetails(true)

        toast.success("Pin information loaded successfully!")
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : isYouTube
            ? "Failed to get video information"
            : "Failed to get pin information"

      // Handle different types of errors
      if (
        errorMessage.includes(
          isYouTube ? "Invalid YouTube URL" : "Invalid Pinterest URL"
        )
      ) {
        const message = isYouTube
          ? "Please enter a valid YouTube URL"
          : "Please enter a valid Pinterest URL"
        toast.error(message)
        form.setError("url", {
          message: isYouTube ? "Invalid YouTube URL" : "Invalid Pinterest URL"
        })
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
      } else if (errorMessage.includes("Server overwhelmed")) {
        showServerOverwhelmedToast()
      } else {
        toast.error(
          isYouTube ? "Failed to get video information" : "Failed to get pin information",
          {
            description: errorMessage
          }
        )
      }

      console.error(
        isYouTube ? "Video info request failed:" : "Pin info request failed:",
        error
      )
    } finally {
      if (isYouTube) {
        setIsLoadingVideoInfo(false)
      } else {
        setIsLoadingPinInfo(false)
      }
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
          isLoading={platform === "youtube" ? isLoadingVideoInfo : isLoadingPinInfo}
          platform={platform}
        />
      </form>
    </motion.div>
  )
}
