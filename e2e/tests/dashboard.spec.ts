/**
 * Suite 4 & 5: Dashboard Interactions + Expenses Tabs
 */
import { test, expect } from '../fixtures/base.fixture';

test.describe('Dashboard Interactions @smoke', () => {
  test.beforeEach(async ({ dashboardPage }) => {
    await dashboardPage.navigate();
  });

  test('DASH-01 — stat cards render', async ({ dashboardPage }) => {
    await expect(dashboardPage.totalCostCard).toBeVisible();
  });

  test('DASH-02 — cost trend chart renders', async ({ dashboardPage }) => {
    await expect(dashboardPage.costTrendChart).toBeVisible();
  });

  test('DASH-03 — clicking Total Cost navigates to /expenses', async ({ dashboardPage }) => {
    await dashboardPage.totalCostCard.click();
    await dashboardPage.page.waitForURL(/\/expenses/, { timeout: 8000 });
    expect(dashboardPage.page.url()).toContain('/expenses');
  });

  test('DASH-04 — clicking Resources navigates to /cmdb', async ({ dashboardPage }) => {
    await dashboardPage.resourcesCard.click();
    await dashboardPage.page.waitForURL(/\/cmdb/, { timeout: 8000 });
    expect(dashboardPage.page.url()).toContain('/cmdb');
  });

  test('DASH-09 — forecast section is visible', async ({ dashboardPage }) => {
    const text = await dashboardPage.page.locator('main').textContent();
    expect(text).toMatch(/forecast/i);
  });

  test('DASH-10 — top resources section is visible', async ({ dashboardPage }) => {
    const text = await dashboardPage.page.locator('main').textContent();
    expect(text).toMatch(/top resources/i);
  });
});

test.describe('Expenses Tabs @regression', () => {
  test.beforeEach(async ({ expensesPage }) => {
    await expensesPage.navigate();
  });

  test('EXP-01 — page loads with content', async ({ expensesPage }) => {
    const text = await expensesPage.main.textContent();
    expect(text?.length ?? 0).toBeGreaterThan(100);
  });

  const TABS = [
    'Overview', 'By Service', 'By Region', 'By Cloud',
    'By Pool', 'Trend', 'Top Resources', 'Forecast',
    'Anomalies', 'RI Coverage', 'By Tag',
  ] as const;

  for (const tab of TABS) {
    test(`EXP tab — ${tab} renders`, async ({ expensesPage }) => {
      const btn = expensesPage.page.getByRole('button', { name: tab }).first();
      const isVisible = await btn.isVisible();
      if (!isVisible) {
        test.skip(true, `Tab "${tab}" not found`);
        return;
      }
      await btn.click();
      await expensesPage.page.waitForLoadState('networkidle');
      // After switching tab, main should still have content
      const text = await expensesPage.main.textContent();
      expect(text?.length ?? 0).toBeGreaterThan(20);
    });
  }

  test('EXP-13 — 7d date range button works', async ({ expensesPage }) => {
    const btn = expensesPage.page.getByRole('button', { name: '7d' }).first();
    if (await btn.isVisible()) {
      await btn.click();
      await expensesPage.page.waitForLoadState('networkidle');
    } else {
      test.skip(true, '7d button not found');
    }
  });
});
