import { routeForPath } from '../../app/routeCatalog'

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
  chips: string[]
}

const ROUTE_RULES: RouteRule[] = [
  {
    prefix: '/dashboard',
    chips: ['copilot.suggest.spend', 'copilot.suggest.forecast', 'copilot.suggest2.openAnomalies'],
  },
  {
    prefix: '/expenses',
    chips: ['copilot.suggest.spend', 'copilot.suggest.top', 'copilot.suggest2.spendByService'],
  },
  {
    prefix: '/recommendations',
    chips: ['copilot.suggest.recommendations', 'copilot.suggest2.biggestSaving', 'copilot.suggest2.howToApply'],
  },
  {
    prefix: '/anomaly-detection',
    chips: ['copilot.suggest2.openAnomalies', 'copilot.suggest2.explainLatest'],
  },
  {
    prefix: '/resources',
    chips: ['copilot.suggest.top', 'copilot.suggest2.howManyResources', 'copilot.suggest2.idleResources'],
  },
  {
    prefix: '/pools',
    chips: ['copilot.suggest.top', 'copilot.suggest2.howManyResources', 'copilot.suggest2.idleResources'],
  },
  {
    prefix: '/cost-map',
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
  return routeForPath(pathname)?.labelKey ?? null
}
