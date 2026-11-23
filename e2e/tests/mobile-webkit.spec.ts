import { expect, test } from '@playwright/test';

test('sign in, find a page in Chinese, and close Copilot on iPhone WebKit @smoke', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(process.env.E2E_ADMIN_EMAIL ?? 'admin@acme.com');
  await page.getByLabel('Password', { exact: true }).fill(process.env.E2E_ADMIN_PASS ?? 'Password123!');
  await page.getByRole('button', { name: 'Sign In', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();

  await page.getByRole('button', { name: 'Search', exact: true }).tap();
  const search = page.getByRole('dialog', { name: 'Search' });
  await search.getByRole('combobox', { name: 'Search' }).fill('审计');
  await search.getByRole('option', { name: /CMDB Audit Log/ }).tap();
  await expect(page).toHaveURL(/\/cmdb-audit$/);
  await expect(page.getByRole('heading', { name: 'CMDB Audit Log', exact: true })).toBeVisible();

  const launcher = page.getByRole('button', { name: 'Open Copilot' });
  await launcher.tap();
  const dialog = page.getByRole('dialog', { name: 'Copilot' });
  await expect(page.locator('dialog:modal')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Minimize Copilot', exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();

  await page.getByRole('button', { name: 'Switch language (EN / 中文)', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'CMDB 审计日志', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'CMDB 审计日志', exact: true })).toBeVisible();
});
