/**
 * Defect-regression suite — guards the fixes from the 2026-08-15 guided e2e
 * (defect register D-1..D-11 in docs/e2e-guided-test-report-2026-08-15.md).
 * Every test maps to a defect ID so a failure points at the exact regression.
 *
 * Requires: running stack (frontend :5173, API :8080) with seeded org.
 */
import { test, expect } from '../fixtures/base.fixture';

const ORG = 'a0000000-0000-0000-0000-000000000001';
// Unique suffix per run — keeps re-runs from hitting unique-name conflicts
// when a previous teardown was skipped by a failure.
const RUN = Date.now().toString(36);
const SEED_ACCOUNT = 'd0000000-0000-0000-0000-000000000001';

// ─── D-1: adding a cloud account from the UI succeeds ────────────────────────

test.describe('defect regression', () => {
  test('D-1 — add cloud account from UI @regression', async ({ page, cloudAccountsPage, api }) => {
    test.setTimeout(60_000);
    await cloudAccountsPage.goto('/cloud-accounts');
    await page.getByRole('button', { name: '+ Add Account' }).click();
    await page.getByPlaceholder('My AWS Account').fill(`e2e-d1-account-${RUN}`);
    // Real providers now require credential fields (spec 2026-08-17); the
    // minimal no-secret payload path is the "Other" demo provider.
    await page.getByLabel(/provider/i).selectOption('other');
    await page.getByRole('button', { name: '+ Add Account' }).click(); // submit

    await expect(page.getByRole('row', { name: new RegExp(`e2e-d1-account-${RUN}`) })).toBeVisible({ timeout: 10_000 });

    // teardown
    const accounts = await api.get<{ data: Array<{ id: string; name: string }> }>(
      `/api/v1/orgs/${ORG}/cloud-accounts`,
    );
    const created = accounts.data.find((a) => a.name === `e2e-d1-account-${RUN}`);
    if (created) await api.delete(`/api/v1/orgs/${ORG}/cloud-accounts/${created.id}`);
  });

  // ─── D-3: sync populates the FinOps resources table ────────────────────────

  test('D-3 — sync populates resources page @regression', async ({ page, api }) => {
    test.setTimeout(90_000);
    // Trigger a sync on the seed account and wait for resources to appear.
    await api.post(`/api/v1/orgs/${ORG}/cloud-accounts/${SEED_ACCOUNT}/sync`, {});
    let total = 0;
    for (let i = 0; i < 20 && total === 0; i++) {
      await page.waitForTimeout(2_000);
      const res = await api.get<{ meta: { total: number } }>(`/api/v1/orgs/${ORG}/resources`);
      total = res.meta?.total ?? 0;
    }
    expect(total).toBeGreaterThan(0);

    await page.goto('/resources');
    await expect(page.getByRole('row').nth(1)).toBeVisible({ timeout: 10_000 });
  });

  // ─── D-4: create-form renders the selected type's attributes ───────────────

  test('D-4 — CI form collects type attributes into meta @regression', async ({ page, cmdbPage, api }) => {
    test.setTimeout(60_000);
    // Seed a custom type with one required attribute via API.
    const cls = await api.post<{ data: { id: string } }>(`/api/v1/orgs/${ORG}/ci-classifications`, {
      name: `e2e_d4_cls_${RUN}`, display_name: `E2E D4 Class ${RUN}`, icon: '🧪',
    });
    const type = await api.post<{ data: { id: string } }>(`/api/v1/orgs/${ORG}/ci-types`, {
      name: `e2e_d4_type_${RUN}`, display_name: `E2E D4 Type ${RUN}`, classification_id: cls.data.id,
    });
    const typeId = type.data.id;
    let ciId: string | undefined;

    try {
      await api.post(`/api/v1/orgs/${ORG}/ci-types/${typeId}/attributes`, {
        name: 'app_version', display_name: 'App Version', attribute_type: 'string', is_required: true,
      });

      await cmdbPage.goto('/cmdb');
      await page.getByRole('button', { name: '+ New CI' }).click();
      await page.getByPlaceholder('i-1234567890').fill(`e2e-d4-ci-${RUN}`);
      const typeSelect = page.locator('select').filter({ hasText: 'Select type' });
      await typeSelect.selectOption({ label: `E2E D4 Type ${RUN}` });

      // D-4: the attribute input appears once the type is chosen.
      const attrInput = page.getByPlaceholder('app_version');
      await expect(attrInput).toBeVisible({ timeout: 10_000 });
      await attrInput.fill('v9.9.9');
      await page.getByRole('button', { name: 'Create CI' }).click();

      const row = page.getByRole('row', { name: new RegExp(`e2e-d4-ci-${RUN}`) });
      await expect(row).toBeVisible({ timeout: 10_000 });

      // Attribute value must land in meta. (limit=200: the CI list paginates,
      // and the full list is how the created CI is located.)
      const cis = await api.get<{ data: Array<{ id: string; name: string; meta: Record<string, string> }> }>(
        `/api/v1/orgs/${ORG}/cis?limit=200`,
      );
      const created = cis.data.find((c) => c.name === `e2e-d4-ci-${RUN}`);
      expect(created?.meta?.app_version).toBe('v9.9.9');
      ciId = created?.id;
    } finally {
      // Cleanup must never mask the real failure — degrade to warnings.
      try {
        if (ciId) await api.delete(`/api/v1/orgs/${ORG}/cis/${ciId}`);
        await api.delete(`/api/v1/orgs/${ORG}/ci-types/${typeId}`);
        await api.delete(`/api/v1/orgs/${ORG}/ci-classifications/${cls.data.id}`);
      } catch (e) {
        console.warn('D-4 teardown incomplete:', e);
      }
    }
  });

  // ─── D-5: CI drawer history renders actions + relative time (no NaN) ───────

  test('D-5 — CI history shows action text, never NaN @regression', async ({ page, api }) => {
    test.setTimeout(60_000);
    // Create a CI so a deterministic 'create' audit entry exists.
    const ci = await api.post<{ data: { id: string } }>(`/api/v1/orgs/${ORG}/cis`, {
      name: `e2e-d5-ci-${RUN}`, display_name: `E2E D5 CI ${RUN}`, cloud_provider: 'aws',
      ci_type_id: '20000000-0000-0000-0000-000000000001',
    });
    try {
      await page.goto('/cmdb');
      const row = page.getByRole('row', { name: new RegExp(`e2e-d5-ci-${RUN}`) });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.click();

      const historySection = page.locator('section').filter({ hasText: 'Recent History' }).first();
      await expect(historySection).toBeVisible({ timeout: 10_000 });
      await expect(historySection.getByText('NaN')).toHaveCount(0);
      await expect(historySection).toContainText(/create/i, { timeout: 10_000 });
    } finally {
      await api.delete(`/api/v1/orgs/${ORG}/cis/${ci.data.id}`);
    }
  });

  // ─── D-6: association kind dropdown offers the type's templates ────────────

  test('D-6 — association kind dropdown is populated @regression', async ({ page, cmdbPage, api }) => {
    test.setTimeout(60_000);
    // Create our own cloud_instance CI so its row is always on page 1
    // (a seeded web-server-01 can drift onto later pages as tests add CIs).
    const ci = await api.post<{ data: { id: string } }>(`/api/v1/orgs/${ORG}/cis`, {
      name: `e2e-d6-ci-${RUN}`, display_name: `E2E D6 CI ${RUN}`, cloud_provider: 'aws',
      ci_type_id: '20000000-0000-0000-0000-000000000001',
    });
    try {
      await cmdbPage.goto('/cmdb');
      const row = page.getByRole('row', { name: new RegExp(`e2e-d6-ci-${RUN}`) });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.click();
      await page.getByRole('button', { name: '+ Link CI' }).click();

      const kindSelect = page.locator('select').filter({ hasText: 'Select association type' });
      await expect(kindSelect).toBeVisible({ timeout: 10_000 });
      // Options arrive async (object-association query enables on open) —
      // poll until the seeded cloud_instance templates land.
      await expect
        .poll(async () => kindSelect.locator('option').count(), { timeout: 10_000 })
        .toBeGreaterThan(1);
    } finally {
      await api.delete(`/api/v1/orgs/${ORG}/cis/${ci.data.id}`);
    }
  });

  // ─── D-8: lifecycle transition applies from the row dropdown ───────────────

  test('D-8 — lifecycle change to Stopped applies @regression', async ({ page, api }) => {
    test.setTimeout(60_000);
    const ci = await api.post<{ data: { id: string } }>(`/api/v1/orgs/${ORG}/cis`, {
      name: `e2e-d8-ci-${RUN}`, display_name: `E2E D8 CI ${RUN}`, cloud_provider: 'aws',
      ci_type_id: '20000000-0000-0000-0000-000000000001',
    });
    const ciId = ci.data.id;

    try {
      await page.goto('/cmdb');
      const row = page.getByRole('row', { name: new RegExp(`e2e-d8-ci-${RUN}`) });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.getByRole('combobox').selectOption({ label: 'Stopped' });

      await expect(row).toContainText('Stopped', { timeout: 10_000 });
      await expect(page.getByText('Failed to update lifecycle state')).toHaveCount(0);
    } finally {
      await api.delete(`/api/v1/orgs/${ORG}/cis/${ciId}`);
    }
  });

  // ─── D-9: budget alert creation from the UI succeeds ───────────────────────

  test('D-9 — create budget alert on Root Pool @regression', async ({ page, api }) => {
    test.setTimeout(60_000);
    await page.goto('/alerts');
    await page.getByRole('button', { name: '+ New Alert' }).click();
    // selectOption({label}) needs an exact string; resolve the Root Pool
    // option's value first (its label embeds the live budget amount).
    const poolCombo = page.getByRole('combobox');
    const rootOption = poolCombo.locator('option', { hasText: 'Root Pool' }).first();
    await expect(rootOption).toBeAttached({ timeout: 10_000 });
    const rootValue = await rootOption.getAttribute('value');
    await poolCombo.selectOption({ value: rootValue! });
    await page.getByPlaceholder(/Warn team lead/i).fill(`e2e-d9 alert ${RUN}`);
    await page.getByRole('button', { name: 'Create Alert' }).click();

    await expect(page.getByText(/80%/).first()).toBeVisible({ timeout: 10_000 });

    // teardown: delete the alert we just created (latest for the org).
    const alerts = await api.get<{ data: Array<{ id: string }> }>(`/api/v1/orgs/${ORG}/alerts`);
    const last = alerts.data[0];
    if (last) await api.delete(`/api/v1/orgs/${ORG}/alerts/${last.id}`);
  });

  // ─── D-10: CI can be deleted from the drawer ───────────────────────────────

  test('D-10 — delete CI from drawer @regression', async ({ page, api }) => {
    test.setTimeout(60_000);
    const ci = await api.post<{ data: { id: string } }>(`/api/v1/orgs/${ORG}/cis`, {
      name: `e2e-d10-ci-${RUN}`, display_name: 'E2E D10 CI', cloud_provider: 'aws',
      ci_type_id: '20000000-0000-0000-0000-000000000001',
    });

    await page.goto('/cmdb');
    const row = page.getByRole('row', { name: new RegExp(`e2e-d10-ci-${RUN}`) });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete CI' }).click();

    await expect(page.getByRole('row', { name: new RegExp(`e2e-d10-ci-${RUN}`) })).toHaveCount(0, { timeout: 10_000 });
  });
});
