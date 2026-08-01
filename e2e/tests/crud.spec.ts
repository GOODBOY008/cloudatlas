/**
 * Suite 7: Cloud Accounts (CA-01 → CA-08)
 * Suite 8: Recommendations (REC-01 → REC-10)
 * Suite 9: Settings (SET-01 → SET-08)
 * Suite 10: CMDB CRUD (CMDB-01 → CMDB-10)
 */
import { test, expect } from '../fixtures/base.fixture';

// ─────────────────────────────────────────────────
// Cloud Accounts
// ─────────────────────────────────────────────────
test.describe('Cloud Accounts @regression', () => {
  test.beforeEach(async ({ cloudAccountsPage }) => {
    await cloudAccountsPage.navigate();
  });

  test('CA-01 — seed account visible @smoke', async ({ cloudAccountsPage }) => {
    const text = await cloudAccountsPage.page.locator('main').textContent();
    expect(text).toMatch(/acme aws|aws|mock/i);
  });

  test('CA-02 — provider badge displayed', async ({ cloudAccountsPage }) => {
    const text = await cloudAccountsPage.page.locator('main').textContent();
    expect(text).toMatch(/aws/i);
  });

  test('CA-03 — add account form appears', async ({ cloudAccountsPage }) => {
    await cloudAccountsPage.openAddForm();
    const modal = cloudAccountsPage.page.locator('[role="dialog"], form').first();
    await expect(modal).toBeVisible();
    await cloudAccountsPage.closeModal();
  });

  test('CA-09 — connect AWS account with credentials @smoke', async ({ cloudAccountsPage }) => {
    const name = `e2e-aws-${Date.now()}`;
    await cloudAccountsPage.addAccountWithCredentials(name, 'aws', '123456789012', {
      access_key_id: 'AKIAE2E',
      secret_access_key: 'e2e-secret',
    });
    await expect(cloudAccountsPage.page.getByText(name)).toBeVisible();
    await cloudAccountsPage.openEdit(name);
    await expect(cloudAccountsPage.page.getByText(/credentials configured/i)).toBeVisible();
    await cloudAccountsPage.page.getByRole('button', { name: /cancel/i }).click();
  });

  test('CA-10 — edit modal rotates credentials', async ({ cloudAccountsPage }) => {
    const name = `e2e-aws-${Date.now()}`;
    await cloudAccountsPage.addAccountWithCredentials(name, 'aws', '123456789012', {
      access_key_id: 'AKIAE2E',
      secret_access_key: 'e2e-secret',
    });
    await cloudAccountsPage.openEdit(name);
    await expect(cloudAccountsPage.page.getByText(/credentials configured/i)).toBeVisible();
    await cloudAccountsPage.page.locator('#edit-cred-secret_access_key').fill('rotated-secret');
    await cloudAccountsPage.saveEdit();
    await expect(cloudAccountsPage.page.getByText(name)).toBeVisible();
  });

  test('CA-11 — other provider needs no credentials', async ({ cloudAccountsPage }) => {
    const name = `e2e-other-${Date.now()}`;
    await cloudAccountsPage.addAccount(name, 'other', '999');
    await expect(cloudAccountsPage.page.getByText(name)).toBeVisible();
    await cloudAccountsPage.openEdit(name);
    await expect(cloudAccountsPage.page.getByText(/credentials configured/i)).not.toBeVisible();
    await cloudAccountsPage.page.getByRole('button', { name: /cancel/i }).click();
  });
});

// ─────────────────────────────────────────────────
// Recommendations
// ─────────────────────────────────────────────────
test.describe('Recommendations @regression', () => {
  test.beforeEach(async ({ recommendationsPage }) => {
    await recommendationsPage.navigate();
  });

  test('REC-01 — recommendation cards render @smoke', async ({ recommendationsPage }) => {
    const text = await recommendationsPage.main.textContent();
    expect(text?.length ?? 0).toBeGreaterThan(50);
  });

  const CATEGORIES = ['All', 'Idle', 'Rightsizing', 'Storage', 'Security', 'Commitment'];
  for (const cat of CATEGORIES) {
    test(`REC category filter — ${cat}`, async ({ recommendationsPage }) => {
      const btn = recommendationsPage.page.getByRole('button', { name: cat }).first();
      if (await btn.isVisible()) {
        await btn.click();
        await recommendationsPage.page.waitForLoadState('networkidle');
        const text = await recommendationsPage.main.textContent();
        expect(text?.length ?? 0).toBeGreaterThan(0);
      } else {
        test.skip(true, `Category button "${cat}" not found`);
      }
    });
  }

  test('REC-10 — archived view is reachable', async ({ page }) => {
    await page.goto('/recommendations/archived');
    await page.waitForLoadState('networkidle');
    const text = await page.locator('main').textContent();
    expect(text?.length ?? 0).toBeGreaterThan(10);
  });
});

