import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMediaQuery } from '../components/copilot/useMediaQuery'

function mockMatchMedia(matches: boolean) {
  const listeners: Array<(e: { matches: boolean }) => void> = []
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb),
    removeEventListener: () => {},
  })))
  return listeners
}

describe('useMediaQuery', () => {
  it('returns fallback when matchMedia is unavailable (jsdom)', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)', true))
    expect(result.current).toBe(true)
  })

  it('reflects matchMedia result', () => {
    mockMatchMedia(true)
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)', false))
    expect(result.current).toBe(true)
  })
})
