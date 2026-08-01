/**
 * User Quick-Start Tutorial — E2E Walkthrough
 *
 * Simulates a new user exploring every major CloudAtlas feature area in order.
 * Tagged @user-guide — run with: npx playwright test --grep @user-guide
 *
 * Steps:
 *   UG-01  Dashboard
 *   UG-02  Cost Explorer
 *   UG-03  Cost Map
 *   UG-04  Recommendations
 *   UG-05  Pools
 *   UG-06  Resources
 *   UG-07  Configuration Items (CMDB)
 *   UG-08  Services
 *   UG-09  Compliance
 *   UG-10  Cloud Accounts
 *   UG-11  Settings
 */
import { test, expect } from '../fixtures/base.fixture';

test.describe.serial('User Quick-Start Tutorial @user-guide', () => {
  // ─────────────────────────────────────────────────
  // UG-01 — Dashboard: First Impression
  // ─────────────────────────────────────────────────
  test('UG-01 — Dashboard: stat cards, chart, and key sections', async ({ dashboardPage, page }) => {
    await dashboardPage.navigate();

    // Stat cards
    await expect(dashboardPage.totalCostCard).toBeVisible();
    await expect(dashboardPage.resourcesCard).toBeVisible();
    await expect(dashboardPage.recommendationsCard).toBeVisible();
    await expect(dashboardPage.poolsCard).toBeVisible();

    // Cost trend chart (Recharts renders an <svg>)
    await expect(dashboardPage.costTrendChart).toBeVisible();

    // Key dashboard sections
    const mainText = await page.locator('main').textContent();
    expect(mainText).toMatch(/forecast/i);
    expect(mainText).toMatch(/top resources/i);

    // Sidebar navigation is present
    await expect(page.locator('nav')).toBeVisible();
  });

  // ─────────────────────────────────────────────────
  // UG-02 — Cost Explorer: Tab Browsing
  // ─────────────────────────────────────────────────
  test('UG-02 — Cost Explorer: overview and tab switching', async ({ expensesPage, page }) => {
    await expensesPage.navigate();

    // Main content renders with meaningful data
    const initialText = await expensesPage.main.textContent();
    expect((initialText ?? '').length).toBeGreaterThan(100);

    // Tab buttons are visible
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'By Service' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trend' })).toBeVisible();

    // Switch to "By Service" tab — content should update
    await expensesPage.clickTab('By Service');
    const serviceText = await expensesPage.main.textContent();
    expect((serviceText ?? '').length).toBeGreaterThan(20);

    // Switch to "Trend" tab — content should still render
    await expensesPage.clickTab('Trend');
    const trendText = await expensesPage.main.textContent();
    expect((trendText ?? '').length).toBeGreaterThan(20);
  });

  // ─────────────────────────────────────────────────
  // UG-03 — Cost Map: Visualization
  // ─────────────────────────────────────────────────
  test('UG-03 — Cost Map: heading, subtitle, and view tabs', async ({ page }) => {
    await page.goto('/cost-map');
    await page.waitForLoadState('networkidle');

    // Page heading and subtitle
    await expect(page.getByRole('heading', { name: /cost map/i })).toBeVisible();
    const mainText = await page.locator('main').textContent();
    expect(mainText).toMatch(/geographic and dimensional cloud spend visualisation/i);

    // View tabs are visible
    await expect(page.getByRole('button', { name: 'Treemap' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unit Economics' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Budget Matrix' })).toBeVisible();

    // Switch to Treemap tab and verify content renders
    await page.getByRole('button', { name: 'Treemap' }).click();
    await page.waitForLoadState('networkidle');
    const treemapContent = await page.locator('main').textContent();
    expect((treemapContent ?? '').length).toBeGreaterThan(20);
  });

  // ─────────────────────────────────────────────────
  // UG-04 — Recommendations: Category Browsing
  // ─────────────────────────────────────────────────
  test('UG-04 — Recommendations: list and category filter', async ({ recommendationsPage, page }) => {
    await recommendationsPage.navigate();

    // Main content renders
    const initialText = await recommendationsPage.main.textContent();
    expect((initialText ?? '').length).toBeGreaterThan(50);

    // Category filter buttons are visible
    await expect(page.getByRole('button', { name: 'All' }).first()).toBeVisible();

    // Click "Idle" category if available — content should re-render
    const idleBtn = page.getByRole('button', { name: 'Idle' }).first();
    if (await idleBtn.isVisible()) {
      await recommendationsPage.clickCategory('Idle');
      const filteredText = await recommendationsPage.main.textContent();
      expect((filteredText ?? '').length).toBeGreaterThan(0);
    }
  });

  // ─────────────────────────────────────────────────
  // UG-05 — Pools: List and Create Button
  // ─────────────────────────────────────────────────
  test('UG-05 — Pools: list renders and create form opens', async ({ poolsPage, page }) => {
    await poolsPage.navigate();

    // Pool list has content (seed pools exist)
    const listText = await poolsPage.poolList.textContent();
    expect((listText ?? '').length).toBeGreaterThan(10);

    // "New Pool" button is visible
    await expect(poolsPage.newPoolBtn).toBeVisible();

    // Open the create form
    await poolsPage.openCreateModal();
    await expect(poolsPage.formHeading).toBeVisible();
    await expect(poolsPage.nameInput).toBeVisible();

    // Dismiss the form via Cancel button (Escape does not close inline forms)
    await page.getByRole('button', { name: /cancel/i }).first().click();
    await poolsPage.formHeading.waitFor({ state: 'hidden', timeout: 5_000 });
  });

  // ─────────────────────────────────────────────────
  // UG-06 — Resources: Table and Search
  // ─────────────────────────────────────────────────
  test('UG-06 — Resources: heading, subtitle, and search input', async ({ page }) => {
    await page.goto('/resources');
    await page.waitForLoadState('networkidle');

    // Page heading and subtitle
    await expect(page.getByRole('heading', { name: /resources/i })).toBeVisible();
    const mainText = await page.locator('main').textContent();
    expect(mainText).toMatch(/all tracked cloud resources across your accounts/i);

    // Search input is visible
    await expect(page.getByPlaceholder(/search by name or resource id/i)).toBeVisible();

    // Main content has meaningful text (table or cards render)
    expect((mainText ?? '').length).toBeGreaterThan(50);
  });

  // ─────────────────────────────────────────────────
  // UG-07 — Configuration Items (CMDB): Table and Drawer
  // ─────────────────────────────────────────────────
  test('UG-07 — CMDB: CI table, create button, and detail drawer', async ({ cmdbPage }) => {
    await cmdbPage.navigate();

    // CI table and controls are visible
    await expect(cmdbPage.ciTable).toBeVisible();
    await expect(cmdbPage.newCiBtn).toBeVisible();
    await expect(cmdbPage.searchInput).toBeVisible();

    // At least one CI row exists (seed data)
    await expect(cmdbPage.firstCiRow).toBeVisible();

    // Click first row to open the detail drawer
    await cmdbPage.firstCiRow.click();
    await cmdbPage.drawer.waitFor({ state: 'visible', timeout: 8_000 });

    // Dismiss the drawer
    await cmdbPage.closeModal();
  });

  // ─────────────────────────────────────────────────
  // UG-08 — Services: List View
  // ─────────────────────────────────────────────────
  test('UG-08 — Services: list renders and create form toggles', async ({ page }) => {
    await page.goto('/services');
    await page.waitForLoadState('networkidle');

    // "New Service" button is visible
    const newServiceBtn = page.getByRole('button', { name: /\+ new service/i });
    await expect(newServiceBtn).toBeVisible();

    // Main content has text
    const mainText = await page.locator('main').textContent();
    expect((mainText ?? '').length).toBeGreaterThan(20);

    // Open the create form
    await newServiceBtn.click();
    await expect(page.getByRole('heading', { name: /create service/i })).toBeVisible();

    // Cancel returns to list view
    await page.getByRole('button', { name: /cancel/i }).first().click();
    await expect(page.getByRole('heading', { name: /create service/i })).toBeHidden();
  });

  // ─────────────────────────────────────────────────
  // UG-09 — Compliance: Policy View
  // ─────────────────────────────────────────────────
  test('UG-09 — Compliance: heading, run check, and new policy buttons', async ({ page }) => {
    // Use domcontentloaded — this route may have slow/unstable backend calls
    await page.goto('/compliance');
    await page.waitForLoadState('domcontentloaded');

    // Page heading
    await expect(page.getByRole('heading', { name: /compliance/i })).toBeVisible();

    // Action buttons are visible
    await expect(page.getByRole('button', { name: /run check/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /\+ new policy/i })).toBeVisible();
  });

  // ─────────────────────────────────────────────────
  // UG-10 — Cloud Accounts: Account List
  // ─────────────────────────────────────────────────
  test('UG-10 — Cloud Accounts: seed account visible and add form opens', async ({ cloudAccountsPage, page }) => {
    await cloudAccountsPage.navigate();

    // Account list renders with seed data
    await expect(cloudAccountsPage.accountList).toBeVisible();
    const listText = await page.locator('main').textContent();
    expect(listText).toMatch(/aws|mock/i);

    // "Add Account" button is visible
    await expect(cloudAccountsPage.addAccountBtn).toBeVisible();

    // Open the add form
    await cloudAccountsPage.openAddForm();
    const form = page.locator('[role="dialog"], form').first();
    await expect(form).toBeVisible();

    // Dismiss the form
    await cloudAccountsPage.closeModal();
  });

  // ─────────────────────────────────────────────────
  // UG-11 — Settings: Organization and Members
  // ─────────────────────────────────────────────────
  test('UG-11 — Settings: org name and seed members visible', async ({ settingsPage, page }) => {
    await settingsPage.navigate();

    // Settings page renders
    await expect(page.locator('main')).toBeVisible();

    // Organization name from seed data
    const mainText = await page.locator('main').textContent();
    expect(mainText).toMatch(/acme[- ]?corp/i);

    // Seed members are present
    expect(mainText).toMatch(/alice|bob|admin/i);
  });
});
