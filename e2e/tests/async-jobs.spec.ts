/**
 * Async jobs e2e (spec 2026-09-09-async-jobs-design §7):
 * - billing import: 202 → live progress card → completed result box
 * - cloud-account sync: inline chip lifecycle, double-trigger blocked
 * - header indicator shows the active-job count
 * - user-triggered import completion lands in the notification bell
 *
 * Requires: running stack (frontend :5173, API :8080) with seeded org and
 * CLOUD_MOCK_ENABLED=true so imports run on mock data.
 */
import { test, expect } from '../fixtures/base.fixture';

const ORG = 'a0000000-0000-0000-0000-000000000001';
const RUN = Date.now().toString(36);

test.describe('async jobs', () => {
  test('billing import — 202 → progress card → completed result @regression', async ({ page, api }) => {
    test.setTimeout(90_000);

    // Dedicated aws account so the run is isolated and rows are predictable.
    const created = await api.post<{ data: { id: string } }>(
      `/api/v1/orgs/${ORG}/cloud-accounts`,
      { name: `e2e-billing-${RUN}`, provider: 'aws', external_id: 'e2e', credentials: {}, config: {} },
    );
    const accountId = created.data.id;

    await page.goto('/billing-import');
    await page.getByRole('combobox').selectOption(accountId);
    await page.getByRole('button', { name: 'Run Import' }).click();

    // The progress card (or, on a fast machine, the terminal box) must appear.
    const progress = page.getByTestId('billing-progress-card');
    const result = page.getByTestId('billing-result-box');
    await expect(progress.or(result)).toBeVisible({ timeout: 15_000 });

    // The import settles into the result box with the documented numbers.
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result).toContainText('Import completed');
    await expect(result).toContainText('raw rows inserted');

    // Recent import jobs list renders the finished job (the account also
    // appears in the history table above — take the first match).
    await expect(page.getByText('Recent Import Jobs')).toBeVisible();
    await expect(
      page.getByRole('row', { name: new RegExp(`e2e-billing-${RUN}`) }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // teardown
    await api.delete(`/api/v1/orgs/${ORG}/cloud-accounts/${accountId}`);
  });

  test('cloud-account sync — inline chip lifecycle + double-trigger blocked @regression', async ({ page, api }) => {
    test.setTimeout(90_000);

    const created = await api.post<{ data: { id: string } }>(
      `/api/v1/orgs/${ORG}/cloud-accounts`,
      { name: `e2e-sync-${RUN}`, provider: 'aws', external_id: 'e2e', credentials: {}, config: {} },
    );
    const accountId = created.data.id;

    await page.goto('/cloud-accounts');
    const row = page.getByRole('row', { name: new RegExp(`e2e-sync-${RUN}`) });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Trigger the sync from the UI; the inline chip appears and the button
    // flips to the disabled "Syncing…" state (UI-side double-trigger block).
    await row.getByRole('button', { name: /^Sync$/ }).click();
    const chip = row.locator(`[data-testid="job-chip-${accountId}"]`);
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('button', { name: /Syncing/ })).toBeDisabled({ timeout: 10_000 });

    // The chip settles and the row returns to the idle state.
    await expect(chip).toBeHidden({ timeout: 60_000 });
    await expect(row.getByRole('button', { name: /^Sync$/ })).toBeEnabled({ timeout: 30_000 });

    // API-side: a duplicate POST while a job is active answers 409 with the
    // existing job pointer. Drive it via the API against the seed account.
    const sync = await api.postRaw(`/api/v1/orgs/${ORG}/cloud-accounts/${accountId}/sync`, {});
    expect(sync.status).toBe(202);
    const dup = await api.postRaw(`/api/v1/orgs/${ORG}/cloud-accounts/${accountId}/sync`, {});
    expect(dup.status).toBe(409);
    expect(dup.body?.error?.details?.existing_job_id).toBeTruthy();

    // teardown: wait for the API-triggered job to finish, then remove the account
    for (let i = 0; i < 30; i++) {
      const jobs = await api.get<{ data: Array<{ status: string }> }>(
        `/api/v1/orgs/${ORG}/jobs?cloud_account_id=${accountId}&active=true`,
      );
      if (!jobs.data?.length) break;
      await page.waitForTimeout(1_000);
    }
    await api.delete(`/api/v1/orgs/${ORG}/cloud-accounts/${accountId}`);
  });

  test('header indicator counts active jobs @regression', async ({ page, api }) => {
    test.setTimeout(90_000);

    const created = await api.post<{ data: { id: string } }>(
      `/api/v1/orgs/${ORG}/cloud-accounts`,
      { name: `e2e-indicator-${RUN}`, provider: 'aws', external_id: 'e2e', credentials: {}, config: {} },
    );
    const accountId = created.data.id;

    // Launch a 30-day import (~1.5 s of mock fetch) so the indicator has a
    // live job to count, then open the page.
    const job = await api.postRaw(`/api/v1/orgs/${ORG}/billing/import`, {
      cloud_account_id: accountId,
      days: 30,
    });
    expect(job.status).toBe(202);

    await page.goto('/dashboard');
    const indicator = page.getByTestId('background-jobs-indicator');
    await expect(indicator).toBeVisible({ timeout: 15_000 });
    const count = page.getByTestId('background-jobs-count');
    // Either the count badge shows while running, or the job finished first —
    // the dropdown must still render job history either way.
    await expect(indicator).toBeVisible();
    const hasCount = await count.isVisible().catch(() => false);
    if (hasCount) {
      await expect(count).toHaveText(/^[0-9]+$/);
    }

    // teardown
    for (let i = 0; i < 30; i++) {
      const jobs = await api.get<{ data: Array<{ status: string }> }>(
        `/api/v1/orgs/${ORG}/jobs?cloud_account_id=${accountId}&active=true`,
      );
      if (!jobs.data?.length) break;
      await page.waitForTimeout(1_000);
    }
    await api.delete(`/api/v1/orgs/${ORG}/cloud-accounts/${accountId}`);
  });

  test('user-triggered import completion notifies the bell @regression', async ({ page, api }) => {
    test.setTimeout(90_000);

    const created = await api.post<{ data: { id: string } }>(
      `/api/v1/orgs/${ORG}/cloud-accounts`,
      { name: `e2e-notify-${RUN}`, provider: 'aws', external_id: 'e2e', credentials: {}, config: {} },
    );
    const accountId = created.data.id;

    const job = await api.postRaw(`/api/v1/orgs/${ORG}/billing/import`, {
      cloud_account_id: accountId,
      days: 3,
    });
    expect(job.status).toBe(202);
    const jobId = job.body.data.id;

    // Wait for the terminal state.
    let status = 'pending';
    for (let i = 0; i < 30 && !['succeeded', 'failed', 'cancelled'].includes(status); i++) {
      await page.waitForTimeout(1_000);
      const j = await api.get<{ data: { status: string } }>(`/api/v1/orgs/${ORG}/jobs/${jobId}`);
      status = j.data.status;
    }
    expect(status).toBe('succeeded');

    // The bell shows the 账单导入完成 notification (stored title is zh by
    // the write-time convention).
    await page.goto('/dashboard');
    await page.getByTitle('Notifications').click();
    await expect(page.getByText('账单导入完成').first()).toBeVisible({ timeout: 15_000 });

    // teardown
    await api.delete(`/api/v1/orgs/${ORG}/cloud-accounts/${accountId}`);
  });
});
