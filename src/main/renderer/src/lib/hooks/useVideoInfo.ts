import { videoApi } from "@/lib/api"
import { useQuery } from "@tanstack/react-query"

export const useVideoInfo = (url: string, enabled: boolean = false) => {
  return useQuery({
    queryKey: ["videoInfo", url],
    queryFn: () => videoApi.getVideoInfo(url),
    enabled: enabled && !!url,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: (failureCount, error) => {
      // don't spam retry on obvious errors
      if (
        error.message.includes("Invalid YouTube URL") ||
        error.message.includes("Video is unavailable") ||
        error.message.includes("bot detection")
      ) {
        return false
      }
      return failureCount < 2
    }
  })
}

export const useVideoInfoMutation = () => {
  return {
    mutateAsync: videoApi.getVideoInfo
  }
}
