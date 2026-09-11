import type { TikTokVideoInfoResponse } from "@/lib/api"
import { createMediaStore } from "@/lib/stores/createMediaStore"

export const useTikTokStore = createMediaStore<TikTokVideoInfoResponse>()
