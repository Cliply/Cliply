import { create } from "zustand"
import type { ReportContext } from "@/lib/report"

interface ReportState {
  context: ReportContext | null
  isOpen: boolean
  stage: (context: ReportContext) => void
  open: () => void
  close: () => void
}

export const useReportStore = create<ReportState>((set) => ({
  context: null,
  isOpen: false,
  stage: (context) => set({ context }),
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false })
}))

// convenience for non-React call sites (toast actions)
export const reportActions = {
  stage: (context: ReportContext) => useReportStore.getState().stage(context),
  open: () => useReportStore.getState().open()
}
