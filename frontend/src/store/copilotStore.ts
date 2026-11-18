import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_LAYOUT, readCopilotLayout, type CopilotLayout } from '../lib/copilotWindow'

interface CopilotState {
  open: boolean
  layout: CopilotLayout
  setOpen: (open: boolean) => void
  toggle: () => void
  setLayout: (layout: CopilotLayout) => void
}

export const useCopilotStore = create<CopilotState>()(
  persist(
    (set) => ({
      open: false,
      layout: DEFAULT_LAYOUT,
      setOpen: (open) => set({ open }),
      toggle: () => set((state) => ({ open: !state.open })),
      setLayout: (layout) => set({ layout }),
    }),
    {
      name: 'cloudatlas-copilot',
      partialize: (state) => state.layout,
      merge: (saved, state) => ({ ...state, layout: readCopilotLayout(saved) }),
    },
  ),
)
