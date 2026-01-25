import { create } from "zustand"

export type Platform = "youtube" | "pinterest"

interface GlobalState {
  selectedPlatform: Platform
  setSelectedPlatform: (platform: Platform) => void
  showMediaDetails: boolean
  setShowMediaDetails: (show: boolean) => void
}

export const useAppStore = create<GlobalState>((set) => ({
  selectedPlatform: "youtube",
  showMediaDetails: false,
  setSelectedPlatform: (platform) => set({ selectedPlatform: platform }),
  setShowMediaDetails: (show) => set({ showMediaDetails: show })
}))
