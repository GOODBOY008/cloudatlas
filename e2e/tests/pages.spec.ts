/**
 * Suite 3: Page Rendering — All 34 routes (PAGE-01 → PAGE-34)
 * Verifies each route loads without console errors.
 * Known broken routes are tagged and expected to fail gracefully.
 *
 * Note: all 34 routes remain reachable via direct URL. The 2026-06-01 sidebar
 * redesign only removed `/cmdb-audit` from the sidebar nav (PAGE-34) — the
 * route is still served. See navigation.spec.ts NAV-12 for the sidebar check.
 */
import { test, expect } from '../fixtures/base.fixture';

/** Routes that are known to have backend errors and are excluded from strict checks */
const KNOWN_UNSTABLE = new Set(['/compliance', '/cmdb-stats']);

const ROUTES: Array<{ id: string; path: string }> = [
  { id: 'PAGE-01', path: '/dashboard' },
  { id: 'PAGE-02', path: '/expenses' },
  { id: 'PAGE-03', path: '/showback' },
  { id: 'PAGE-04', path: '/tagging-coverage' },
  { id: 'PAGE-05', path: '/cost-map' },
  { id: 'PAGE-06', path: '/pools' },
  { id: 'PAGE-07', path: '/cmdb' },
  { id: 'PAGE-08', path: '/recommendations' },
  { id: 'PAGE-09', path: '/recommendations/archived' },
  { id: 'PAGE-10', path: '/cloud-accounts' },
  { id: 'PAGE-11', path: '/settings' },
  { id: 'PAGE-12', path: '/rules' },
  { id: 'PAGE-13', path: '/schedules' },
  { id: 'PAGE-14', path: '/alerts' },
  { id: 'PAGE-15', path: '/cost-centers' },
  { id: 'PAGE-16', path: '/services' },
  { id: 'PAGE-17', path: '/dynamic-groups' },
  { id: 'PAGE-18', path: '/compliance' },
  { id: 'PAGE-19', path: '/resources' },
  { id: 'PAGE-20', path: '/anomaly-detection' },
  { id: 'PAGE-21', path: '/quotas-budgets' },
  { id: 'PAGE-22', path: '/cost-comparison' },
  { id: 'PAGE-23', path: '/archive' },
  { id: 'PAGE-24', path: '/shared-environments' },
  { id: 'PAGE-25', path: '/resource-lifecycle' },
  { id: 'PAGE-26', path: '/k8s-rightsizing' },
  { id: 'PAGE-27', path: '/ci-classifications' },
  { id: 'PAGE-28', path: '/association-kinds' },
  { id: 'PAGE-29', path: '/model-topology' },
  { id: 'PAGE-30', path: '/cmdb-stats' },
  { id: 'PAGE-31', path: '/service-templates' },
  { id: 'PAGE-32', path: '/ci-import' },
  { id: 'PAGE-33', path: '/ci-apply-rules' },
  { id: 'PAGE-34', path: '/cmdb-audit' },
];

test.describe('Page Rendering — 34 Routes @regression', () => {
  for (const { id, path } of ROUTES) {
    test(`${id} — ${path} renders without crashing`, async ({ page }) => {
      if (KNOWN_UNSTABLE.has(path)) {
        // Still navigate — just don't fail on backend errors
        await page.goto(path);
        await page.waitForLoadState('domcontentloaded');
        // Page should not be blank
        const body = await page.locator('body').textContent();
        expect(body?.length ?? 0).toBeGreaterThan(10);
        return;
      }

      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const text = msg.text();
          // Filter out known non-actionable noise
          if (
            !text.includes('tailwindcss') &&
            !text.includes('React Router Future Flag') &&
            !text.includes('DevTools')
          ) {
            errors.push(text);
          }
        }
      });

      await page.goto(path);
      await page.waitForLoadState('networkidle');

      // Main content area should have meaningful content
      const mainText = await page.locator('main, #root, body').first().textContent();
      expect(mainText?.length ?? 0).toBeGreaterThan(50);

      // No unexpected console errors
      expect(errors, `Console errors on ${path}: ${errors.join(', ')}`).toHaveLength(0);
    });
  }
});

/**
 * Smoke: only critical routes
 */
test.describe('Page Rendering — smoke routes @smoke', () => {
  const SMOKE_ROUTES = ['/dashboard', '/pools', '/cmdb', '/expenses', '/recommendations'];

  for (const path of SMOKE_ROUTES) {
    test(`${path} loads with content`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const main = page.locator('main');
      await expect(main).toBeVisible();
      const text = await main.textContent();
      expect(text?.length ?? 0).toBeGreaterThan(30);
    });
  }
});
