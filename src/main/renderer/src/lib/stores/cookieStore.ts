import { create } from "zustand"

interface CookieState {
  isOpen: boolean
  open: () => void
  close: () => void
}

export const useCookieStore = create<CookieState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false })
}))

// convenience for non-React call sites (toast actions), the same escape hatch
// reportStore provides for the same reason
export const cookieActions = {
  open: () => useCookieStore.getState().open()
}
