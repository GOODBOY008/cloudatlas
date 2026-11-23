import { describe, it, expect, beforeEach } from 'vitest'
import { useCopilotStore } from '../store/copilotStore'
import { adjustWindow, DEFAULT_LAYOUT, fitWindow } from '../lib/copilotWindow'

describe('copilotStore', () => {
  beforeEach(() => {
    useCopilotStore.getState().setOpen(false)
    useCopilotStore.getState().setLayout(DEFAULT_LAYOUT)
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

  it('reads width-only preferences without opening the window', async () => {
    localStorage.setItem('cloudatlas-copilot', JSON.stringify({ state: { width: 480 }, version: 0 }))
    await useCopilotStore.persist.rehydrate()
    expect(useCopilotStore.getState().layout).toEqual({ width: 480, height: 560 })
    expect(useCopilotStore.getState().open).toBe(false)
  })

  it('persists only geometry and recovers from unusable coordinates', async () => {
    const layout = { width: 520, height: 480, left: 40, top: 32 }
    useCopilotStore.getState().setLayout(layout)
    useCopilotStore.getState().setOpen(true)
    expect(JSON.parse(localStorage.getItem('cloudatlas-copilot')!).state).toEqual(layout)
    localStorage.setItem('cloudatlas-copilot', JSON.stringify({ state: { width: 9999, height: 'bad', left: 15 }, version: 0 }))
    await useCopilotStore.persist.rehydrate()
    expect(useCopilotStore.getState().layout).toEqual({ width: 560, height: 560 })
  })

  it('keeps the window reachable and resizes around the opposite corner', () => {
    const viewport = { width: 1200, height: 800 }
    const rect = fitWindow(DEFAULT_LAYOUT, viewport)
    expect(rect).toEqual({ left: 780, top: 160, width: 400, height: 560 })
    const large = adjustWindow(rect, 'resize', -1000, -1000, viewport)
    expect(large).toEqual({ left: 620, top: 12, width: 560, height: 708 })
    expect(adjustWindow(rect, 'resize', 1000, 1000, viewport)).toMatchObject({ width: 320, height: 320 })
    const moved = adjustWindow(rect, 'move', 9000, 9000, viewport)
    const fitted = fitWindow(moved, { width: 1024, height: 440 })
    expect(fitted.left + fitted.width).toBe(1012)
    expect(fitted.top + fitted.height).toBe(428)
  })
})
