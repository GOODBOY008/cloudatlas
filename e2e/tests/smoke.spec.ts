/**
 * Smoke test suite — minimal critical-path tests, fast to run in CI pre-checks.
 * Tagged @smoke — run with: npx playwright test --grep @smoke
 */
import { test, expect } from '../fixtures/base.fixture';
import { unauthTest } from '../fixtures/base.fixture';
import { LoginPage } from '../pages/LoginPage';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@acme.com';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS ?? 'Password123!';

test.describe('Smoke Tests @smoke', () => {
  test('health — API is reachable', async ({ api }) => {
    const healthy = await api.healthCheck();
    expect(healthy).toBe(true);
  });

  test('auth — can log in and get token', async ({ page }) => {
    // Navigate to app origin first so localStorage is accessible
    await page.goto('/');
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    const token = await page.evaluate(() => localStorage.getItem('ca_access_token'));
    expect(token).toBeTruthy();
  });

  test('dashboard — loads stat cards', async ({ dashboardPage }) => {
    await dashboardPage.navigate();
    await expect(dashboardPage.totalCostCard).toBeVisible();
  });

  test('pools — list renders', async ({ poolsPage }) => {
    await poolsPage.navigate();
    const text = await poolsPage.poolList.textContent();
    expect(text?.length ?? 0).toBeGreaterThan(10);
  });

  test('cmdb — page renders', async ({ cmdbPage }) => {
    await cmdbPage.navigate();
    await expect(cmdbPage.page.locator('main')).toBeVisible();
  });

  test('expenses — page renders', async ({ expensesPage }) => {
    await expensesPage.navigate();
    const text = await expensesPage.main.textContent();
    expect(text?.length ?? 0).toBeGreaterThan(50);
  });

  test('recommendations — page renders', async ({ recommendationsPage }) => {
    await recommendationsPage.navigate();
    const text = await recommendationsPage.main.textContent();
    expect(text?.length ?? 0).toBeGreaterThan(50);
  });
});
