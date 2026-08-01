/**
 * Pagination e2e (spec 2026-09-10-list-pagination-design §7):
 * - Resources: navigate pages, per-page selector, filter resets to page 1
 * - Audit log: pager actually renders (regression for the dead `data.total`
 *   bug — the page used to read a top-level total the API never sent)
 * - CMDB CI list: page through a seeded set
 * - Recommendations: paged via paginatedGet (no more silent limit:200)
 *
 * Deterministic seeding: 5 mock accounts × 7 resources each via sync, plus
 * 30 directly-created CIs (their create events also feed the audit log).
 * Requires: running stack (frontend :5173, API :8080) with the seed org.
 */
import { test, expect } from '../fixtures/base.fixture';
import type { ApiClient } from '../helpers/api';

const ORG = 'a0000000-0000-0000-0000-000000000001';
const RUN = Date.now().toString(36);

const state: { accounts: string[]; ciIds: string[]; ciPrefix: string; seeded: boolean } = {
  accounts: [],
  ciIds: [],
  ciPrefix: `e2e-pg-${RUN}`,
  seeded: false,
};

async function waitForIdleJobs(api: ApiClient, accountId: string) {
  for (let i = 0; i < 40; i++) {
    const jobs = await api.get<{ data: unknown[] }>(
      `/api/v1/orgs/${ORG}/jobs?cloud_account_id=${accountId}&active=true`,
    );
    if (!jobs.data?.length) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function seed(api: ApiClient) {
  if (state.seeded) return;

  // 5 mock accounts → each sync upserts its own 7 resources (≥2 pages @20).
  for (let i = 0; i < 5; i++) {
    const created = await api.post<{ data: { id: string } }>(`/api/v1/orgs/${ORG}/cloud-accounts`, {
      name: `e2e-pg-${RUN}-${i}`,
      provider: 'mock',
      credentials: {},
      config: {},
    });
    const accountId = created.data.id;
    state.accounts.push(accountId);
    const sync = await api.postRaw(`/api/v1/orgs/${ORG}/cloud-accounts/${accountId}/sync`, {});
    expect(sync.status).toBe(202);
    await waitForIdleJobs(api, accountId);
  }

  // 30 CIs → ≥2 pages @20 in the CI list, plus 30 create events in the audit log.
  for (let i = 0; i < 30; i++) {
    const ci = await api.post<{ data: { id: string } }>(`/api/v1/orgs/${ORG}/cis`, {
      name: `${state.ciPrefix}-${String(i).padStart(2, '0')}`,
      cloud_provider: 'aws',
      ci_type_id: '20000000-0000-0000-0000-000000000001',
    });
    state.ciIds.push(ci.data.id);
  }

  state.seeded = true;
}

async function teardown(api: ApiClient) {
  for (const id of state.ciIds) await api.delete(`/api/v1/orgs/${ORG}/cis/${id}`);
  for (const id of state.accounts) await api.delete(`/api/v1/orgs/${ORG}/cloud-accounts/${id}`);
}

test.describe.serial('pagination (spec 2026-09-10)', () => {
  test('Resources — per-page selector, page navigation, filter resets to page 1', async ({ page, api }) => {
    test.setTimeout(180_000);
    await seed(api);

    await page.goto('/resources');
    await page.getByTestId('per-page-select').selectOption('20');
    await expect(page.getByText(/Showing 1–20 of/)).toBeVisible({ timeout: 15_000 });

    // First row of page 1 (for the rows-actually-changed assertion).
    const firstRowPage1 = page.locator('tbody tr').first().locator('td').first();
    const namePage1 = await firstRowPage1.textContent();

    // Navigate to page 2 — the showing-range flips and the rows change.
    await page.getByTestId('page-2').click();
    await expect(page.getByText(/Showing 21–/)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => firstRowPage1.textContent(), { timeout: 15_000 })
      .not.toBe(namePage1);

    // A filter change must return to page 1.
    await page.getByPlaceholder('Search by name or resource ID…').fill('web-server');
    await expect(page.getByText(/Showing 1–/)).toBeVisible({ timeout: 15_000 });
  });

  test('CMDB CI list — page through the seeded set', async ({ page, api }) => {
    await seed(api);

    await page.goto('/cmdb');
    await expect(page.getByTestId('per-page-select')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('per-page-select').selectOption('20');

    // Seed prefix narrows the list to the 30 created CIs → 2 pages.
    await page.getByPlaceholder(/Search .*name|Search by name/i).fill(state.ciPrefix);
    await expect(page.getByText(/Showing 1–20 of 30/)).toBeVisible({ timeout: 15_000 });

    const firstCell = page.locator('tbody tr').first().locator('td').nth(1);
    const page1Name = await firstCell.textContent();
    expect(page1Name).toContain(`${state.ciPrefix}-`);

    await page.getByTestId('page-2').click();
    await expect(page.getByText(/Showing 21–30 of 30/)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => firstCell.textContent(), { timeout: 15_000 })
      .not.toBe(page1Name);
  });

  test('CMDB audit log — pager renders from meta.total (dead-total regression)', async ({ page, api }) => {
    await seed(api);

    await page.goto('/cmdb-audit');
    await page.getByTestId('per-page-select').selectOption('20');

    // 30+ CI create events guarantee > 1 page; the shared bar (not the old
    // never-rendering prev/next) must appear with a real total.
    await expect(page.getByTestId('page-2')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Showing 1–20 of/)).toBeVisible();

    await page.getByTestId('page-2').click();
    await expect(page.getByText(/Showing 21–40 of/)).toBeVisible({ timeout: 15_000 });
  });

  test('Recommendations — paged via paginatedGet with real meta', async ({ page, api }) => {
    await seed(api);

    // The API decides how many pages are exercisable.
    const res = await api.get<{ data: unknown[]; meta: { total: number; total_pages: number } }>(
      `/api/v1/orgs/${ORG}/recommendations?page=1&per_page=20`,
    );
    expect(res.meta.total_pages).toBe(Math.ceil(res.meta.total / 20));

    await page.goto('/recommendations');
    await expect(page.getByText(/Showing 1–\d+ of \d+/)).toBeVisible({ timeout: 15_000 });
    if (res.meta.total_pages > 1) {
      await page.getByTestId('page-2').click();
      await expect(page.getByText(/Showing 21–/)).toBeVisible({ timeout: 15_000 });
    }
  });

  test('teardown — remove seeded accounts and CIs', async ({ api }) => {
    await teardown(api);
  });
});
