import { z } from "zod"

const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]+/

export const youtubeUrlSchema = z.object({
  url: z
    .string()
    .min(1, "Please enter a YouTube URL")
    .refine((url: string) => YOUTUBE_URL_REGEX.test(url), "Please enter a valid YouTube URL")
})

export type YouTubeUrlFormData = z.infer<typeof youtubeUrlSchema>

export const isValidYouTubeUrl = (url: string): boolean => {
  return YOUTUBE_URL_REGEX.test(url)
}

export const extractVideoId = (url: string): string | null => {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\n?#]+)/)
  return match ? match[1] : null
}