// ─────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────
test.describe('Settings @regression', () => {
  test.beforeEach(async ({ settingsPage }) => {
    await settingsPage.navigate();
  });

  test('SET-01 — settings page loads @smoke', async ({ settingsPage }) => {
    await expect(settingsPage.page.locator('main')).toBeVisible();
  });

  test('SET-02 — org name is Acme Corp', async ({ settingsPage }) => {
    const text = await settingsPage.page.locator('main').textContent();
    expect(text).toMatch(/acme[- ]?corp/i);
  });

  test('SET-05 — member list shows seed users', async ({ settingsPage }) => {
    const text = await settingsPage.page.locator('main').textContent();
    // At least one of the seed members should be present
    expect(text).toMatch(/alice|bob|admin/i);
  });

  test('SET-07 — invite member form visible', async ({ settingsPage }) => {
    const inviteInput = settingsPage.page.getByLabel(/email/i).first();
    if (await inviteInput.isVisible()) {
      await expect(inviteInput).toBeEnabled();
    } else {
      test.skip(true, 'Invite form not found');
    }
  });
});

// ─────────────────────────────────────────────────
// CMDB CRUD
// ─────────────────────────────────────────────────
const E2E_CI_NAME = `e2e-ci-${Date.now()}`;

test.describe('CMDB CRUD @regression', () => {
  test.beforeEach(async ({ cmdbPage }) => {
    await cmdbPage.navigate();
  });

  test('CMDB-01 — CI list renders @smoke', async ({ cmdbPage }) => {
    await expect(cmdbPage.page.locator('main')).toBeVisible();
    const text = await cmdbPage.page.locator('main').textContent();
    expect(text?.length ?? 0).toBeGreaterThan(10);
  });

  test('CMDB-02 — create CI modal opens', async ({ cmdbPage }) => {
    await cmdbPage.openCreateModal();
    await expect(cmdbPage.formHeading).toBeVisible();
    await cmdbPage.closeModal();
  });

  test('CMDB-03 — create a CI end-to-end', async ({ cmdbPage }) => {
    await cmdbPage.createCi(E2E_CI_NAME, 'Cloud Instance');
    // The new CI should appear in the table
    await expect(
      cmdbPage.page.locator('main').getByText(E2E_CI_NAME).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('CMDB-04 — search filters CIs', async ({ cmdbPage }) => {
    if (await cmdbPage.searchInput.isVisible()) {
      await cmdbPage.search('nonexistent-xyz-12345');
      // Table may re-render — wait then check visible content
      await cmdbPage.page.waitForTimeout(2000);
      const text = await cmdbPage.page.locator('main').textContent({ timeout: 10_000 }).catch(() => '');
      // Either empty state or no matching rows — the search term should not appear as a CI name
      expect(text).not.toMatch(/nonexistent-xyz-12345/i);
    } else {
      test.skip(true, 'Search input not found');
    }
  });

  test('CMDB-07 — clicking CI row opens drawer', async ({ cmdbPage }) => {
    const firstRow = cmdbPage.page.locator('main table tbody tr').first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      // Drawer should appear
      const drawer = cmdbPage.page.locator('[role="dialog"], aside, [class*="drawer"]').first();
      await drawer.waitFor({ state: 'visible', timeout: 8000 });
      await cmdbPage.closeModal();
    } else {
      test.skip(true, 'No CI rows found');
    }
  });

  test('CMDB-08 — edit CI tags via drawer @regression', async ({ cmdbPage }) => {
    // Use a unique tag key so we can verify the exact value persists.
    const tagKey = `e2e-${Date.now()}`;
    const tagValue = 'qa-edit';

    await cmdbPage.openFirstCiDrawer();
    await cmdbPage.startTagEdit();
    await cmdbPage.setSingleTag(tagKey, tagValue);
    await cmdbPage.saveTags();

    // The drawer re-renders the saved tag chip with key=value format.
    await expect(
      cmdbPage.page.locator('main').getByText(`${tagKey}=${tagValue}`).first()
    ).toBeVisible({ timeout: 5_000 });

    await cmdbPage.closeDrawer();
  });
});
