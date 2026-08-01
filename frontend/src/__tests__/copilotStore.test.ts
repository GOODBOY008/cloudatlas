import { describe, it, expect, beforeEach } from 'vitest'
import {
  useCopilotStore,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_COPILOT_WIDTH,
} from '../store/copilotStore'

describe('copilotStore', () => {
  beforeEach(() => {
    useCopilotStore.getState().setOpen(false)
    useCopilotStore.getState().setWidth(DEFAULT_COPILOT_WIDTH)
  })

  it('toggles open state', () => {
    expect(useCopilotStore.getState().open).toBe(false)
    useCopilotStore.getState().toggle()
    expect(useCopilotStore.getState().open).toBe(true)
    useCopilotStore.getState().toggle()
    expect(useCopilotStore.getState().open).toBe(false)
  })

  it('setOpen sets explicitly', () => {
    useCopilotStore.getState().setOpen(true)
    expect(useCopilotStore.getState().open).toBe(true)
  })

  it('clamps width into [MIN_WIDTH, MAX_WIDTH]', () => {
    useCopilotStore.getState().setWidth(100)
    expect(useCopilotStore.getState().width).toBe(MIN_WIDTH)
    useCopilotStore.getState().setWidth(9999)
    expect(useCopilotStore.getState().width).toBe(MAX_WIDTH)
    useCopilotStore.getState().setWidth(450)
    expect(useCopilotStore.getState().width).toBe(450)
  })
})
