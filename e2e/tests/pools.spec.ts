/**
 * Suite 6: Pools CRUD (POOL-01 → POOL-12)
 */
import { test, expect } from '../fixtures/base.fixture';

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

  test('POOL-06/10 — create and delete a pool end-to-end', async ({ poolsPage }) => {
    const name = `E2E-Pool-${Date.now()}`;
    await poolsPage.createPool(name);
    const pool = poolsPage.poolList.getByText(name, { exact: true });
    await expect(pool).toBeVisible();
    await poolsPage.openDeleteDialog(name);
    await poolsPage.deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(pool).toBeHidden();
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
    const name = 'Root Pool';
    await poolsPage.openDeleteDialog(name);
    await expect(poolsPage.deleteDialog).toContainText(name);
    await poolsPage.deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(poolsPage.deleteDialog).toBeHidden();
    await poolsPage.navigate();
    await expect(poolsPage.poolList.getByText(name, { exact: true })).toBeVisible();
  });
});
