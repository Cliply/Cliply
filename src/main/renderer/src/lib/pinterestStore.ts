import type { PinterestVideoInfoResponse } from "@/lib/api"
import { createMediaStore } from "@/lib/createMediaStore"

export const usePinterestStore = createMediaStore<PinterestVideoInfoResponse>()
