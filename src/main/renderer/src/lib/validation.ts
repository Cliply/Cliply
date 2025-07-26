import { z } from "zod"

// YouTube URL validation regex
const YOUTUBE_URL_REGEX =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)[\w-]+/

// Zod schema for YouTube URL validation
export const youtubeUrlSchema = z.object({
  url: z
    .string()
    .min(1, "Please enter a YouTube URL")
    .refine(
      (url: string) => YOUTUBE_URL_REGEX.test(url),
      "Please enter a valid YouTube URL"
    )
})

export type YouTubeUrlFormData = z.infer<typeof youtubeUrlSchema>

// Helper function to validate YouTube URL
export const isValidYouTubeUrl = (url: string): boolean => {
  return YOUTUBE_URL_REGEX.test(url)
}

// Helper function to extract video ID from YouTube URL
export const extractVideoId = (url: string): string | null => {
  const match = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/
  )
  return match ? match[1] : null
}
