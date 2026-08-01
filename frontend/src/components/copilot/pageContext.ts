/** Route-aware copilot config: starter chips + context label per page (spec §4.4). */

export const DEFAULT_CHIPS = [
  'copilot.suggest.spend',
  'copilot.suggest.top',
  'copilot.suggest.recommendations',
  'copilot.suggest.budget',
  'copilot.suggest.forecast',
]

interface RouteRule {
  prefix: string
  labelKey: string
  chips: string[]
}

const ROUTE_RULES: RouteRule[] = [
  {
    prefix: '/dashboard',
    labelKey: 'nav.dashboard',
    chips: ['copilot.suggest.spend', 'copilot.suggest.forecast', 'copilot.suggest2.openAnomalies'],
  },
  {
    prefix: '/expenses',
    labelKey: 'nav.expenses',
    chips: ['copilot.suggest.spend', 'copilot.suggest.top', 'copilot.suggest2.spendByService'],
  },
  {
    prefix: '/recommendations',
    labelKey: 'nav.recommendations',
    chips: ['copilot.suggest.recommendations', 'copilot.suggest2.biggestSaving', 'copilot.suggest2.howToApply'],
  },
  {
    prefix: '/anomaly-detection',
    labelKey: 'nav.anomalyDetection',
    chips: ['copilot.suggest2.openAnomalies', 'copilot.suggest2.explainLatest'],
  },
  {
    prefix: '/resources',
    labelKey: 'nav.resources',
    chips: ['copilot.suggest.top', 'copilot.suggest2.howManyResources', 'copilot.suggest2.idleResources'],
  },
  {
    prefix: '/pools',
    labelKey: 'nav.pools',
    chips: ['copilot.suggest.top', 'copilot.suggest2.howManyResources', 'copilot.suggest2.idleResources'],
  },
  {
    prefix: '/cost-map',
    labelKey: 'nav.costMap',
    chips: ['copilot.suggest.top', 'copilot.suggest2.howManyResources', 'copilot.suggest2.idleResources'],
  },
]

function matchRoute(pathname: string): RouteRule | null {
  return (
    ROUTE_RULES.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/')) ?? null
  )
}

export function chipsForRoute(pathname: string): string[] {
  return matchRoute(pathname)?.chips ?? DEFAULT_CHIPS
}

export function pageLabelKeyForRoute(pathname: string): string | null {
  return matchRoute(pathname)?.labelKey ?? null
}
