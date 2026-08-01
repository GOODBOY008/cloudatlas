/**
 * Central scenario registry.
 * Import all scenarios here; filter by suite or tag in the CLI.
 */

import { authScenarios } from './auth.js';
import { dashboardScenarios } from './dashboard.js';
import { finopsScenarios } from './finops.js';
import { cmdbScenarios } from './cmdb.js';
import { navigationScenarios } from './navigation.js';
import type { TestScenario } from '../types.js';

export const ALL_SCENARIOS: TestScenario[] = [
  ...authScenarios,
  ...dashboardScenarios,
  ...finopsScenarios,
  ...cmdbScenarios,
  ...navigationScenarios,
];

/**
 * Filter scenarios by suite name(s) and/or tag(s).
 * - suites: comma-separated suite names (e.g. "auth,finops")
 * - tags:   comma-separated tags (e.g. "smoke")
 * - ids:    comma-separated specific IDs (e.g. "AUTH-01,CMDB-03")
 */
export function filterScenarios(options: {
  suite?: string;
  suites?: string;
  tags?: string;
  ids?: string;
}): TestScenario[] {
  let scenarios = ALL_SCENARIOS;

  if (options.ids) {
    const ids = new Set(options.ids.split(',').map(s => s.trim().toUpperCase()));
    return scenarios.filter(s => ids.has(s.id.toUpperCase()));
  }

  const suiteFilter = options.suite ?? options.suites;
  if (suiteFilter) {
    const suites = new Set(suiteFilter.split(',').map(s => s.trim().toLowerCase()));
    scenarios = scenarios.filter(s => suites.has(s.suite.toLowerCase()));
  }

  if (options.tags) {
    const tags = new Set(options.tags.split(',').map(t => t.trim().toLowerCase()));
    scenarios = scenarios.filter(s => s.tags?.some(t => tags.has(t.toLowerCase())));
  }

  return scenarios;
}

export { authScenarios, dashboardScenarios, finopsScenarios, cmdbScenarios, navigationScenarios };
