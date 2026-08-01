/**
 * Unit tests for CMDB drawer helpers touched by the 2026-08-15 defect fixes:
 * - D-5: formatRelativeTime must accept ISO-8601 strings (what the audit API
 *   returns) as well as UNIX epochs, and render '—' instead of "NaN" for
 *   unparseable input.
 */
import { describe, it, expect } from 'vitest'
import { formatRelativeTime } from '../pages/CMDB'

// Minimal i18n stub: echo the key with the interpolated count.
const t = (key: string, opts?: Record<string, unknown>) =>
  key === 'cmdb.justNow' ? 'just now' : `${key.split('.').pop()} ${(opts?.count ?? '')}`.trim()

describe('formatRelativeTime (D-5)', () => {
  it('accepts ISO-8601 strings from the audit API', () => {
    const iso = new Date(Date.now() - 30_000).toISOString() // 30s ago
    expect(formatRelativeTime(iso, t)).toBe('just now')

    const iso2 = new Date(Date.now() - 2 * 3600_000).toISOString() // 2h ago
    expect(formatRelativeTime(iso2, t)).toBe('hourAgo 2')

    const iso3 = new Date(Date.now() - 3 * 86400_000).toISOString() // 3d ago
    expect(formatRelativeTime(iso3, t)).toBe('dayAgo 3')
  })

  it('still accepts UNIX epoch seconds', () => {
    const epoch = Math.floor(Date.now() / 1000) - 45 // 45s ago
    expect(formatRelativeTime(epoch, t)).toBe('just now')

    const epoch2 = Math.floor(Date.now() / 1000) - 5 * 60 // 5min ago
    expect(formatRelativeTime(epoch2, t)).toBe('minAgo 5')
  })

  it('never renders NaN — unparseable timestamps become an em dash', () => {
    expect(formatRelativeTime('not-a-date', t)).toBe('—')
    expect(formatRelativeTime(Number.NaN, t)).toBe('—')
    expect(formatRelativeTime(0, t)).not.toContain('NaN') // epoch 0 = ~56y ago
  })
})
