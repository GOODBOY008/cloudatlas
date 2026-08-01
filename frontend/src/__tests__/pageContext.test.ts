import { describe, it, expect } from 'vitest'
import { chipsForRoute, pageLabelKeyForRoute } from '../components/copilot/pageContext'

describe('pageContext', () => {
  it('matches exact routes and sub-routes', () => {
    expect(pageLabelKeyForRoute('/recommendations')).toBe('nav.recommendations')
    expect(pageLabelKeyForRoute('/recommendations/archived')).toBe('nav.recommendations')
    expect(chipsForRoute('/dashboard')).toContain('copilot.suggest2.openAnomalies')
  })

  it('falls back to defaults and null label on unmatched routes', () => {
    expect(pageLabelKeyForRoute('/settings')).toBeNull()
    expect(chipsForRoute('/settings')).toContain('copilot.suggest.spend')
    expect(chipsForRoute('/cmdb')).toEqual(chipsForRoute('/anything-else'))
  })
})
