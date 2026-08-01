/**
 * CMDB test scenarios: CI types, CI instances, associations, services, compliance.
 *
 * Post-2026-06-01 sidebar:
 *   - /cmdb is labeled "Configuration Items" (in the "Asset Inventory" section).
 *   - Compliance moved to the "Governance" section.
 *   - /cmdb-audit (Audit Log) is no longer in the sidebar; the route still works.
 *   - /cmdb-stats is now labeled "Inventory Stats".
 */
import type { TestScenario } from '../types.js';

export const cmdbScenarios: TestScenario[] = [
  {
    id: 'CMDB-01',
    name: 'Configuration Items page loads with CI list',
    suite: 'cmdb',
    tags: ['smoke', 'cmdb'],
    goal: `Navigate to /cmdb. Take a screenshot. Get the page state.
Verify:
1. The URL contains "cmdb"
2. Page has content (CI list, type selector, or search bar)
3. Look for any CI type names (Instance, Volume, Network, etc.)
4. Or a count of CIs/resources

Note: the page title and h2 read "CMDB — Configuration Items" but the sidebar label is now "Configuration Items".
Pass if the CMDB page loaded with content, fail if it shows an error.`,
  },

  {
    id: 'CMDB-02',
    name: 'CMDB search / filter works',
    suite: 'cmdb',
    tags: ['cmdb'],
    goal: `Navigate to /cmdb. Get the page state to see what UI is available.
Look for a search input or filter. If found:
1. Click the search/filter field
2. Type "web" or "server" or "instance"
3. Verify results update or filter is applied
Take a screenshot.
Pass if search/filter UI exists and is interactive, fail if no search found.`,
  },

  {
    id: 'CMDB-03',
    name: 'CI detail drawer opens',
    suite: 'cmdb',
    tags: ['cmdb'],
    goal: `Navigate to /cmdb. Get the page state.
Find a CI item in the list and click on it to open a detail drawer or detail view.
Verify the drawer shows:
- CI name or ID
- Lifecycle state (active, provisioning, etc.)
- Some attributes or metadata

Take a screenshot of the open drawer.
If no CI items are found, navigate to /cmdb and take a screenshot to document the state.
Pass if a detail view opens, fail if nothing happens when clicking.`,
  },

  {
    id: 'CMDB-04',
    name: 'Services page loads',
    suite: 'cmdb',
    tags: ['cmdb'],
    goal: `Navigate to /services. Take a screenshot. Get the page state.
Verify the services page loaded:
- Look for a service list or cards
- Look for create service button
- Or an empty state with create option

Pass if page loaded without errors, fail if it shows a JavaScript crash.`,
  },

  {
    id: 'CMDB-05',
    name: 'Dynamic Groups page loads',
    suite: 'cmdb',
    tags: ['cmdb'],
    goal: `Navigate to /dynamic-groups. Take a screenshot. Get the page state.
Verify:
1. Page loaded (URL contains "dynamic-groups")
2. There is a way to create or view dynamic groups
3. No JavaScript errors visible

Pass if page loaded, fail if there's a crash or 404.`,
  },

  {
    id: 'CMDB-06',
    name: 'Compliance page loads (now in Governance section)',
    suite: 'cmdb',
    tags: ['cmdb'],
    goal: `Navigate to /compliance. Take a screenshot. Get the page state.
Verify the compliance page has content:
- Compliance policies list
- Or a way to create policies
- Status indicators (compliant/non-compliant)

Note: Compliance was moved out of the CMDB section to a new "Governance" section in the 2026-06-01 sidebar redesign.
Pass if the page loaded, fail if it crashes.`,
  },

  {
    id: 'CMDB-07',
    name: 'CI Classifications page loads',
    suite: 'cmdb',
    tags: ['cmdb'],
    goal: `Navigate to /ci-classifications. Take a screenshot. Get the page state.
Verify:
- Classification list is shown (e.g. cloud_compute, storage, network, commitment)
- Or a way to manage CI type classifications

Pass if page has content, fail if it shows an error.`,
  },

  {
    id: 'CMDB-08',
    name: 'CMDB Audit Log page loads (route preserved, sidebar removed)',
    suite: 'cmdb',
    tags: ['cmdb'],
    goal: `Navigate to /cmdb-audit. Take a screenshot. Get the page state.
Verify the audit log page loaded:
- Look for a list of audit entries (user, action, timestamp)
- Or empty state if no audits yet

Note: Audit Log was removed from the sidebar in the 2026-06-01 redesign, but the route /cmdb-audit is still served. The only way to reach it is by direct URL or a deep link.
Pass if the page loaded without errors.`,
  },

  {
    id: 'CMDB-09',
    name: 'Inventory Stats page loads (renamed from CMDB Stats)',
    suite: 'cmdb',
    tags: ['cmdb', 'regression'],
    goal: `Navigate to /cmdb-stats. Take a screenshot. Get the page state.
Verify the inventory stats page loaded:
- Look for any charts, numbers, or statistics about CIs
- Look for empty state if no data

Note: the page route is still /cmdb-stats but the sidebar label is now "Inventory Stats" (it was "CMDB Stats" before the 2026-06-01 redesign).
Pass if the page loaded without errors.`,
  },

  {
    id: 'CMDB-10',
    name: 'Apply Rules page loads (now in Governance section)',
    suite: 'cmdb',
    tags: ['cmdb', 'regression'],
    goal: `Navigate to /ci-apply-rules. Take a screenshot. Get the page state.
Verify the page loaded:
- Look for a list of apply rules or a way to create them
- Or empty state

Note: Apply Rules was moved out of the CMDB section to a new "Governance" section in the 2026-06-01 redesign.
Pass if the page loaded, fail if it crashes.`,
  },

  {
    id: 'CMDB-11',
    name: 'Edit CI tags via drawer (replaces read-only display)',
    suite: 'cmdb',
    tags: ['cmdb', 'regression'],
    goal: `Navigate to /cmdb. Click on the first CI in the list to open the detail drawer.
In the drawer, locate the "Tags" section. There should be an "Edit" button next to it.
Click Edit. A key-value editor should appear: one row per existing tag with "key" and "value" text inputs and an "×" delete button, plus an "+ Add tag" button to add new rows.
Edit a row's key or value, or click "+ Add tag" to add a new one, then click Save.
The drawer should now display the updated tag chip(s) (e.g. environment=e2e).
Close the drawer and reopen the same CI to confirm the change persists.
Take a screenshot before and after the save.
Pass if the Edit button is present, the key-value editor accepts input and validates (no empty keys, no duplicates), the save persists to the database, and the new tag is visible in the drawer after reload.
Fail if no Edit button is found, the key-value editor is missing, the save returns an error, or the changes do not persist after closing/reopening the drawer.

Note: prior to 2026-06-02, the Tags section in the CI drawer was read-only. The new PATCH /api/v1/orgs/:org_id/cis/:ci_id/tags endpoint and in-drawer key-value editor close that gap.`,
  },
];
