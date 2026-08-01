/**
 * Dashboard test scenarios.
 */
import type { TestScenario } from '../types.js';

export const dashboardScenarios: TestScenario[] = [
  {
    id: 'DASH-01',
    name: 'Dashboard loads with stat cards',
    suite: 'dashboard',
    tags: ['smoke', 'dashboard'],
    goal: `Navigate to /dashboard. Take a screenshot.
Verify that at least 3 of these are visible on the page:
- A number/cost displayed (look for "$" or any dollar amount)
- "Total" or "Cost" or "Resources" or "Recommendations" text
- Any chart, graph, or visualization
- Any card with a metric

Get the page state to see what text is rendered.
Pass if the dashboard appears to have data widgets, fail if the page is empty or shows only an error.`,
  },

  {
    id: 'DASH-02',
    name: 'Dashboard navigation links work',
    suite: 'dashboard',
    tags: ['dashboard'],
    goal: `Navigate to /dashboard. Verify the sidebar is visible.
Click on "Expenses" or "Cost" in the sidebar navigation.
Verify the URL changed (no longer /dashboard).
Then click the CloudAtlas logo or "Dashboard" link to go back.
Verify we returned to /dashboard.
Pass if both navigations succeeded.`,
  },

  {
    id: 'DASH-03',
    name: 'Dashboard shows cloud account or pool data',
    suite: 'dashboard',
    tags: ['dashboard'],
    goal: `Navigate to /dashboard. Get the page state and take a screenshot.
Check if any of these appear on the page:
- Pool names or budget information
- Cloud account names (AWS, Alibaba, Mock)
- Expense data or cost numbers
- Recommendation count

Finish with pass if data is shown, fail if the page shows "No data", "0 items", or is completely empty.`,
  },
];
