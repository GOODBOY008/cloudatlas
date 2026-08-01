import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const MIN_WIDTH = 320
export const MAX_WIDTH = 560
export const DEFAULT_COPILOT_WIDTH = 400

function clampWidth(w: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))
}

interface CopilotState {
  open: boolean
  width: number
  setOpen: (open: boolean) => void
  toggle: () => void
  setWidth: (width: number) => void
}

/** Global copilot panel state — any page can open the panel (spec §4.2). */
export const useCopilotStore = create<CopilotState>()(
  persist(
    (set) => ({
      open: false,
      width: DEFAULT_COPILOT_WIDTH,
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
      setWidth: (width) => set({ width: clampWidth(width) }),
    }),
    {
      name: 'cloudatlas-copilot',
      partialize: (state) => ({ width: state.width }),
    }
  )
)
