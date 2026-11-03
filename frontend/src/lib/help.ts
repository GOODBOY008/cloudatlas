export const helpArticles = [
  { id: 'start', sections: ['workspace', 'connect', 'review'], links: ['/cloud-accounts', '/data-flow'] },
  { id: 'cmdb', sections: ['model', 'discover', 'govern'], links: ['/ci-types', '/cmdb', '/ci-import', '/services', '/compliance'] },
  { id: 'finops', sections: ['import', 'currency', 'analyze'], links: ['/billing-import', '/expenses', '/pools', '/recommendations'] },
  { id: 'data-flow', sections: ['identity', 'coverage', 'freshness'], links: ['/data-flow', '/cloud-accounts', '/billing-import'] },
  { id: 'allocation', sections: ['pool', 'center', 'conflict'], links: ['/showback', '/cost-centers', '/services', '/rules'] },
  { id: 'troubleshooting', sections: ['empty', 'failed', 'difference'], links: ['/data-flow', '/billing-import', '/settings'] },
] as const

export const helpLinkLabels: Record<string, string> = {
  '/cloud-accounts': 'nav.cloudAccounts', '/data-flow': 'nav.dataFlow', '/ci-types': 'nav.ciTypes',
  '/cmdb': 'nav.cmdb', '/ci-import': 'nav.ciImport', '/services': 'nav.services',
  '/compliance': 'nav.compliance', '/billing-import': 'nav.billingImport', '/expenses': 'nav.expenses',
  '/pools': 'nav.pools', '/recommendations': 'nav.recommendations', '/showback': 'nav.showback',
  '/cost-centers': 'nav.costCenters', '/rules': 'nav.rules', '/settings': 'nav.settings',
}

export function helpForPath(path: string) {
  if (path === '/data-flow') return 'data-flow'
  if (['/showback', '/cost-centers', '/services', '/rules', '/pools'].includes(path)) return 'allocation'
  if (['/cmdb', '/ci-types', '/ci-import', '/compliance', '/ci-topology', '/external-cmdb', '/drift', '/field-templates', '/dynamic-groups'].includes(path)) return 'cmdb'
  if (['/expenses', '/cost-map', '/billing-import', '/recommendations', '/tagging-coverage', '/quotas-budgets'].includes(path)) return 'finops'
  return 'start'
}
