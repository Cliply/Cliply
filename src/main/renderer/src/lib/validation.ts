import { z } from "zod"

import type { Key } from "@/lib/i18n"

/**
 * zod bakes a message into the schema when the schema is built, which is once,
 * at module load. so the message a schema carries is a translation key, and
 * whoever renders or toasts it calls `t()` on it then.
 */

const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[\w-]+/
/**
 * pinterest sends people to their own country's domain, so `www.pinterest.com`
 * is the shape in the documentation rather than the shape in a clipboard -
 * `ru.pinterest.com`, `in.pinterest.com` and `pinterest.co.uk` are all the same
 * pin, and all of them used to be refused here. the protocol is optional for
 * the same reason it already is for youtube: a link pasted out of a chat window
 * often arrives without one.
 *
 * the host is deliberately not `pinterest\.[\w.]+`. that would also accept
 * `pinterest.com.evil.com`, because the interesting part of a hostname is its
 * end, not whether our word appears somewhere in it. so: any subdomains, then
 * a literal `pinterest.`, then a tld with at most one country suffix after it,
 * and then `/pin/` immediately - nothing may sit between the tld and the path.
 */
const PINTEREST_URL_REGEX =
  /^(?:https?:\/\/)?(?:(?:[a-z0-9-]+\.)*pinterest\.[a-z]{2,3}(?:\.[a-z]{2})?\/pin\/[\w-]+|pin\.it\/[\w-]+)/i
const TIKTOK_URL_REGEX = /^https?:\/\/(?:(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+|vm\.tiktok\.com\/[\w-]+|vt\.tiktok\.com\/[\w-]+|(?:www\.)?tiktok\.com\/t\/[\w-]+|(?:www\.)?tiktok\.com\/embed\/\d+)/

export const youtubeUrlSchema = z.object({
  url: z
    .string()
    .min(1, "validation.youtubeRequired" satisfies Key)
    .refine(
      (url: string) => YOUTUBE_URL_REGEX.test(url),
      "validation.youtubeInvalid" satisfies Key
    )
})

export type YouTubeUrlFormData = z.infer<typeof youtubeUrlSchema>

export const isValidYouTubeUrl = (url: string): boolean => {
  return YOUTUBE_URL_REGEX.test(url)
}

export const pinterestUrlSchema = z.object({
  url: z
    .string()
    .min(1, "validation.pinterestRequired" satisfies Key)
    .refine(
      (url: string) => PINTEREST_URL_REGEX.test(url),
      "validation.pinterestInvalid" satisfies Key
    )
})

export type PinterestUrlFormData = z.infer<typeof pinterestUrlSchema>

export const isValidPinterestUrl = (url: string): boolean => {
  return PINTEREST_URL_REGEX.test(url)
}

export const tiktokUrlSchema = z.object({
  url: z
    .string()
    .min(1, "validation.tiktokRequired" satisfies Key)
    .refine(
      (url: string) => TIKTOK_URL_REGEX.test(url),
      "validation.tiktokInvalid" satisfies Key
    )
})

export type TikTokUrlFormData = z.infer<typeof tiktokUrlSchema>

export const isValidTikTokUrl = (url: string): boolean => {
  return TIKTOK_URL_REGEX.test(url)
}

export const detectPlatform = (
  url: string
): "youtube" | "pinterest" | "tiktok" | null => {
  if (YOUTUBE_URL_REGEX.test(url)) {
    return "youtube"
  }
  if (PINTEREST_URL_REGEX.test(url)) {
    return "pinterest"
  }
  if (TIKTOK_URL_REGEX.test(url)) {
    return "tiktok"
  }
  return null
}

export const extractVideoId = (url: string): string | null => {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\n?#]+)/)
  return match ? match[1] : null
}
