/**
 * FinOps test scenarios: Expenses, Pools, Cloud Accounts, Recommendations.
 */
import type { TestScenario } from '../types.js';

export const finopsScenarios: TestScenario[] = [
  // ── Expenses ──────────────────────────────────────────────────────────────
  {
    id: 'FIN-01',
    name: 'Expenses page loads with charts',
    suite: 'finops',
    tags: ['smoke', 'finops'],
    goal: `Navigate to /expenses. Take a screenshot. Get the page state.
Verify the page loaded (not a blank page or error):
- Check URL contains "expenses"
- Look for any cost/expense related text (numbers, "$", "spend", "cost")
- Look for any tab buttons (By Service, By Region, By Cloud, Trend, etc.)
Pass if the expenses page has content, fail if it shows an error or is completely empty.`,
  },

  {
    id: 'FIN-02',
    name: 'Expenses tabs are navigable',
    suite: 'finops',
    tags: ['finops'],
    goal: `Navigate to /expenses. Get the page state to see available tabs.
Try clicking on different tab options — look for tabs like "By Service", "By Region", "Trend", "By Cloud".
After clicking each tab, verify the URL or page content changes.
Pass if at least 2 different tabs are clickable and show different content.
If no tabs are found, check if the page has any interactive elements and describe what you see.`,
  },

  // ── Pools ──────────────────────────────────────────────────────────────────
  {
    id: 'FIN-03',
    name: 'Pools page shows pool hierarchy',
    suite: 'finops',
    tags: ['smoke', 'finops'],
    goal: `Navigate to /pools. Take a screenshot. Get the page state.
Verify:
1. The URL contains "pools"
2. At least one pool name is visible (e.g. "Acme Corp", "Production", "Development", or any pool name)
3. Budget or cost information is present

Pass if pools are listed, fail if the page is empty or shows an error.`,
  },

  {
    id: 'FIN-04',
    name: 'Create a new pool',
    suite: 'finops',
    tags: ['finops', 'regression'],
    goal: `Navigate to /pools. Look for a "Create Pool" or "Add Pool" or "+" button and click it.
A modal or form should appear. Fill in:
- Pool name: "AI Test Pool"
- Budget limit: "5000" (if there's a budget field)
Submit/save the form.
Verify the new pool "AI Test Pool" appears in the list.
If you cannot find a create button, take a screenshot and describe what's available.
Pass if pool was created successfully, fail if creation failed or form was not found.`,
  },

  // ── Cloud Accounts ─────────────────────────────────────────────────────────
  {
    id: 'FIN-05',
    name: 'Cloud accounts page shows accounts',
    suite: 'finops',
    tags: ['smoke', 'finops'],
    goal: `Navigate to /cloud-accounts. Take a screenshot. Get the page state.
Verify:
1. The page loaded without errors
2. At least one cloud account is listed (look for "Mock", "AWS", "Alibaba", or any account)
3. Account status indicators are visible (connected, syncing, etc.)
Pass if accounts are shown, fail if empty or error.`,
  },

  {
    id: 'FIN-06',
    name: 'Add cloud account modal opens',
    suite: 'finops',
    tags: ['finops'],
    goal: `Navigate to /cloud-accounts.
Find and click the "Add Account" or "Connect" or "+" button.
Verify a modal/form opens with:
- Provider selection (AWS / Alibaba / Mock)
- Credential input fields

Take a screenshot of the modal.
Close the modal (look for Cancel/X button).
Pass if modal opens and closes correctly, fail if button not found or modal doesn't appear.`,
  },

  // ── Recommendations ────────────────────────────────────────────────────────
  {
    id: 'FIN-07',
    name: 'Recommendations page loads',
    suite: 'finops',
    tags: ['smoke', 'finops'],
    goal: `Navigate to /recommendations. Take a screenshot. Get the page state.
Verify the page has content:
- Look for recommendation items, cards, or a list
- Look for cost savings information ($amount)
- Look for recommendation types (idle, rightsizing, etc.)
- Or a "No recommendations" empty state is acceptable

Pass if the page loaded without JavaScript errors, fail if it shows a 500 error or crashes.`,
  },

  {
    id: 'FIN-08',
    name: 'Recommendations filter by type works',
    suite: 'finops',
    tags: ['finops'],
    goal: `Navigate to /recommendations. Get the page state to see what filters are available.
If there are filter options (type dropdown, category buttons), click on one filter (e.g. "Idle" or "Rightsizing").
Verify the view updates (URL changes, content changes, or filter is highlighted).
Take a screenshot after filtering.
Pass if filters are interactive, fail if no filter UI is found.`,
  },

  // ── Showback / Cost Map ────────────────────────────────────────────────────
  {
    id: 'FIN-09',
    name: 'Cost Map page loads',
    suite: 'finops',
    tags: ['finops'],
    goal: `Navigate to /cost-map. Take a screenshot. Get the page state.
Verify the page rendered:
- Look for a map visualization, world map, or geographic display
- Or look for a treemap or cost breakdown visualization
- The page should have some charts or data

Pass if the page has visual content, fail if it shows an error or blank page.`,
  },

  {
    id: 'FIN-10',
    name: 'Alerts page loads',
    suite: 'finops',
    tags: ['finops'],
    goal: `Navigate to /alerts. Take a screenshot. Get the page state.
Verify the alerts page loaded. Look for:
- Alert list or cards
- Budget alert configurations
- Evaluate/Run button
Pass if the page has content, fail if it shows an error.`,
  },
];
