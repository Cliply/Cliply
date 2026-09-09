import { z } from "zod"

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
/**
 * a link to a playlist rather than to a video in one.
 *
 * `youtube.com/playlist?list=…` is none of the five shapes YOUTUBE_URL_REGEX
 * accepts, so until now the input refused it before anything could ask what it
 * held. the host is anchored for the reason PINTEREST_URL_REGEX spells out
 * above - the interesting part of a hostname is where it ends - so any
 * subdomain is fine (`m.`, `music.`, `www.`) and `youtube.com.evil.com` is
 * somebody else's domain: the literal `/playlist?` has to follow immediately.
 *
 * `list` is not required to be the first parameter, because the share sheet
 * puts its own `si=` in front of it.
 */
const PLAYLIST_URL_REGEX =
  /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*youtube\.com\/playlist\?(?:[^#]*&)?list=[\w-]+/i

/**
 * the video id inside a youtube link, with the host read as strictly as the
 * validators above read it. `extractVideoId` below is the older, laxer reader
 * that predates this and is left alone.
 */
const YOUTUBE_VIDEO_ID_REGEX =
  /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]+)/i

// the playlist a link names, wherever it sits in the query string
const YOUTUBE_LIST_ID_REGEX = /[?&]list=([\w-]+)/i

export const youtubeUrlSchema = z.object({
  url: z
    .string()
    .min(1, "Please enter a YouTube URL")
    .refine(
      (url: string) => YOUTUBE_URL_REGEX.test(url) || PLAYLIST_URL_REGEX.test(url),
      "Please enter a valid YouTube URL"
    )
})

export type YouTubeUrlFormData = z.infer<typeof youtubeUrlSchema>

// a youtube link of either kind: one video, or a playlist of them
export const isValidYouTubeUrl = (url: string): boolean => {
  return YOUTUBE_URL_REGEX.test(url) || PLAYLIST_URL_REGEX.test(url)
}

/**
 * is this link *only* a playlist?
 *
 * there is deliberately no `playlistUrlSchema` beside this. a schema in here
 * exists to be a form resolver, and a playlist has no form of its own: it is
 * pasted into the one youtube box, whose resolver is `youtubeUrlSchema` above -
 * widened to take both shapes, because which of the two a link is cannot be
 * known until it has been read. `detectYouTubeTarget` is what reads it.
 */
export const isValidYouTubePlaylistUrl = (url: string): boolean => {
  return PLAYLIST_URL_REGEX.test(url)
}

/**
 * a link main will accept, out of one the paste box accepted
 *
 * every validator above makes the protocol optional, because a link out of a
 * chat window often arrives without one. main does not: the engine's
 * `normalizeUrl` has always asked for an http(s) link, and the playlist
 * handlers refuse anything that does not parse as one. so it is put back on the
 * way out, which is what the single-video flow has always relied on happening.
 */
export const ensureHttpScheme = (url: string): string => {
  const trimmed = url.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export type YouTubeTargetKind = "video" | "playlist" | "both"

export interface YouTubeTarget {
  kind: YouTubeTargetKind
  videoId: string | null
  listId: string | null
}

/**
 * what a youtube link actually points at
 *
 * three answers, because a link can carry both: `watch?v=…&list=…` is what
 * youtube hands out from inside a playlist, and `youtu.be/ID?list=…` is the
 * same thing off the share sheet. **`both` is classified here and nothing
 * more.** what it means is not this function's to decide: Cliply used to take
 * the video out of such a link without asking, and now lists the playlist and
 * puts the two choices to the user, but either way the routing lives in
 * `useMediaSearch` and this only ever says what the link holds.
 *
 * a link that is not youtube's gets `video` with two nulls rather than an
 * answer about a `list=` parameter on somebody else's domain: the caller is
 * routing on this, and the video path is the one that has always taken it.
 */
export const detectYouTubeTarget = (url: string): YouTubeTarget => {
  const videoId = url.match(YOUTUBE_VIDEO_ID_REGEX)?.[1] ?? null
  const isYouTube = videoId !== null || PLAYLIST_URL_REGEX.test(url)
  const listId = isYouTube ? (url.match(YOUTUBE_LIST_ID_REGEX)?.[1] ?? null) : null

  if (videoId && listId) {
    return { kind: "both", videoId, listId }
  }

  if (listId) {
    return { kind: "playlist", videoId: null, listId }
  }

  return { kind: "video", videoId, listId: null }
}

export const pinterestUrlSchema = z.object({
  url: z
    .string()
    .min(1, "Please enter a Pinterest URL")
    .refine(
      (url: string) => PINTEREST_URL_REGEX.test(url),
      "Please enter a valid Pinterest URL"
    )
})

export type PinterestUrlFormData = z.infer<typeof pinterestUrlSchema>

export const isValidPinterestUrl = (url: string): boolean => {
  return PINTEREST_URL_REGEX.test(url)
}

export const tiktokUrlSchema = z.object({
  url: z
    .string()
    .min(1, "Please enter a TikTok URL")
    .refine(
      (url: string) => TIKTOK_URL_REGEX.test(url),
      "Please enter a valid TikTok URL"
    )
})

export type TikTokUrlFormData = z.infer<typeof tiktokUrlSchema>

export const isValidTikTokUrl = (url: string): boolean => {
  return TIKTOK_URL_REGEX.test(url)
}

export const detectPlatform = (
  url: string
): "youtube" | "pinterest" | "tiktok" | null => {
  if (YOUTUBE_URL_REGEX.test(url) || PLAYLIST_URL_REGEX.test(url)) {
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
