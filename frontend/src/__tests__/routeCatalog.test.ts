import { describe, expect, it } from 'vitest'
import { productRoutes, navigationSections, routeForPath } from '../app/routeCatalog'
import { helpForPath, helpLinkLabels } from '../lib/help'
import en from '../i18n/locales/en'
import zh from '../i18n/locales/zh'

describe('product navigation contract', () => {
  it('gives every registered page a unique URL and bilingual navigation', () => {
    expect(new Set(productRoutes.map((route) => route.path)).size).toBe(productRoutes.length)
    for (const route of productRoutes) {
      expect(en).toHaveProperty(route.labelKey)
      expect(zh).toHaveProperty(route.labelKey)
      expect(navigationSections.some((section) => section.key === route.section)).toBe(true)
    }
  })

  it('exposes the audit trail while preserving the hidden archived deep link', () => {
    const paths = navigationSections.flatMap((section) => section.items.map((item) => item.path))
    expect(paths).toContain('/cmdb-audit')
    expect(paths).not.toContain('/recommendations/archived')
    expect(routeForPath('/recommendations/archived')?.path).toBe('/recommendations/archived')
  })

  it('matches route segments and uses the same context for search, help and breadcrumbs', () => {
    expect(routeForPath('/resources-other')).toBeUndefined()
    expect(routeForPath('/ci-types/?q=server')?.labelKey).toBe('nav.ciTypes')
    expect(helpForPath('/recommendations/archived')).toBe('finops')
    expect(helpLinkLabels['/cmdb-audit']).toBe(routeForPath('/cmdb-audit')?.labelKey)
  })
})
