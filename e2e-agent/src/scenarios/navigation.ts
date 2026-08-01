/**
 * Navigation and settings test scenarios.
 *
 * Post-2026-06-01 sidebar layout:
 *   - Overview:           Dashboard, Recommendations
 *   - Cost Management:    Cost Explorer, Cost Map, Showback, Budgets & Quotas, Cost Comparison
 *   - Resource Management: Resources, Pools, Shared Environments, Resource Lifecycle, K8s Rightsizing, Archive
 *   - Asset Inventory:    Configuration Items, Services, Dynamic Groups, Classifications, Associations, Model Topology, Service Templates, CI Import, Inventory Stats
 *   - Governance:         Compliance, Tagging Coverage, Anomaly Detection, Power Schedules, Apply Rules
 *   - Administration:     Cloud Accounts, Cost Centers, Alerts, Rules, Settings
 */
import type { TestScenario } from '../types.js';

export const navigationScenarios: TestScenario[] = [
  {
    id: 'NAV-01',
    name: 'Sidebar navigation renders',
    suite: 'navigation',
    tags: ['smoke', 'navigation'],
    goal: `Navigate to /dashboard. Take a screenshot.
Verify the sidebar is visible with navigation links grouped under these six labeled sections:
- Overview           (Dashboard, Recommendations)
- Cost Management    (Cost Explorer, Cost Map, Showback, Budgets & Quotas, Cost Comparison)
- Resource Management (Resources, Pools, Shared Environments, Resource Lifecycle, K8s Rightsizing, Archive)
- Asset Inventory    (Configuration Items, Services, Dynamic Groups, Classifications, Associations, Model Topology, Service Templates, CI Import, Inventory Stats)
- Governance         (Compliance, Tagging Coverage, Anomaly Detection, Power Schedules, Apply Rules)
- Administration     (Cloud Accounts, Cost Centers, Alerts, Rules, Settings)

The CMDB page is now labeled "Configuration Items" (it was "CMDB" before the 2026-06-01 redesign).
The /quotas-budgets page is now labeled "Budgets & Quotas" (it was "Quotas & Budgets" before).
The /cmdb-stats page is now labeled "Inventory Stats" (it was "CMDB Stats" before).
At least 25 navigation items should be visible.

Pass if the six section labels and most items are present, fail if the sidebar is missing or empty.`,
  },

  {
    id: 'NAV-02',
    name: 'Theme toggle switches dark/light mode',
    suite: 'navigation',
    tags: ['navigation'],
    goal: `Navigate to /dashboard.
Look for a theme toggle button (sun/moon icon, usually in the header top-right).
Take a screenshot before toggling.
Click the theme toggle button.
Take another screenshot after toggling.
Verify the page appearance changed (look for dark/light class on html element or visual change).
Pass if toggle is found and clickable, fail if no theme toggle exists.`,
  },

  {
    id: 'NAV-03',
    name: 'All major pages are reachable',
    suite: 'navigation',
    tags: ['regression', 'navigation'],
    goal: `Test that all major routes load without a JavaScript crash or 404.
Navigate to each of these pages and check it renders (not blank, not error):
1. /dashboard
2. /expenses                (labeled "Cost Explorer" in the sidebar)
3. /cost-map                (labeled "Cost Map")
4. /cost-comparison         (labeled "Cost Comparison", moved from old Sandbox to Cost Management)
5. /pools
6. /resources
7. /shared-environments
8. /cloud-accounts
9. /recommendations
10. /cmdb                   (labeled "Configuration Items" in the sidebar)
11. /services
12. /dynamic-groups
13. /compliance             (moved from CMDB section to Governance section)
14. /tagging-coverage       (moved from Policies to Governance)
15. /settings
16. /alerts

For each page, get_page_state briefly and note if it loaded or errored.
Take a single screenshot at the end.
Pass if at least 14/16 pages load, fail if more than 2 are blank or error pages.`,
  },

  {
    id: 'NAV-04',
    name: 'Settings page shows org info and members',
    suite: 'navigation',
    tags: ['navigation'],
    goal: `Navigate to /settings. Take a screenshot. Get the page state.
Verify:
1. Organization name is displayed (e.g. "Acme Corp")
2. Member list shows at least one user
3. Email addresses or user names are visible

Note: Settings is in the "Administration" section in the new sidebar.
Pass if settings page shows org and member data, fail if empty or error.`,
  },

  {
    id: 'NAV-05',
    name: 'Renamed sidebar labels are visible',
    suite: 'navigation',
    tags: ['regression', 'navigation'],
    goal: `Navigate to /dashboard. Get the page state.
Verify that the following renamed items are present in the sidebar (post-2026-06-01 redesign):
- "Dashboard" (was previously labeled "Home")
- "Configuration Items" (was previously labeled "CMDB")
- "Inventory Stats" (was previously labeled "CMDB Stats")
- "Budgets & Quotas" (was previously labeled "Quotas & Budgets")
- "Tagging Coverage" (was previously labeled "Tagging")
- "Cost Comparison" (moved from Sandbox to Cost Management)

Also verify the sidebar does NOT contain the old labels: "Home", "CMDB Stats", "Quotas & Budgets", or a bare "Tagging" entry.
Pass if all renamed labels are visible and old labels are absent.`,
  },
];
