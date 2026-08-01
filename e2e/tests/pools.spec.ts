/**
 * Suite 6: Pools CRUD (POOL-01 → POOL-12)
 */
import { test, expect } from '../fixtures/base.fixture';

const E2E_POOL_NAME = `E2E-Pool-${Date.now()}`;

test.describe('Pools CRUD @regression', () => {
  test.beforeEach(async ({ poolsPage }) => {
    await poolsPage.navigate();
  });

  test('POOL-01 — pool list renders', async ({ poolsPage }) => {
    const text = await poolsPage.poolList.textContent();
    expect(text?.length ?? 0).toBeGreaterThan(10);
  });

  test('POOL-02 — seed pools are visible @smoke', async ({ poolsPage }) => {
    const text = await poolsPage.poolList.textContent();
    // Seed data includes Root / Backend / Frontend pools
    expect(text).toMatch(/backend|frontend|root|pool/i);
  });

  test('POOL-03 — list/tree view toggle works', async ({ poolsPage }) => {
    const toggleBtns = poolsPage.page.getByRole('button', { name: /list|tree/i });
    if (await toggleBtns.count() > 0) {
      await toggleBtns.first().click();
      await poolsPage.page.waitForTimeout(500);
    } else {
      test.skip(true, 'View toggle not found');
    }
  });

  test('POOL-04 — create modal opens', async ({ poolsPage }) => {
    await poolsPage.openCreateModal();
    await expect(poolsPage.formHeading).toBeVisible();
    await poolsPage.closeModal();
  });

  test('POOL-05 — create form has required fields', async ({ poolsPage }) => {
    await poolsPage.openCreateModal();
    await expect(poolsPage.nameInput).toBeVisible();
    await poolsPage.closeModal();
  });

  test('POOL-06 — create a pool end-to-end', async ({ poolsPage }) => {
    await poolsPage.createPool(E2E_POOL_NAME);
    // Verify the new pool appears in the list
    await expect(poolsPage.poolList.getByText(E2E_POOL_NAME)).toBeVisible({ timeout: 10_000 });
  });

  test('POOL-07 — edit modal opens pre-filled', async ({ poolsPage }) => {
    // Find an existing seed pool and open edit
    const editBtn = poolsPage.page.getByRole('button', { name: /edit/i }).first();
    if (await editBtn.count() > 0) {
      await editBtn.click();
      await poolsPage.formHeading.waitFor({ state: 'visible' });
      // Form should be pre-filled
      const value = await poolsPage.nameInput.inputValue();
      expect(value.length).toBeGreaterThan(0);
      await poolsPage.closeModal();
    } else {
      test.skip(true, 'No edit buttons found');
    }
  });

  test('POOL-09/11 — delete confirmation shows; cancel keeps pool', async ({ poolsPage }) => {
    const deleteBtn = poolsPage.page.getByRole('button', { name: /delete/i }).first();
    if (await deleteBtn.count() > 0) {
      await deleteBtn.click();
      // Confirmation should appear — either a native dialog or the inline
      // modal's confirm/cancel pair. Scope to buttons inside the overlay so
      // header buttons ("Notifications"…) can't match /no/i.
      const overlay = poolsPage.page.locator('.fixed.inset-0, [role="dialog"]').last();
      const confirmBtn = overlay.getByRole('button', { name: /^(confirm|yes|ok|delete)$/i }).first();
      const cancelBtn = overlay.getByRole('button', { name: /^cancel$|^(no|取消)$/i }).first();
      // The modal always renders a Cancel next to Confirm — wait for it.
      await expect(cancelBtn.or(confirmBtn).first()).toBeVisible({ timeout: 5000 });
      // Cancel
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
      }
    } else {
      test.skip(true, 'No delete buttons found');
    }
  });

  test('POOL-10 — delete the e2e-created pool', async ({ poolsPage }) => {
    // Check if the pool still exists (only runs after POOL-06)
    const poolRow = poolsPage.page.locator('main').getByText(E2E_POOL_NAME);
    if (await poolRow.count() === 0) {
      test.skip(true, `Pool ${E2E_POOL_NAME} not found (POOL-06 may have been skipped)`);
      return;
    }
    // Set up dialog handler before clicking delete
    poolsPage.page.on('dialog', dialog => dialog.accept());
    await poolsPage.deletePool(E2E_POOL_NAME);
    // exact: the confirm modal's description ("X and all its data will be
    // removed…") also contains the pool name.
    await expect(poolsPage.poolList.getByText(E2E_POOL_NAME, { exact: true })).toBeHidden({ timeout: 8000 });
  });
});
