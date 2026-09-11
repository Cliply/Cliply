import type { TikTokVideoInfoResponse } from "@/lib/api"
import { createMediaStore } from "@/lib/createMediaStore"

export const useTikTokStore = createMediaStore<TikTokVideoInfoResponse>()
