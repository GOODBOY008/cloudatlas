import { productRoutes, routeForPath } from '../app/routeCatalog'

export const helpArticles = [
  { id: 'start', sections: ['workspace', 'connect', 'review'], links: ['/cloud-accounts', '/data-flow'] },
  { id: 'cmdb', sections: ['model', 'discover', 'govern'], links: ['/ci-types', '/cmdb', '/ci-import', '/services', '/compliance'] },
  { id: 'finops', sections: ['import', 'currency', 'analyze'], links: ['/billing-import', '/expenses', '/pools', '/recommendations'] },
  { id: 'data-flow', sections: ['identity', 'coverage', 'freshness'], links: ['/data-flow', '/cloud-accounts', '/billing-import'] },
  { id: 'allocation', sections: ['pool', 'center', 'conflict'], links: ['/showback', '/cost-centers', '/services', '/rules'] },
  { id: 'troubleshooting', sections: ['empty', 'failed', 'difference'], links: ['/data-flow', '/billing-import', '/settings'] },
] as const

export const helpLinkLabels: Record<string, string> = Object.fromEntries(
  productRoutes.map((route) => [route.path, route.labelKey]),
)

export function helpForPath(path: string) {
  return routeForPath(path)?.help ?? 'start'
}
