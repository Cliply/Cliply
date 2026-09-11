import type { PinterestVideoInfoResponse } from "@/lib/api"
import { createMediaStore } from "@/lib/stores/createMediaStore"

export const usePinterestStore = createMediaStore<PinterestVideoInfoResponse>()
