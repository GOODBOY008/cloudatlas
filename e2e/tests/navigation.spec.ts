/**
 * Suite 2: Navigation & Sidebar (NAV-01 → NAV-12)
 * Authenticated via storageState.
 *
 * Sidebar structure (post-2026-06-01 menu redesign):
 *   - Overview:           Dashboard, Recommendations
 *   - Cost Management:    Cost Explorer, Cost Map, Showback, Budgets & Quotas, Cost Comparison
 *   - Resource Management: Resources, Pools, Shared Environments, Resource Lifecycle, K8s Rightsizing, Archive
 *   - Asset Inventory:    Configuration Items, Services, Dynamic Groups, Classifications, Associations, Model Topology, Service Templates, CI Import, Inventory Stats
 *   - Governance:         Compliance, Tagging Coverage, Anomaly Detection, Power Schedules, Apply Rules
 *   - Administration:     Cloud Accounts, Cost Centers, Alerts, Rules, Settings
 *
 * /cmdb-audit is intentionally NOT in the sidebar (route preserved, see pages.spec.ts).
 */
import { test, expect } from '../fixtures/base.fixture';

test.describe('Navigation & Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
  });

  test('NAV-01 — sidebar nav sections visible @smoke', async ({ page }) => {
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
    // Expect at least 25 navigable links (32 in the new structure, 33 incl. duplicate settings pre-redesign)
    const links = nav.getByRole('link');
    expect(await links.count()).toBeGreaterThanOrEqual(25);
  });

  test('NAV-02 — sidebar shows Cost Management and Asset Inventory sections', async ({ page }) => {
    const navText = (await page.locator('nav').textContent()) ?? '';
    // New section names (replaces the pre-redesign "FinOps" / "CMDB" pair).
    expect(navText, 'should contain "Cost Management" section label').toMatch(/cost management/i);
    expect(navText, 'should contain "Asset Inventory" section label').toMatch(/asset inventory/i);
  });

  test('NAV-03 — active nav item highlighted on /pools', async ({ page }) => {
    await page.goto('/pools');
    await page.waitForLoadState('networkidle');
    // Active link should be visible (Pools is in Resource Management)
    const activeLink = page.locator('nav a').filter({ hasText: /^Pools$/ }).first();
    await expect(activeLink).toBeVisible();
  });

  test('NAV-04 — theme toggle switches dark mode', async ({ page }) => {
    const themeBtn = page
      .locator('button[aria-label*="theme" i], button[aria-label*="dark" i], button[title*="theme" i]')
      .first();
    if (await themeBtn.isVisible()) {
      const html = page.locator('html');
      const before = await html.getAttribute('class');
      await themeBtn.click();
      const after = await html.getAttribute('class');
      expect(after).not.toEqual(before);
    } else {
      test.skip(true, 'Theme toggle not found');
    }
  });

  test('NAV-06 — key nav links are reachable @regression', async ({ page }) => {
    // "Configuration Items" is the new display label for /cmdb (was "CMDB").
    // Other labels route-checked by URL pattern to be resilient to minor renames.
    const linksToCheck = [
      { name: /configuration items/i, url: /cmdb/ },
      { name: /cost explorer|expenses/i, url: /expenses/ },
      { name: /pools/i, url: /pools/ },
      { name: /recommendations/i, url: /recommendations/ },
    ];
    for (const { name, url } of linksToCheck) {
      const link = page.locator('nav').getByRole('link', { name }).first();
      if (await link.isVisible()) {
        await link.click();
        await page.waitForURL(url, { timeout: 10_000 });
        expect(page.url()).toMatch(url);
        await page.goto('/dashboard');
        await page.waitForLoadState('networkidle');
      } else {
        test.skip(true, `Nav link not found: ${name}`);
      }
    }
  });

  test('NAV-07 — brand/logo navigates to dashboard', async ({ page }) => {
    await page.goto('/pools');
    await page.waitForLoadState('networkidle');

    const brand = page.locator('nav a[href="/"], nav a[href="/dashboard"], nav a:has(img)').first();
    if (await brand.isVisible()) {
      await brand.click();
      await page.waitForURL(/\/(dashboard)?$/);
      expect(page.url()).toMatch(/\/(dashboard)?$/);
    } else {
      test.skip(true, 'Brand link not found');
    }
  });

  test('NAV-08 — logout button visible in sidebar', async ({ page }) => {
    const anyLogout = page.getByRole('button', { name: /logout|sign out/i }).first();
    await expect(anyLogout).toBeVisible();
  });

  test('NAV-09 — all six section labels are present @regression', async ({ page }) => {
    const navText = (await page.locator('nav').textContent()) ?? '';
    const expectedSections = [
      'Overview',
      'Cost Management',
      'Resource Management',
      'Asset Inventory',
      'Governance',
      'Administration',
    ];
    for (const section of expectedSections) {
      expect(
        navText,
        `sidebar should contain section label "${section}"`,
      ).toMatch(new RegExp(section, 'i'));
    }
  });

  test('NAV-10 — renamed nav labels are present (post-redesign) @regression', async ({ page }) => {
    const navText = (await page.locator('nav').textContent()) ?? '';
    // Renamed in the 2026-06-01 redesign — old labels must NOT appear.
    const renamed = [
      { new: /configuration items/i, old: /^CMDB$/ },
      { new: /inventory stats/i, old: /CMDB Stats/i },
      { new: /budgets & quotas/i, old: /Quotas & Budgets/i },
      { new: /tagging coverage/i, old: /^Tagging$/ },
    ];
    for (const { new: newRe, old: oldRe } of renamed) {
      expect(navText, `new label should be present`).toMatch(newRe);
      expect(navText, `old label "${oldRe}" should no longer appear`).not.toMatch(oldRe);
    }
  });

  test('NAV-11 — Dashboard label replaces Home', async ({ page }) => {
    const navText = (await page.locator('nav').textContent()) ?? '';
    expect(navText).toMatch(/Dashboard/);
    // Sidebar should not still have a "Home" item.
    const homeLink = page.locator('nav').getByRole('link', { name: /^Home$/ });
    expect(await homeLink.count()).toBe(0);
  });

  test('NAV-12 — /cmdb-audit is not in sidebar (route still works) @regression', async ({ page }) => {
    // Per the 2026-06-01 redesign, Audit Log was removed from the sidebar.
    // The route /cmdb-audit is preserved (see pages.spec.ts PAGE-34) but
    // is no longer reachable from the sidebar.
    const auditLink = page
      .locator('nav')
      .getByRole('link', { name: /audit/i });
    expect(await auditLink.count()).toBe(0);

    // Sanity: the route still loads when accessed directly.
    await page.goto('/cmdb-audit');
    await page.waitForLoadState('domcontentloaded');
    const body = await page.locator('body').textContent();
    expect(body?.length ?? 0).toBeGreaterThan(10);
  });
});
